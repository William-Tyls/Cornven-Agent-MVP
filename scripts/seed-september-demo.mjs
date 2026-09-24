import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55449' || url.pathname !== '/cornven_planb')
  throw new Error('Only the isolated cornven_planb demo database is allowed.');
const { database: db } = await import('../packages/database/dist/index.js');
const { RawPosRecordSchema } = await import('../packages/contracts/dist/index.js');
const prefix = 'DEMO-202609-V1';
const sourceFileName = 'local-september-demo-v1.json';
const capturedAt = new Date('2026-09-17T18:00:00+08:00');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const money = (cents) => (Number(cents) / 100).toFixed(2);
const date = (day, hour = 12) =>
  new Date(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`);
const seedResult = {};
try {
  await db.$transaction(
    async (tx) => {
      const baseArtist = await tx.artist.findUniqueOrThrow({ where: { externalRef: 'ART-001' } });
      const baseVenue = await tx.venue.findUniqueOrThrow({ where: { externalRef: 'VENUE-001' } });
      const baseRental = await tx.rental.findUniqueOrThrow({
        where: { externalRef: 'RENTAL-001' },
      });
      const venues = [baseVenue];
      for (const [index, name] of [
        'Taipei Riverside Gallery',
        'Kaohsiung Design Space',
      ].entries()) {
        venues.push(
          await tx.venue.upsert({
            where: { externalRef: `${prefix}-VENUE-${index + 2}` },
            update: {},
            create: { externalRef: `${prefix}-VENUE-${index + 2}`, name, timezone: 'Asia/Taipei' },
          }),
        );
      }
      const profiles = [{ artist: baseArtist, code: 'A', rate: 2500, rentals: [baseRental] }];
      const definitions = [
        {
          code: 'B',
          name: 'Harbor Ceramics',
          brand: 'Harbor Clay',
          rate: 2000,
          venues: [1, 2],
          rent: 120000,
          products: ['Ocean Blue Cup', 'Glazed Tea Bowl', 'Sandstone Plate', 'Small Ceramic Vase'],
        },
        {
          code: 'C',
          name: 'Paper & Ink Studio',
          brand: 'Paper & Ink',
          rate: 3000,
          venues: [1],
          rent: 90000,
          products: [
            'Botanical Art Print',
            'Illustrated Notebook',
            'Postcard Set',
            'Limited Edition Poster',
          ],
        },
        {
          code: 'D',
          name: 'Threadlight Textile',
          brand: 'Threadlight',
          rate: 1500,
          venues: [2],
          rent: 110000,
          products: ['Woven Tote Bag', 'Linen Pouch', 'Cotton Scarf', 'Fabric Coaster Set'],
        },
        {
          code: 'E',
          name: 'Quiet Clay Studio',
          brand: 'Quiet Clay',
          rate: 2500,
          venues: [2],
          rent: 70000,
          products: ['Mini Planter', 'Incense Tray', 'Clay Pendant', 'Ceramic Spoon'],
        },
      ];
      for (const definition of definitions) {
        const artist = await tx.artist.upsert({
          where: { externalRef: `${prefix}-ART-${definition.code}` },
          update: {},
          create: {
            externalRef: `${prefix}-ART-${definition.code}`,
            name: definition.name,
            brandName: definition.brand,
          },
        });
        const rentals = [];
        for (const [i, venueIndex] of definition.venues.entries()) {
          const externalRef = `${prefix}-RENTAL-${definition.code}-${i + 1}`;
          const rental = await tx.rental.upsert({
            where: { externalRef },
            update: {},
            create: {
              externalRef,
              artistId: artist.id,
              venueId: venues[venueIndex].id,
              commissionBps: definition.rate,
              fixedRentCents: i ? 80000 : definition.rent,
              effectiveFrom: date(1, 0),
            },
          });
          rentals.push(rental);
          await tx.settlementRuleVersion.upsert({
            where: { rentalId_version: { rentalId: rental.id, version: 1 } },
            update: {},
            create: {
              rentalId: rental.id,
              version: 1,
              rentalCommissionBps: definition.rate,
              rateSource: 'RENTAL',
              status: 'ACTIVE',
              effectiveFrom: date(1, 0),
            },
          });
        }
        for (const [i, name] of definition.products.entries()) {
          const sku = `DEMO-${definition.code}-${String(i + 1).padStart(3, '0')}`;
          await tx.product.upsert({
            where: { artistId_sku: { artistId: artist.id, sku } },
            update: {},
            create: { externalRef: `${prefix}-${sku}`, artistId: artist.id, sku, name },
          });
        }
        profiles.push({ artist, code: definition.code, rate: definition.rate, rentals });
      }
      const batch = await tx.importBatch.upsert({
        where: { checksum: hash(prefix) },
        update: {},
        create: {
          source: 'MOCK',
          status: 'IMPORTED',
          sourceFileName,
          checksum: hash(prefix),
          totalRows: 72,
          validRows: 72,
          invalidRows: 0,
        },
      });
      const sourceRows = [];
      const inventorySnapshots = [];
      async function record(profile, product, rental, index, kind, parent = null) {
        const key = `${prefix}-${profile.code}-${kind}-${String(index).padStart(3, '0')}`;
        const venue = venues.find((v) => v.id === rental.venueId);
        const rate = parent?.rentalCommissionBps ?? profile.rate;
        const unit =
          parent?.unitPriceCents ??
          BigInt(
            profile.code === 'A' && product.sku === 'SKU-A-001'
              ? 5000
              : 15000 + (profile.code.charCodeAt(0) - 65) * 10000 + (index % 4) * 5000,
          );
        const quantity = kind === 'sale' ? 1 + (index % 4) : kind === 'refund' ? -1 : 1;
        const total = unit * BigInt(quantity),
          commission = (total * BigInt(rate)) / 10000n;
        const soldAt =
          kind === 'sale' ? date(index) : date(kind === 'refund' ? 15 + index : 17, 14);
        const raw = {
          recordType: kind,
          sourceRecordId: key,
          sourceTransactionId: key,
          ...(parent ? { parentTransactionId: parent.sourceTransactionId } : {}),
          artistId: profile.artist.externalRef,
          artistName: profile.artist.name,
          venueId: venue.externalRef,
          venueName: venue.name,
          productId: product.externalRef ?? product.sku,
          sku: product.sku,
          productName: product.name,
          occurredAt: soldAt.toISOString(),
          quantity,
          currency: 'TWD',
          ...(kind !== 'exchange'
            ? {
                unitPrice: money(unit),
                totalAmount: money(total),
                commissionAmount: money(commission),
                tenantAmount: money(total - commission),
                rentalId: rental.externalRef,
                rentalCommissionRate: (rate / 10000).toFixed(4),
              }
            : {}),
        };
        RawPosRecordSchema.parse(raw);
        sourceRows.push(raw);
        let canonical = null;
        if (kind !== 'exchange')
          canonical = await tx.sale.upsert({
            where: { dedupeKey: key },
            update: {},
            create: {
              dedupeKey: key,
              sourceRecordId: key,
              sourceTransactionId: key,
              importBatchId: batch.id,
              artistId: profile.artist.id,
              venueId: venue.id,
              productId: product.id,
              rentalId: rental.id,
              recordType: kind === 'sale' ? 'SALE' : 'REFUND',
              parentSaleId: parent?.id ?? null,
              soldAt,
              quantitySold: quantity,
              unitPriceCents: unit,
              grossSalesCents: total,
              sourceCommissionAmountCents: commission,
              sourceTenantAmountCents: total - commission,
              rentalCommissionBps: rate,
              currency: 'TWD',
            },
          });
        await tx.rawPosRecord.upsert({
          where: { importBatchId_sourceRecordId: { importBatchId: batch.id, sourceRecordId: key } },
          update: {},
          create: {
            importBatchId: batch.id,
            sourceRecordId: key,
            sourceTransactionId: key,
            parentTransactionId: parent?.sourceTransactionId ?? null,
            recordType: kind.toUpperCase(),
            canonicalSaleId: canonical?.id ?? parent?.id ?? null,
            quantity,
            checksum: hash(key),
            rawPayload: raw,
            status: 'NORMALIZED',
            occurredAt: soldAt,
            rentalExternalRef: rental.externalRef,
            ...(kind !== 'exchange'
              ? {
                  unitPriceCents: unit,
                  totalAmountCents: total,
                  commissionAmountCents: commission,
                  tenantAmountCents: total - commission,
                  rentalRateRaw: (rate / 10000).toFixed(4),
                }
              : {}),
          },
        });
        return canonical;
      }
      for (const profile of profiles) {
        const products = await tx.product.findMany({
          where: { artistId: profile.artist.id },
          orderBy: { sku: 'asc' },
        });
        const originals = [];
        if (profile.code !== 'E') {
          for (let i = 1; i <= 15; i++) {
            const product = products[(i - 1) % products.length],
              rental = profile.rentals[(i - 1) % profile.rentals.length];
            originals.push({
              sale: await record(profile, product, rental, i, 'sale'),
              product,
              rental,
            });
          }
          const refundParents = [originals[0], originals[1]];
          if (profile.code === 'A') {
            const parent = await tx.sale.findUniqueOrThrow({ where: { dedupeKey: 'TX-001' } });
            refundParents[0] = {
              sale: parent,
              product: products.find((p) => p.id === parent.productId),
              rental: baseRental,
            };
          }
          for (const [i, parent] of refundParents.entries())
            await record(profile, parent.product, parent.rental, i + 1, 'refund', parent.sale);
          await record(
            profile,
            originals[2].product,
            originals[2].rental,
            1,
            'exchange',
            originals[2].sale,
          );
        }
        const items = [];
        for (const rental of profile.rentals) {
          const venue = venues.find((v) => v.id === rental.venueId);
          for (const [i, product] of products.entries()) {
            await tx.inventorySnapshot.upsert({
              where: {
                productId_venueId_capturedAt: {
                  productId: product.id,
                  venueId: venue.id,
                  capturedAt,
                },
              },
              update: {},
              create: {
                productId: product.id,
                venueId: venue.id,
                capturedAt,
                quantity: [0, 1, 4, 8][i % 4],
              },
            });
            items.push({ sku: product.sku, venueExternalRef: venue.externalRef });
          }
        }
        inventorySnapshots.push({
          artistExternalRef: profile.artist.externalRef,
          capturedAt: capturedAt.toISOString(),
          items,
        });
      }
      assert.equal(sourceRows.length, 72);
      await tx.importBatch.update({
        where: { id: batch.id },
        data: { metadata: { demoDataset: 'september-2026-v1', inventorySnapshots } },
      });
      seedResult.sourceRows = sourceRows;
      seedResult.inventorySnapshots = inventorySnapshots;
    },
    { timeout: 30000 },
  );
  const { DatabaseMonthlyReportContext } = await import(
    '../apps/api/dist/modules/import/database-monthly-report-context.service.js'
  );
  const { calculateSettlementPreview } = await import(
    '../apps/api/dist/modules/settlement/settlement.service.js'
  );
  const { SettlementPreviewInputSchema } = await import('../packages/contracts/dist/index.js');
  const provider = new DatabaseMonthlyReportContext(db),
    expected = [];
  const artists = await db.artist.findMany({
    where: { OR: [{ externalRef: 'ART-001' }, { externalRef: { startsWith: prefix + '-ART-' } }] },
    orderBy: { name: 'asc' },
  });
  for (const artist of artists) {
    const query = {
      artistId: artist.id,
      settlementMonth: '2026-09',
      asOf: '2026-09-18T00:00:00+08:00',
    };
    const context = await provider.getMonthlyReportContext(query);
    assert.equal(context.inventory?.complete, true);
    const report = calculateSettlementPreview(
      SettlementPreviewInputSchema.parse({ ...context, ...query }),
    );
    expected.push({
      artistId: artist.id,
      artistName: artist.name,
      sales: report.totalProductSalesCents,
      refunds: report.refundsCents,
      validSales: report.validSalesCents,
      creatorShare: report.creatorRevenueShareAmountCents,
      fee: report.bankTransferFeeCents,
      payable: report.amountPayableToCreatorCents,
      lowStockProducts: report.lowStockReminder.products.length,
      rentals: report.rentals.length,
    });
  }
  assert.equal(expected.length, 5);
  assert.equal(expected.filter((r) => r.sales > 0).length, 4);
  const batch = await db.importBatch.findUniqueOrThrow({ where: { checksum: hash(prefix) } });
  assert.equal(await db.sale.count({ where: { importBatchId: batch.id } }), 68);
  assert.equal(await db.rawPosRecord.count({ where: { importBatchId: batch.id } }), 72);
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    '.local/evidence/september-demo.json',
    JSON.stringify(
      { dataset: prefix, asOf: '2026-09-18T00:00:00+08:00', expected, ...seedResult },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { artists: 5, newSales: 60, newRefunds: 8, newExchanges: 4, newInventoryRows: 30, expected },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
