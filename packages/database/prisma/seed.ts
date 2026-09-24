import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildRefundSaleFields } from '../src/refund.js';

const prisma = new PrismaClient();

function toCents(decimalString: string): bigint {
  return BigInt(Math.round(Number(decimalString) * 100));
}

function toBps(fractionString: string): number {
  return Math.round(Number(fractionString) * 10_000);
}

type MockRecord = {
  recordType: 'sale' | 'refund' | 'exchange';
  sourceRecordId: string;
  sourceTransactionId: string;
  parentTransactionId?: string;
  artistId: string;
  artistName: string;
  venueId: string;
  venueName: string;
  productId: string;
  sku: string;
  productName: string;
  occurredAt: string;
  quantity: number;
  unitPrice?: string;
  totalAmount?: string;
  commissionAmount?: string;
  tenantAmount?: string;
  rentalId: string;
  rentalCommissionRate: string;
  cubeId?: string;
  cubeCommissionRate?: string;
  currency: string;
};

async function main() {
  const staff = await prisma.user.upsert({
    where: { email: 'demo.staff@cornven.example' },
    update: {},
    create: { email: 'demo.staff@cornven.example', displayName: 'Demo Staff' },
  });

  const artist = await prisma.artist.upsert({
    where: { externalRef: 'ART-001' },
    update: {},
    create: { externalRef: 'ART-001', name: 'Sample Creator A' },
  });

  const venue = await prisma.venue.upsert({
    where: { externalRef: 'VENUE-001' },
    update: {},
    create: { externalRef: 'VENUE-001', name: 'Cornven Sample Venue' },
  });

  const product = await prisma.product.upsert({
    where: { artistId_sku: { artistId: artist.id, sku: 'SKU-A-001' } },
    update: {},
    create: { artistId: artist.id, sku: 'SKU-A-001', name: 'Sample Ceramic Cup' },
  });

  const rental = await prisma.rental.upsert({
    where: { externalRef: 'RENTAL-001' },
    update: {},
    create: {
      externalRef: 'RENTAL-001',
      artistId: artist.id,
      venueId: venue.id,
      cubeExternalRef: 'CUBE-001',
      commissionBps: 2_500,
      fixedRentCents: 160000, // NT$1,600, per client's confirmed example rate
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    },
  });

  await prisma.settlementRuleVersion.upsert({
    where: { rentalId_version: { rentalId: rental.id, version: 1 } },
    update: {},
    create: {
      rentalId: rental.id,
      version: 1,
      rentalCommissionBps: 2_500,
      rateSource: 'RENTAL',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      status: 'ACTIVE',
    },
  });

  const fixturePath = path.join(process.cwd(), '..', '..', 'fixtures', 'pos', 'mock-sales.json');
  const fixtureRaw = readFileSync(fixturePath, 'utf-8');
  const fixture: { commissionRateUnit: string; records: MockRecord[] } = JSON.parse(fixtureRaw);

  const fixtureChecksum = createHash('sha256').update(fixtureRaw).digest('hex');

  const importBatch = await prisma.importBatch.upsert({
    where: { checksum: fixtureChecksum },
    update: {},
    create: {
      source: 'MOCK',
      status: 'IMPORTED',
      sourceFileName: 'mock-sales.json',
      checksum: fixtureChecksum,
      totalRows: fixture.records.length,
      validRows: fixture.records.length,
      invalidRows: 0,
    },
  });

  const saleIdByTransactionId = new Map<string, string>();

  // Process in two passes: all SALE records first, then all REFUND/EXCHANGE
  // adjustment records. This guarantees a parent sale always exists in
  // saleIdByTransactionId by the time an adjustment record looks it up,
  // regardless of the original order of records within this batch.
  const saleRecords = fixture.records.filter((r) => r.recordType === 'sale');
  const adjustmentRecords = fixture.records.filter((r) => r.recordType !== 'sale');

  for (const record of saleRecords) {
    const rawChecksum = createHash('sha256')
      .update(`${importBatch.id}:${record.sourceRecordId}`)
      .digest('hex');

    {
      const sale = await prisma.sale.upsert({
        where: { dedupeKey: record.sourceTransactionId },
        update: {},
        create: {
          dedupeKey: record.sourceTransactionId,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          importBatchId: importBatch.id,
          artistId: artist.id,
          venueId: venue.id,
          productId: product.id,
          rentalId: rental.id,
          cubeExternalRef: record.cubeId ?? null,
          recordType: 'SALE',
          soldAt: new Date(record.occurredAt),
          quantitySold: record.quantity,
          unitPriceCents: toCents(record.unitPrice!),
          grossSalesCents: toCents(record.totalAmount!),
          refundAmountCents: 0n,
          sourceCommissionAmountCents: toCents(record.commissionAmount!),
          sourceTenantAmountCents: toCents(record.tenantAmount!),
          rentalCommissionBps: toBps(record.rentalCommissionRate),
          cubeCommissionBps: record.cubeCommissionRate ? toBps(record.cubeCommissionRate) : null,
          currency: record.currency,
        },
      });
      saleIdByTransactionId.set(record.sourceTransactionId, sale.id);

      await prisma.rawPosRecord.upsert({
        where: { importBatchId_checksum: { importBatchId: importBatch.id, checksum: rawChecksum } },
        update: {},
        create: {
          importBatchId: importBatch.id,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          recordType: 'SALE',
          canonicalSaleId: sale.id,
          quantity: record.quantity,
          unitPriceCents: toCents(record.unitPrice!),
          totalAmountCents: toCents(record.totalAmount!),
          commissionAmountCents: toCents(record.commissionAmount!),
          tenantAmountCents: toCents(record.tenantAmount!),
          rentalExternalRef: rental.externalRef,
          cubeExternalRef: record.cubeId ?? null,
          rentalRateRaw: record.rentalCommissionRate ?? null,
          cubeRateRaw: record.cubeCommissionRate ?? null,
          checksum: rawChecksum,
          rawPayload: record,
          status: 'NORMALIZED',
          occurredAt: new Date(record.occurredAt),
        },
      });
    }
  }

  for (const record of adjustmentRecords) {
    const rawChecksum = createHash('sha256')
      .update(`${importBatch.id}:${record.sourceRecordId}`)
      .digest('hex');

    if (record.recordType === 'refund') {
      // Refund is its own adjustment record now, not a mutation of the
      // original sale. Commission/tenant are read directly from the POS
      // source data (the fixture), NOT recalculated by us. The client's
      // settlement formula only operates on a per-creator revenue-share
      // percentage (Valid Sales x Creator Revenue Share %) and never
      // references cube/rental-level rates -- those exist only inside the
      // client's own POS system for its internal bookkeeping. As a
      // downstream consumer of POS-exported data, we trust the
      // commissionAmount/tenantAmount the source system already computed,
      // the same way we already do for the original SALE record.
      const parentTxnId = record.parentTransactionId!;
      const parentSaleId = saleIdByTransactionId.get(parentTxnId);
      if (!parentSaleId) {
        // Per-row error, does not fail the whole batch: record it and skip
        // this row, consistent with the project's row-level validation rule.
        await prisma.importError.create({
          data: {
            importBatchId: importBatch.id,
            field: 'parentTransactionId',
            code: 'PARENT_SALE_NOT_FOUND',
            message: `Refund ${record.sourceRecordId} references unknown parent transaction ${parentTxnId}`,
            rawValue: record,
          },
        });
        continue;
      }
      const parentSale = await prisma.sale.findUniqueOrThrow({ where: { id: parentSaleId } });

      const refundGrossCents = toCents(record.totalAmount!); // fixture stores this as negative
      const refundCommissionCents = toCents(record.commissionAmount!);
      const refundTenantCents = toCents(record.tenantAmount!);

      // Uses the shared, unit-tested logic (packages/database/src/refund.ts)
      // to guarantee the client-confirmed rule is applied: a cross-month
      // refund copies the ORIGINAL sale's rate, never the Rental's current
      // rate. See refund.test.ts for the regression test covering this.
      const refundFields = buildRefundSaleFields(parentSale, record);

      const refundSale = await prisma.sale.upsert({
        where: { dedupeKey: record.sourceTransactionId },
        update: {},
        create: {
          dedupeKey: record.sourceTransactionId,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          importBatchId: importBatch.id,
          artistId: artist.id,
          venueId: venue.id,
          productId: product.id,
          rentalId: rental.id,
          cubeExternalRef: record.cubeId ?? null,
          recordType: refundFields.recordType,
          parentSaleId: refundFields.parentSaleId,
          soldAt: new Date(record.occurredAt),
          quantitySold: record.quantity,
          unitPriceCents: refundFields.unitPriceCents,
          grossSalesCents: refundGrossCents,
          refundAmountCents: 0n,
          sourceCommissionAmountCents: refundCommissionCents,
          sourceTenantAmountCents: refundTenantCents,
          rentalCommissionBps: refundFields.rentalCommissionBps,
          cubeCommissionBps: refundFields.cubeCommissionBps,
          currency: refundFields.currency,
        },
      });

      await prisma.rawPosRecord.upsert({
        where: { importBatchId_checksum: { importBatchId: importBatch.id, checksum: rawChecksum } },
        update: {},
        create: {
          importBatchId: importBatch.id,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          parentTransactionId: record.parentTransactionId ?? null,
          recordType: 'REFUND',
          canonicalSaleId: refundSale.id,
          quantity: record.quantity,
          unitPriceCents: parentSale.unitPriceCents,
          totalAmountCents: refundGrossCents,
          commissionAmountCents: refundCommissionCents,
          tenantAmountCents: refundTenantCents,
          rentalExternalRef: rental.externalRef,
          cubeExternalRef: record.cubeId ?? null,
          rentalRateRaw: record.rentalCommissionRate ?? null,
          cubeRateRaw: record.cubeCommissionRate ?? null,
          checksum: rawChecksum,
          rawPayload: record,
          status: 'NORMALIZED',
          occurredAt: new Date(record.occurredAt),
        },
      });
    } else if (record.recordType === 'exchange') {
      // Exchange carries no monetary fields in this fixture; recorded as a
      // raw record only (not a Sale row), consistent with the current
      // fixture shape. Revisit if exchanges start carrying amounts.
      const originalSaleId = record.parentTransactionId
        ? saleIdByTransactionId.get(record.parentTransactionId)
        : undefined;

      await prisma.rawPosRecord.upsert({
        where: { importBatchId_checksum: { importBatchId: importBatch.id, checksum: rawChecksum } },
        update: {},
        create: {
          importBatchId: importBatch.id,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          parentTransactionId: record.parentTransactionId ?? null,
          recordType: 'EXCHANGE',
          canonicalSaleId: originalSaleId ?? null,
          quantity: record.quantity,
          rentalExternalRef: rental.externalRef,
          cubeExternalRef: record.cubeId ?? null,
          checksum: rawChecksum,
          rawPayload: record,
          status: 'NORMALIZED',
          occurredAt: new Date(record.occurredAt),
        },
      });
    }
  }

  // Mock inventory snapshots for the Low Stock Reminder report field.
  // Captured at month-end (Asia/Taipei 23:59:59 = UTC 15:59:59), per the
  // team's confirmed business rule. Covers a range of quantities (0, 1,
  // and several values > 1) across multiple products so the low-stock
  // (<=1) boundary can be properly exercised, per M3's review feedback.
  const MONTH_END_SNAPSHOT = new Date('2026-08-31T15:59:59.000Z');

  const inventoryScenarios: Array<{ sku: string; name: string; quantity: number }> = [
    { sku: 'SKU-A-001', name: 'Sample Ceramic Cup', quantity: 1 }, // existing product, kept as-is
    { sku: 'SKU-A-002', name: 'Hand-painted Vase', quantity: 0 },
    { sku: 'SKU-A-003', name: 'Woven Coaster Set', quantity: 0 },
    { sku: 'SKU-A-004', name: 'Ceramic Plate', quantity: 1 },
    { sku: 'SKU-A-005', name: 'Clay Incense Holder', quantity: 2 },
    { sku: 'SKU-A-006', name: 'Textured Bowl', quantity: 3 },
    { sku: 'SKU-A-007', name: 'Glazed Mug', quantity: 5 },
    { sku: 'SKU-A-008', name: 'Small Planter', quantity: 8 },
    { sku: 'SKU-A-009', name: 'Decorative Tile', quantity: 12 },
    { sku: 'SKU-A-010', name: 'Wall Hanging', quantity: 20 },
  ];

  for (const scenario of inventoryScenarios) {
    const scenarioProduct =
      scenario.sku === 'SKU-A-001'
        ? product
        : await prisma.product.upsert({
            where: { artistId_sku: { artistId: artist.id, sku: scenario.sku } },
            update: {},
            create: { artistId: artist.id, sku: scenario.sku, name: scenario.name },
          });

    await prisma.inventorySnapshot.upsert({
      where: {
        productId_venueId_capturedAt: {
          productId: scenarioProduct.id,
          venueId: venue.id,
          capturedAt: MONTH_END_SNAPSHOT,
        },
      },
      update: {},
      create: {
        productId: scenarioProduct.id,
        venueId: venue.id,
        capturedAt: MONTH_END_SNAPSHOT,
        quantity: scenario.quantity,
      },
    });
  }

  console.log({
    staffId: staff.id,
    artistId: artist.id,
    venueId: venue.id,
    rentalId: rental.id,
    importBatchId: importBatch.id,
    recordsProcessed: fixture.records.length,
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
