import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@cornven/database';
import { CsvBatchSchema, SettlementPreviewInputSchema } from '@cornven/contracts';
import { CsvBatchService } from '../src/modules/import/csv-batch.service.js';
import { DatabaseMonthlyReportContext } from '../src/modules/import/database-monthly-report-context.service.js';
import { calculateSettlementPreview } from '../src/modules/settlement/settlement.service.js';
import { createApp } from '../src/app.js';
import { createReportRuntime } from '../src/modules/reporting/report-runtime.js';

const enabled =
  process.env.RUN_REPORT_INTEGRATION === 'true' &&
  process.env.DATABASE_URL?.includes('/cornven_planb_import_test');
const db = new PrismaClient();
const prefix = 'csv-phase1-' + randomUUID();
const refs = {
  artist: prefix + '-artist',
  venue: prefix + '-venue',
  product: prefix + '-product',
  rental: prefix + '-rental',
  sku: prefix + '-sku',
};
const headers =
  'recordType,sourceRecordId,sourceTransactionId,parentTransactionId,artistId,artistName,venueId,venueName,productId,sku,productName,occurredAt,quantity,unitPrice,totalAmount,commissionAmount,tenantAmount,rentalId,rentalCommissionRate,cubeId,cubeCommissionRate,currency'.split(
    ',',
  );
function row(key: string, extra: Record<string, string> = {}) {
  return {
    recordType: 'sale',
    sourceRecordId: prefix + '-src-' + key,
    sourceTransactionId: prefix + '-tx-' + key,
    parentTransactionId: '',
    artistId: refs.artist,
    artistName: 'CSV name',
    venueId: refs.venue,
    venueName: 'CSV venue',
    productId: refs.product,
    sku: refs.sku,
    productName: 'CSV product',
    occurredAt: '2026-08-20T04:00:00.000Z',
    quantity: '2',
    unitPrice: '50.00',
    totalAmount: '100.00',
    commissionAmount: '25.00',
    tenantAmount: '75.00',
    rentalId: refs.rental,
    rentalCommissionRate: '0.25',
    cubeId: '',
    cubeCommissionRate: '',
    currency: 'TWD',
    ...extra,
  };
}
function refund(key: string, parent = 'sale', extra: Record<string, string> = {}) {
  return row(key, {
    recordType: 'refund',
    parentTransactionId: prefix + '-tx-' + parent,
    occurredAt: '2026-09-01T04:00:00.000Z',
    quantity: '-1',
    totalAmount: '-50.00',
    commissionAmount: '-42.50',
    tenantAmount: '-7.50',
    rentalCommissionRate: '0.85',
    ...extra,
  });
}
function csv(rows: Record<string, string>[]) {
  return (
    headers.join(',') +
    '\n' +
    rows.map((item) => headers.map((key) => item[key] ?? '').join(',')).join('\n') +
    '\n'
  );
}
function upload(rows: Record<string, string>[], name = 'sample.csv') {
  return { csv: csv(rows), fileName: prefix + name, commissionRateUnit: 'fraction' };
}

