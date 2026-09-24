import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient, type Prisma } from '@cornven/database';
import { createApp } from '../src/app.js';
import { createReportRuntime } from '../src/modules/reporting/report-runtime.js';

const enabled = process.env.RUN_REPORT_INTEGRATION === 'true';
const db = new PrismaClient();
describe.skipIf(!enabled)('monthly preview with real PostgreSQL data', () => {
  let artistId: string,
    ownArtistId: string,
    productId: string,
    rentalId: string,
    venueId: string,
    importBatchId: string;
  const tag = 'PREVIEW-' + randomUUID();
  const renderer = {
    render: vi.fn(async () => {
      throw new Error('Preview must not render PDF');
    }),
  };
  const now = new Date('2026-09-20T04:00:00Z');
  const runtime = createReportRuntime({
    db,
    now: () => now,
    renderer,
    resolveActor: () => ({ id: 'local-preview-test', artistIds: '*' }),
  });
  const app = createApp(runtime);
  const counts = async () => ({
    sales: await db.sale.count(),
    batches: await db.importBatch.count(),
    raw: await db.rawPosRecord.count(),
    reports: await db.artistMonthlyReport.count(),
    tasks: await db.reportGenerationTask.count(),
    snapshots: await db.settlementInputSnapshot.count(),
    artifacts: await db.reportArtifact.count(),
    audit: await db.auditEvent.count(),
    runs: await db.settlementRun.count(),
    approvals: await db.approvalEvent.count(),
    stock: await db.inventorySnapshot.count(),
    locks: await db.scheduledReportLock.count(),
  });
  const sale = (suffix: string, overrides: Partial<Prisma.SaleUncheckedCreateInput> = {}) => ({
    importBatchId,
    dedupeKey: tag + suffix,
    sourceRecordId: tag + suffix,
    sourceTransactionId: tag + '-TX-' + suffix,
    artistId: ownArtistId,
    productId,
    rentalId,
    venueId,
    recordType: 'SALE' as const,
    soldAt: new Date('2026-08-10T04:00:00Z'),
    quantitySold: 4,
    unitPriceCents: 5000n,
    grossSalesCents: 20000n,
    sourceCommissionAmountCents: 5000n,
    sourceTenantAmountCents: 15000n,
    rentalCommissionBps: 2500,
    currency: 'TWD',
    ...overrides,
  });
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('/cornven_planb_test?'))
      throw new Error('Use isolated cornven_planb_test.');
    artistId = (await db.artist.findUniqueOrThrow({ where: { externalRef: 'ART-001' } })).id;
    importBatchId = (
      await db.importBatch.create({ data: { source: 'MOCK', checksum: tag, status: 'IMPORTED' } })
    ).id;
    venueId = (await db.venue.findUniqueOrThrow({ where: { externalRef: 'VENUE-001' } })).id;
    ownArtistId = (
      await db.artist.create({ data: { externalRef: tag, name: 'Read-only preview test' } })
    ).id;
    productId = (
      await db.product.create({ data: { artistId: ownArtistId, name: 'Preview cup', sku: tag } })
    ).id;
    rentalId = (
      await db.rental.create({
        data: {
          artistId: ownArtistId,
          venueId,
          externalRef: tag,
          commissionBps: 3000,
          fixedRentCents: 10000,
          effectiveFrom: new Date('2026-07-01T00:00:00Z'),
        },
      })
    ).id;
    const original = await db.sale.create({ data: sale('original') });
    await db.sale.create({
      data: sale('earlier-refund', {
        recordType: 'REFUND',
        parentSaleId: original.id,
        soldAt: new Date('2026-08-15T04:00:00Z'),
        quantitySold: -1,
        grossSalesCents: -5000n,
        sourceCommissionAmountCents: -1250n,
        sourceTenantAmountCents: -3750n,
      }),
    });
    await db.sale.create({
      data: sale('current-refund', {
        recordType: 'REFUND',
        parentSaleId: original.id,
        soldAt: new Date('2026-09-05T04:00:00Z'),
        quantitySold: -1,
        grossSalesCents: -5000n,
        sourceCommissionAmountCents: -1500n,
        sourceTenantAmountCents: -3500n,
        rentalCommissionBps: 3000,
      }),
    });
    await db.sale.create({ data: sale('future', { soldAt: new Date('2026-09-21T04:00:00Z') }) });
  });
  afterAll(async () => {
    if (ownArtistId) {
      await db.sale.deleteMany({ where: { artistId: ownArtistId, recordType: 'REFUND' } });
      await db.sale.deleteMany({ where: { artistId: ownArtistId } });
      await db.inventorySnapshot.deleteMany({ where: { productId } });
      await db.product.delete({ where: { id: productId } });
      await db.rental.delete({ where: { id: rentalId } });
      await db.artist.delete({ where: { id: ownArtistId } });
      if (importBatchId) await db.importBatch.delete({ where: { id: importBatchId } });
    }
    await db.$disconnect();
  });
  it('returns the seeded complete-month M3 amounts and real low stock', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/monthly-preview')
      .send({ artistId, settlementMonth: '2026-08' });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      totalProductSalesCents: 20000,
      refundsCents: 5000,
      validSalesCents: 15000,
      creatorRevenueShareAmountCents: 12000,
      amountPayableToCreatorCents: null,
      isProvisional: false,
    });
    expect(response.body.result.lowStockReminder.products).toHaveLength(4);
    expect(response.body.dataCutoff).toBe('2026-08-31T15:59:59.999Z');
  });
  it('resolves original sales and previous refunds and excludes future transactions', async () => {
    const result = await runtime.preview.preview({
      artistId: ownArtistId,
      settlementMonth: '2026-09',
    });
    expect(result.result).toMatchObject({
      totalProductSalesCents: 0,
      refundsCents: 5000,
      validSalesCents: -5000,
      creatorRevenueShareAmountCents: -3750,
      isProvisional: true,
      lowStockReminder: { status: 'unavailable' },
    });
    expect(result.result.rentals[0]?.revenueShares[0]?.creatorCommissionBps).toBe(7500);
  });
  it('returns zeros for no transactions while retaining active rental metadata', async () => {
    const result = await runtime.preview.preview({
      artistId: ownArtistId,
      settlementMonth: '2026-07',
    });
    expect(result.result.validSalesCents).toBe(0);
    expect(result.result.rentals[0]?.rentalAmountCents).toBe(10000);
    expect(result.result.amountPayableToCreatorCents).toBeNull();
  });
  it('returns a stable not-found error for an unknown artist', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/monthly-preview')
      .send({ artistId: randomUUID(), settlementMonth: '2026-09' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
  it('leaves persisted data unchanged after repeated and concurrent HTTP/tool previews', async () => {
    const before = await counts();
    const query = { artistId, settlementMonth: '2026-08' };
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(app)
          .post(
            i % 2
              ? '/api/v1/assistant/tools/settlement.preview'
              : '/api/v1/settlements/monthly-preview',
          )
          .send(query),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(responses[0]!.body);
    }
    expect(await counts()).toEqual(before);
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
