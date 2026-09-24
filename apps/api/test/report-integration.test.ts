import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@cornven/database';
import { SettlementPreviewInputSchema } from '@cornven/contracts';
import { createApp } from '../src/app.js';
import { createReportRuntime } from '../src/modules/reporting/report-runtime.js';
import { calculateSettlementPreview } from '../src/modules/settlement/settlement.service.js';

const enabled = process.env.RUN_REPORT_INTEGRATION === 'true';
const db = new PrismaClient();
const pdf = new TextEncoder().encode('%PDF-1.7\nmock renderer for orchestration tests');

describe.skipIf(!enabled)('report chain with a real isolated PostgreSQL database', () => {
  let artistId: string, otherId: string, root: string;
  let now = new Date('2026-09-18T06:30:00Z');
  const make = (render = vi.fn(async () => pdf), ids: '*' | string[] = '*') =>
    createReportRuntime({
      db,
      now: () => new Date(now),
      renderer: { render },
      storagePath: root,
      startMonth: '2026-08',
      resolveActor: () => ({ id: 'integration-staff', artistIds: ids }),
    });
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('/cornven_planb_test?'))
      throw new Error('Use the isolated cornven_planb_test database.');
    root = await mkdtemp(join(tmpdir(), 'cornven-report-test-'));
    const artist = await db.artist.findUniqueOrThrow({ where: { externalRef: 'ART-001' } });
    artistId = artist.id;
    const other = await db.artist.upsert({
      where: { externalRef: 'INTEGRATION-OTHER' },
      update: {},
      create: { externalRef: 'INTEGRATION-OTHER', name: 'Second Artist' },
    });
    otherId = other.id;
    const venue = await db.venue.findFirstOrThrow();
    await db.rental.upsert({
      where: { externalRef: 'INTEGRATION-ZERO' },
      update: {},
      create: {
        externalRef: 'INTEGRATION-ZERO',
        artistId: otherId,
        venueId: venue.id,
        commissionBps: 2500,
        fixedRentCents: 1000,
        effectiveFrom: new Date('2026-07-01T00:00:00+08:00'),
      },
    });
  });
  beforeEach(async () => {
    now = new Date('2026-09-18T06:30:00Z');
    await db.monthlyReportDelivery.deleteMany();
    await db.monthlyReportApprovalEvent.deleteMany();
    await db.monthlyReportApproval.deleteMany();
    await db.reportArtifact.deleteMany();
    await db.settlementInputSnapshot.deleteMany();
    await db.scheduledReportLock.deleteMany();
    await db.reportGenerationTask.deleteMany();
    await db.artistMonthlyReport.deleteMany();
    await db.reportScheduleCheckpoint.deleteMany();
    await db.sale.deleteMany({ where: { dedupeKey: { startsWith: 'integration-test-' } } });
  });
  afterAll(async () => {
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('AC-05/07/09/16: reads seed IDs, PR27 inventory and known amounts through M2 and M3', async () => {
    const runtime = make();
    const context = await runtime.data.getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-08',
      asOf: '2026-09-01T00:00:00+08:00',
    });
    const input = SettlementPreviewInputSchema.parse({
      ...context,
      settlementMonth: '2026-08',
      asOf: '2026-09-01T00:00:00+08:00',
    });
    const before = JSON.stringify(input);
    const result = calculateSettlementPreview(input);
    expect(result).toMatchObject({
      totalProductSalesCents: 20000,
      refundsCents: 5000,
      validSalesCents: 15000,
      creatorRevenueShareAmountCents: 12000,
      bankTransferFeeCents: null,
      amountPayableToCreatorCents: null,
      isProvisional: false,
    });
    expect(context.rentals[0]?.monthlyRentCents).toBe(160000);
    expect(context.inventory?.items).toHaveLength(10);
    expect(context.inventory?.complete).toBe(true);
    expect(result.lowStockReminder.products).toHaveLength(4);
    expect(calculateSettlementPreview(input)).toEqual(result);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('AC-02/08: excludes future inventory and includes only transactions through cutoff', async () => {
    const data = make().data;
    const context = await data.getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-08',
      asOf: '2026-08-01T00:00:00+08:00',
    });
    expect(context.sales).toEqual([]);
    expect(context.inventory).toBeNull();
  });
  it('AC-05: current-month refund includes original sale and earlier refunds with the original rate', async () => {
    const original = await db.sale.findFirstOrThrow({ where: { artistId, recordType: 'SALE' } });
    const id = randomUUID();
    await db.sale.create({
      data: {
        ...original,
        id,
        dedupeKey: `integration-test-${id}`,
        sourceRecordId: id,
        sourceTransactionId: id,
        recordType: 'REFUND',
        parentSaleId: original.id,
        soldAt: new Date('2026-09-10T00:00:00+08:00'),
        quantitySold: -1,
        grossSalesCents: -5000n,
        sourceCommissionAmountCents: -1250n,
        sourceTenantAmountCents: -3750n,
        rentalCommissionBps: 2500,
      },
    });
    const context = await make().data.getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-09',
      asOf: now.toISOString(),
    });
    expect(context.sales).toHaveLength(1);
    expect(context.historicalRecords).toHaveLength(2);
    expect(context.sales[0]?.parentTransactionId).toBe(original.sourceTransactionId);
    const result = calculateSettlementPreview(
      SettlementPreviewInputSchema.parse({
        ...context,
        settlementMonth: '2026-09',
        asOf: now.toISOString(),
      }),
    );
    expect(result.creatorRevenueShareAmountCents).toBe(-4000);
  });
  it('AC-02/03: exact cutoff is included and the next instant and next month are excluded', async () => {
    const original = await db.sale.findFirstOrThrow({ where: { artistId, recordType: 'SALE' } });
    for (const soldAt of [
      now,
      new Date(now.getTime() + 1),
      new Date('2026-10-01T00:00:00+08:00'),
    ]) {
      const id = randomUUID();
      await db.sale.create({
        data: {
          ...original,
          id,
          dedupeKey: `integration-test-${id}`,
          sourceRecordId: id,
          sourceTransactionId: id,
          soldAt,
        },
      });
    }
    const context = await make().data.getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-09',
      asOf: now.toISOString(),
    });
    expect(context.sales).toHaveLength(1);
    const full = await make().data.getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-09',
      asOf: '2026-10-01T00:00:00+08:00',
    });
    expect(full.sales).toHaveLength(2);
  });
  it('AC-08: partial inventory stays incomplete and is not filled with older rows', async () => {
    const seed = await db.inventorySnapshot.findFirstOrThrow({ where: { product: { artistId } } });
    const partial = await db.inventorySnapshot.create({
      data: {
        productId: seed.productId,
        venueId: seed.venueId,
        capturedAt: new Date('2026-09-01T00:00:00Z'),
        quantity: 7,
      },
    });
    try {
      const context = await make().data.getMonthlyReportContext({
        artistId,
        settlementMonth: '2026-09',
        asOf: now.toISOString(),
      });
      expect(context.inventory?.complete).toBe(false);
      expect(context.inventory?.items).toHaveLength(1);
    } finally {
      await db.inventorySnapshot.delete({ where: { id: partial.id } });
    }
  });

  it('demo manifests require an exact artist, timestamp and product/venue set', async () => {
    const originals = await db.inventorySnapshot.findMany({
      where: { product: { artistId } },
      include: { product: true, venue: true },
      take: 2,
    });
    const capturedAt = new Date('2026-09-17T10:00:00Z');
    const created = [];
    const batch = await db.importBatch.create({
      data: {
        source: 'MOCK',
        status: 'IMPORTED',
        sourceFileName: 'local-september-demo-v1.json',
        checksum: randomUUID(),
        metadata: {
          demoDataset: 'september-2026-v1',
          inventorySnapshots: [
            {
              artistExternalRef: 'ART-001',
              capturedAt: capturedAt.toISOString(),
              items: originals.map((row) => ({
                sku: row.product.sku,
                venueExternalRef: row.venue.externalRef,
              })),
            },
          ],
        },
      },
    });
    const query = { artistId, settlementMonth: '2026-09', asOf: now.toISOString() };
    try {
      for (const row of originals) {
        created.push(
          await db.inventorySnapshot.create({
            data: { productId: row.productId, venueId: row.venueId, capturedAt, quantity: 1 },
          }),
        );
        const result = await make().data.getMonthlyReportContext(query);
        expect(result.inventory?.complete).toBe(created.length === originals.length);
      }
      await db.importBatch.update({
        where: { id: batch.id },
        data: {
          metadata: {
            demoDataset: 'september-2026-v1',
            inventorySnapshots: [
              {
                artistExternalRef: 'WRONG-ARTIST',
                capturedAt: capturedAt.toISOString(),
                items: originals.map((row) => ({
                  sku: row.product.sku,
                  venueExternalRef: row.venue.externalRef,
                })),
              },
            ],
          },
        },
      });
      expect((await make().data.getMonthlyReportContext(query)).inventory?.complete).toBe(false);
    } finally {
      await db.inventorySnapshot.deleteMany({
        where: { id: { in: created.map((row) => row.id) } },
      });
      await db.importBatch.delete({ where: { id: batch.id } });
    }
  });

  it('AC-06/11: zero-sale artist keeps rentals and cannot receive another artist records', async () => {
    const context = await make().data.getMonthlyReportContext({
      artistId: otherId,
      settlementMonth: '2026-08',
      asOf: '2026-09-01T00:00:00+08:00',
    });
    expect(context.sales).toEqual([]);
    expect(context.historicalRecords).toEqual([]);
    expect(context.rentals).toHaveLength(1);
    expect(context.inventory).toBeNull();
  });
  it('AC-01/12/17: creates, reads, lists and downloads; same key replays after month rollover', async () => {
    const render = vi.fn(async () => pdf),
      runtime = make(render),
      app = createApp(runtime);
    const body = { artistId, period: 'current_month', format: 'pdf' };
    const result = await request(app)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'replay')
      .send(body)
      .expect(201);
    expect(result.body).toMatchObject({
      settlementMonth: '2026-09',
      asOf: '2026-09-18T06:30:00.000Z',
      isProvisional: true,
    });
    now = new Date('2026-10-01T01:00:00Z');
    const replay = await request(app)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'replay')
      .send(body)
      .expect(200);
    expect(replay.body).toEqual(result.body);
    expect(render).toHaveBeenCalledTimes(1);
    const detail = await request(app).get(`/api/v1/reports/${result.body.reportId}`).expect(200);
    expect(detail.body.settlementPeriod.asOf).toBe(result.body.asOf);
    expect(detail.body.financialSummary.bankTransferFeeCents).toBeNull();
    const list = await request(app).get(`/api/v1/reports?artistId=${artistId}`).expect(200);
    expect(list.body.items).toHaveLength(1);
    await request(app)
      .get(result.body.pdfFileReference)
      .expect('Content-Type', /application\/pdf/)
      .expect(200);
  });
  it('rejects browser-supplied scope, missing keys and conflicting keys', async () => {
    const app = createApp(make()),
      body = { artistId, period: 'current_month', format: 'pdf' };
    await request(app).post('/api/v1/reports').send(body).expect(400);
    await request(app)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'one')
      .send({ ...body, asOf: now.toISOString() })
      .expect(400);
    await request(app).post('/api/v1/reports').set('Idempotency-Key', 'one').send(body).expect(201);
    await request(app)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'one')
      .send({ ...body, artistId: otherId })
      .expect(409);
    await request(app)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'missing')
      .send({ ...body, artistId: 'missing' })
      .expect(404);
  });
  it('AC-11: filters directory and denies report access without trusted scope', async () => {
    const full = createApp(make());
    const generated = await request(full)
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'access')
      .send({ artistId, period: 'current_month', format: 'pdf' })
      .expect(201);
    const scoped = createApp(make(undefined, [otherId]));
    expect(
      (await request(scoped).get('/api/v1/artists').expect(200)).body.items.map(
        (x: { artistId: string }) => x.artistId,
      ),
    ).toEqual([otherId]);
    await request(scoped).get(`/api/v1/reports/${generated.body.reportId}`).expect(403);
    await request(scoped).get(generated.body.pdfFileReference).expect(403);
    const runtime = make();
    runtime.resolveActor = () => null;
    await request(createApp(runtime)).get('/api/v1/artists').expect(401);
  });
  it('AC-12: concurrent same-key requests cannot duplicate task or report', async () => {
    const runtime = make(),
      actor = { id: 'race', artistIds: '*' } as const;
    const body = { artistId, period: 'current_month', format: 'pdf' };
    const results = await Promise.allSettled([
      runtime.service.generate(body, 'race', actor),
      runtime.service.generate(body, 'race', actor),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await db.reportGenerationTask.count()).toBe(1);
    expect(await db.artistMonthlyReport.count()).toBe(1);
  });
  it('allocates unique versions atomically for concurrent new requests', async () => {
    const runtime = make(),
      actor = { id: 'race', artistIds: '*' } as const;
    await Promise.all(
      ['v1', 'v2'].map((key) =>
        runtime.service.generate({ artistId, period: 'current_month', format: 'pdf' }, key, actor),
      ),
    );
    expect(
      (await db.artistMonthlyReport.findMany({ orderBy: { version: 'asc' } })).map(
        (r) => r.version,
      ),
    ).toEqual([1, 2]);
  });
  it('AC-14/15: renderer failure persists snapshot and a new runtime recovers without refetch', async () => {
    const broken = make(
        vi.fn(async () => {
          throw new Error('Browser failed');
        }),
      ),
      actor = { id: 'retry', artistIds: '*' } as const;
    const body = { artistId, period: 'current_month', format: 'pdf' };
    await expect(broken.service.generate(body, 'retry', actor)).rejects.toMatchObject({
      code: 'REPORT_GENERATION_FAILED',
    });
    expect(await db.settlementInputSnapshot.count()).toBe(1);
    expect((await broken.repository.listReports({}, actor)).items).toHaveLength(0);
    const recovered = make();
    const spy = vi
      .spyOn(recovered.data, 'getMonthlyReportContext')
      .mockRejectedValue(new Error('Must not read again'));
    const result = await recovered.service.generate(body, 'retry', actor);
    expect(result.body.generationStatus).toBe('ready');
    expect(spy).not.toHaveBeenCalled();
  });
  it('AC-10: data failure never becomes a zero-sales successful report', async () => {
    const runtime = make();
    vi.spyOn(runtime.data, 'getMonthlyReportContext').mockRejectedValue(
      new Error('Database unavailable'),
    );
    await request(createApp(runtime))
      .post('/api/v1/reports')
      .set('Idempotency-Key', 'failure')
      .send({ artistId, period: 'current_month', format: 'pdf' })
      .expect(503);
    expect(await db.artistMonthlyReport.count()).toBe(0);
  });
  it('AC-03/06/13/15: scheduler works without browser, catches up and includes zero-sale rentals once', async () => {
    now = new Date('2026-09-01T00:10:00+08:00');
    const runtime = make();
    // Browser tests may have left additional artists in this isolated database.
    const eligible = await runtime.data.listMonthlyReportArtistIds({
      settlementMonth: '2026-08',
      asOf: '2026-08-31T16:00:00.000Z',
      limit: 1000,
    });
    expect(eligible.artistIds).toEqual(expect.arrayContaining([artistId, otherId]));
    await runtime.scheduler.tick();
    await make().scheduler.tick();
    const reports = await db.artistMonthlyReport.findMany();
    expect(reports.map((report) => report.artistId).sort()).toEqual([...eligible.artistIds].sort());
    expect(
      reports.every(
        (r) =>
          r.settlementMonth === '2026-08' &&
          !r.isProvisional &&
          r.asOf.toISOString() === '2026-08-31T16:00:00.000Z',
      ),
    ).toBe(true);
    expect(await db.scheduledReportLock.count()).toBe(eligible.artistIds.length);
    expect((await runtime.scheduler.batchStatus('2026-08')).status).toBe('success');
  });
  it('AC-14: automatic failure does not stop other artists and retries after backoff', async () => {
    now = new Date('2026-09-01T00:10:00+08:00');
    let calls = 0;
    const runtime = make(
      vi.fn(async () => {
        if (++calls === 1) throw new Error('One failure');
        return pdf;
      }),
    );
    const eligible = await runtime.data.listMonthlyReportArtistIds({
      settlementMonth: '2026-08',
      asOf: '2026-08-31T16:00:00.000Z',
      limit: 1000,
    });
    expect(eligible.artistIds).toEqual(expect.arrayContaining([artistId, otherId]));
    await runtime.scheduler.tick();
    expect(await db.reportGenerationTask.count({ where: { status: 'SUCCEEDED' } })).toBe(
      eligible.artistIds.length - 1,
    );
    await runtime.scheduler.tick();
    expect(calls).toBe(eligible.artistIds.length);
    now = new Date(now.getTime() + 60001);
    await make().scheduler.tick();
    expect(await db.reportGenerationTask.count({ where: { status: 'SUCCEEDED' } })).toBe(
      eligible.artistIds.length,
    );
  });
  it('AC-15: expired lease can be recovered while old token cannot finalize', async () => {
    const runtime = make();
    const { task } = await runtime.service.enqueueScheduled({
      artistId,
      settlementMonth: '2026-08',
      asOf: '2026-08-31T16:00:00.000Z',
      trigger: 'scheduled',
    });
    const old = await runtime.repository.claim(task.id, now, 3);
    expect(old).not.toBeNull();
    now = new Date(now.getTime() + 121000);
    await make().service.runTask(task.id);
    expect(await runtime.repository.renew(task.id, old!.token, now)).toBe(false);
    expect((await runtime.repository.completedForTask(task.id)).settlementMonth).toBe('2026-08');
  });
  it('stable pagination and unavailable PDFs return the agreed contract', async () => {
    const runtime = make(),
      actor = { id: 'pagination', artistIds: '*' } as const;
    for (let i = 0; i < 3; i++)
      await runtime.service.generate(
        { artistId, period: 'current_month', format: 'pdf' },
        randomUUID(),
        actor,
      );
    const first = await runtime.repository.listReports({ artistId, limit: 2 }, actor),
      second = await runtime.repository.listReports(
        { artistId, limit: 2, cursor: first.nextCursor },
        actor,
      );
    expect(new Set([...first.items, ...second.items].map((x) => x.reportId)).size).toBe(3);
    await expect(
      runtime.repository.listReports({ artistId: otherId, cursor: first.nextCursor }, actor),
    ).rejects.toMatchObject({ status: 400 });
    now = new Date('2027-09-18T00:00:00Z');
    await request(createApp(runtime)).get(first.items[0]!.pdfFileReference).expect(410);
  });
});