describe.skipIf(!enabled)('CSV upload → confirm → reporting on isolated PostgreSQL', () => {
  let service: CsvBatchService;
  let artistId: string;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'csv-phase1-pdf-'));
    const artist = await db.artist.create({
      data: { externalRef: refs.artist, name: 'Import test artist' },
    });
    artistId = artist.id;
    const venue = await db.venue.create({
      data: { externalRef: refs.venue, name: 'Import test venue' },
    });
    await db.product.create({
      data: { externalRef: refs.product, sku: refs.sku, name: 'Import test cup', artistId },
    });
    await db.rental.create({
      data: {
        externalRef: refs.rental,
        artistId,
        venueId: venue.id,
        commissionBps: 2500,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
    service = new CsvBatchService(db);
  });
  async function clean() {
    const batches = await db.importBatch.findMany({
      where: { sourceFileName: { startsWith: prefix } },
      select: { id: true },
    });
    const ids = batches.map((batch) => batch.id);
    await db.auditEvent.deleteMany({
      where: { OR: [{ entityId: { in: ids } }, { requestId: { startsWith: prefix } }] },
    });
    await db.rawPosRecord.deleteMany({ where: { importBatchId: { in: ids } } });
    await db.sale.deleteMany({ where: { importBatchId: { in: ids } } });
    await db.importBatch.deleteMany({ where: { id: { in: ids } } });
  }
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const trace = () => prefix + randomUUID();
  async function imported(rows: Record<string, string>[]) {
    const batch = await service.upload(upload(rows), trace());
    expect(batch.issues).toEqual([]);
    return service.confirm(batch.id, trace());
  }

  it('persists preview, imports only on confirmation, and survives service recreation', async () => {
    const batch = await service.upload(upload([row('sale')]), trace());
    expect(batch.status).toBe('VALIDATED');
    expect(await db.sale.count({ where: { artistId } })).toBe(0);
    expect(await new CsvBatchService(db).get(batch.id)).toEqual(batch);
    const confirmed = await service.confirm(batch.id, trace());
    expect(confirmed.status).toBe('IMPORTED');
    const stored = await db.sale.findFirstOrThrow({ where: { artistId } });
    expect(stored.artistId).toBe(artistId);
    expect(stored.grossSalesCents).toBe(10000n);
    expect(await db.rawPosRecord.count({ where: { importBatchId: batch.id } })).toBe(1);
    const metadata = (await db.importBatch.findUniqueOrThrow({ where: { id: batch.id } }))
      .metadata as { upload: { csv: string } };
    expect(metadata.upload.csv).toBe(upload([row('sale')]).csv);
  });

  it('repeated upload and concurrent confirmation create one sale and one import event', async () => {
    const input = upload([row('sale')]);
    const [first, again] = await Promise.all([
      service.upload(input, trace()),
      service.upload({ ...input, fileName: prefix + 'renamed.csv' }, trace()),
    ]);
    expect(first.id).toBe(again.id);
    const results = await Promise.all([
      service.confirm(first.id, trace()),
      service.confirm(first.id, trace()),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.sale.count({ where: { artistId } })).toBe(1);
    expect(
      await db.auditEvent.count({ where: { action: 'CSV_IMPORTED', entityId: first.id } }),
    ).toBe(1);
    expect((await service.upload(input, trace())).status).toBe('IMPORTED');
  });

  it('stores validation failures without importing any valid sibling rows', async () => {
    const batch = await service.upload(
      upload([row('sale'), row('bad', { artistId: 'UNKNOWN-ARTIST' })]),
      trace(),
    );
    expect(batch.status).toBe('FAILED');
    expect(batch.issues).toEqual([expect.objectContaining({ lineNumber: 3, field: 'artistId' })]);
    expect((await service.confirm(batch.id, trace())).status).toBe('FAILED');
    expect(await db.sale.count({ where: { artistId } })).toBe(0);
    expect(await db.importError.count({ where: { importBatchId: batch.id } })).toBe(1);
  });

  it('stores syntax and row errors durably and rejects ambiguous duplicate headers', async () => {
    const malformed = await service.upload(
      { ...upload([]), csv: 'recordType,recordType\nsale,sale' },
      trace(),
    );
    expect(malformed.status).toBe('FAILED');
    expect(malformed.issues[0]?.field).toBe('file');
    const invalid = await service.upload(
      upload([refund('bad', 'missing', { totalAmount: '50.00' })]),
      trace(),
    );
    expect(invalid.status).toBe('FAILED');
    expect(invalid.issues[0]?.lineNumber).toBe(2);
    expect(await new CsvBatchService(db).get(invalid.id)).toEqual(invalid);
  });

  it('links cross-file refunds to original sales and keeps their historical rate', async () => {
    await imported([row('sale')]);
    const batch = await imported([refund('refund')]);
    expect(batch.status).toBe('IMPORTED');
    const sale = await db.sale.findFirstOrThrow({ where: { artistId, recordType: 'SALE' } });
    const returned = await db.sale.findFirstOrThrow({ where: { artistId, recordType: 'REFUND' } });
    expect(returned.parentSaleId).toBe(sale.id);
    expect(returned.rentalCommissionBps).toBe(2500);
    const context = await new DatabaseMonthlyReportContext(db).getMonthlyReportContext({
      artistId,
      settlementMonth: '2026-09',
      asOf: '2026-09-20T00:00:00Z',
    });
    const result = calculateSettlementPreview(
      SettlementPreviewInputSchema.parse({
        ...context,
        settlementMonth: '2026-09',
        asOf: '2026-09-20T00:00:00Z',
      }),
    );
    expect(result.creatorRevenueShareAmountCents).toBe(-3750);
  });

  it('handles refund rows before their original sale within one file', async () => {
    const result = await imported([refund('refund'), row('sale')]);
    expect(result.summary.newRecords).toBe(2);
    expect(await db.sale.count({ where: { artistId, parentSaleId: { not: null } } })).toBe(1);
  });

  it('rejects orphan refunds, wrong-product refunds and excessive cumulative refunds', async () => {
    expect((await service.upload(upload([refund('orphan')]), trace())).issues[0]?.code).toBe(
      'PARENT_SALE_NOT_FOUND',
    );
    await imported([row('sale')]);
    const product = await db.product.create({
      data: {
        externalRef: prefix + randomUUID(),
        sku: prefix + randomUUID(),
        name: 'Other cup',
        artistId,
      },
    });
    const wrong = await service.upload(
      upload([refund('wrong', 'sale', { productId: product.externalRef!, sku: product.sku! })]),
      trace(),
    );
    expect(wrong.status).toBe('FAILED');
    await imported([refund('r1'), refund('r2')]);
    const excess = await service.upload(upload([refund('r3')]), trace());
    expect(excess.issues[0]?.code).toBe('REFUND_EXCEEDS_SALE');
  });

  it('revalidates at confirmation so concurrent refund batches cannot over-refund', async () => {
    await imported([
      row('sale', {
        quantity: '1',
        totalAmount: '50.00',
        commissionAmount: '12.50',
        tenantAmount: '37.50',
      }),
    ]);
    const a = await service.upload(upload([refund('a')]), trace());
    const b = await service.upload(upload([refund('b')]), trace());
    expect(a.status).toBe('VALIDATED');
    expect(b.status).toBe('VALIDATED');
    const results = await Promise.all([
      service.confirm(a.id, trace()),
      service.confirm(b.id, trace()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['FAILED', 'IMPORTED']);
    expect(await db.sale.count({ where: { artistId, recordType: 'REFUND' } })).toBe(1);
  });

  it('skips exact overlapping transactions but rejects changed content', async () => {
    await imported([row('sale')]);
    const same = await imported([row('sale'), row('new')]);
    expect(same.summary.newRecords).toBe(1);
    expect(same.summary.duplicateRecords).toBe(1);
    const conflict = await service.upload(
      upload([
        row('sale', {
          quantity: '3',
          totalAmount: '150.00',
          commissionAmount: '37.50',
          tenantAmount: '112.50',
        }),
      ]),
      trace(),
    );
    expect(conflict.issues[0]?.code).toBe('DUPLICATE_CONFLICT');
    expect(await db.sale.count({ where: { artistId } })).toBe(2);
  });

  it('records exchanges only in raw/audit storage and deduplicates across files', async () => {
    const exchange = row('exchange', {
      recordType: 'exchange',
      quantity: '1',
      totalAmount: '',
      unitPrice: '',
      commissionAmount: '',
      tenantAmount: '',
      rentalId: '',
      rentalCommissionRate: '',
    });
    const first = await imported([exchange]);
    expect(first.summary.newExchanges).toBe(1);
    expect(await db.sale.count({ where: { artistId } })).toBe(0);
    const second = await imported([exchange, row('sale')]);
    expect(second.summary.duplicateExchanges).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { requestId: { startsWith: prefix }, action: 'EXCHANGE_RECORDED' },
      }),
    ).toBe(1);
  });

  it('maps a missing product reference through an artist-scoped SKU, not another artist', async () => {
    expect(
      (
        await service.upload(
          upload([row('sale', { productId: 'UNMAPPED-SOURCE-PRODUCT' })]),
          trace(),
        )
      ).status,
    ).toBe('VALIDATED');
    expect(
      (
        await service.upload(
          upload([row('bad', { productId: 'UNMAPPED', sku: 'UNMAPPED' })]),
          trace(),
        )
      ).status,
    ).toBe('FAILED');
    const duplicate = await service.upload(
      upload([row('sale'), row('sale', { sourceRecordId: 'ANOTHER-ROW-ID' })]),
      trace(),
    );
    expect(duplicate.status).toBe('FAILED');
    expect(duplicate.issues[0]?.field).toBe('sourceTransactionId');
  });

  it('exposes persistent batch APIs without adding login and rejects client-supplied confirmation content', async () => {
    const runtime = createReportRuntime({
      db,
      storagePath: directory,
      renderer: { render: async () => new TextEncoder().encode('%PDF-test') },
      now: () => new Date('2026-09-20T00:00:00Z'),
      resolveActor: () => ({ id: 'local-demo', artistIds: '*' }),
    });
    const app = createApp(runtime);
    const response = await request(app)
      .post('/api/v1/imports/batches')
      .send(upload([row('sale')]));
    expect(response.status).toBe(201);
    const batch = CsvBatchSchema.parse(response.body);
    expect(
      (
        await request(app)
          .post('/api/v1/imports/batches/' + batch.id + '/confirm')
          .send({ records: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/v1/imports/batches/' + batch.id + '/confirm')
          .send({})
      ).body.status,
    ).toBe('IMPORTED');
    expect((await request(app).get('/api/v1/imports/batches/' + batch.id)).body.id).toBe(batch.id);
    const listed = await request(app).get('/api/v1/imports/batches?status=IMPORTED&limit=100');
    expect(listed.body.items.some((item: { id: string }) => item.id === batch.id)).toBe(true);
    expect((await request(app).get('/api/v1/imports/batches/not-a-uuid')).status).toBe(400);
  });

  it('generates a new saved report from imported data without changing the earlier snapshot', async () => {
    const runtime = createReportRuntime({
      db,
      storagePath: directory,
      renderer: { render: async () => new TextEncoder().encode('%PDF-test') },
      now: () => new Date('2026-09-20T00:00:00Z'),
    });
    const actor = { id: 'local-demo', artistIds: '*' as const };
    const before = await runtime.service.generate(
      { artistId, period: 'current_month', format: 'pdf' },
      randomUUID(),
      actor,
    );
    const old = await runtime.repository.getReport(before.body.reportId, actor);
    await imported([row('sale', { occurredAt: '2026-09-18T00:00:00Z' })]);
    const after = await runtime.service.generate(
      { artistId, period: 'current_month', format: 'pdf' },
      randomUUID(),
      actor,
    );
    const current = await runtime.repository.getReport(after.body.reportId, actor);
    expect(
      (current.reportJson as { financialSummary: { totalProductSalesCents: number } })
        .financialSummary.totalProductSalesCents,
    ).toBe(10000);
    expect((await runtime.repository.getReport(before.body.reportId, actor)).reportJson).toEqual(
      old.reportJson,
    );
  });
});
