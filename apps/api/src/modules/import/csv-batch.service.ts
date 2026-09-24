import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CsvBatchUploadSchema,
  CsvBatchSchema,
  CsvBatchListSchema,
  CsvBatchListQuerySchema,
  type CsvBatch,
  type CsvBatchIssue,
  type CsvBatchUpload,
  type CanonicalSale,
  type RawPosRecord,
} from '@cornven/contracts';
import type { Prisma, PrismaClient } from '@cornven/database';
import { ReportError } from '../../shared/report-errors.js';
import { RequestValidationError } from '../../shared/errors.js';
import { inspectCsvRows } from './import.csv.js';
import { normalizeRawPosRecords } from './import.service.js';

type Tx = Prisma.TransactionClient;
type StoredSale = Prisma.SaleGetPayload<{ include: { parentSale: true } }>;
type Row = {
  lineNumber: number;
  columns: Record<string, string>;
  raw: RawPosRecord;
  artistId: string;
  venueId: string;
  productId: string;
  artistName: string;
  productName: string;
  canonical: CanonicalSale | null;
  duplicate: boolean;
  existingSaleId?: string;
  fingerprint: string;
};
type Validation = { totalRows: number; rows: Row[]; issues: CsvBatchIssue[] };
const MetadataSchema = z.object({
  kind: z.literal('csv-batch-v1'),
  upload: CsvBatchUploadSchema,
  detail: CsvBatchSchema,
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function comparable(record: CanonicalSale) {
  return JSON.stringify([
    record.recordType,
    record.sourceRecordId,
    record.sourceTransactionId,
    record.parentTransactionId ?? null,
    record.artistId,
    record.venueId,
    record.productId,
    record.rentalId,
    new Date(record.soldAt).toISOString(),
    record.quantitySold,
    record.unitPriceCents,
    record.grossSalesCents,
    record.sourceCommissionAmountCents,
    record.sourceTenantAmountCents,
    record.rentalCommissionBps,
    record.cubeId ?? null,
    record.cubeCommissionBps ?? null,
    record.currency,
  ]);
}
function fromStored(row: StoredSale): CanonicalSale {
  const integer = (value: bigint) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('Unsafe stored money');
    return number;
  };
  return {
    recordType: row.recordType === 'SALE' ? 'sale' : 'refund',
    sourceRecordId: row.sourceRecordId,
    sourceTransactionId: row.sourceTransactionId,
    parentTransactionId: row.parentSale?.sourceTransactionId ?? null,
    artistId: row.artistId,
    artistName: '',
    venueId: row.venueId,
    venueName: '',
    productId: row.productId,
    productName: '',
    rentalId: row.rentalId,
    soldAt: row.soldAt.toISOString(),
    quantitySold: row.quantitySold,
    unitPriceCents: integer(row.unitPriceCents),
    grossSalesCents: integer(row.grossSalesCents),
    sourceCommissionAmountCents: integer(row.sourceCommissionAmountCents),
    sourceTenantAmountCents: integer(row.sourceTenantAmountCents),
    rentalCommissionBps: row.rentalCommissionBps,
    ...(row.cubeCommissionBps === null ? {} : { cubeCommissionBps: row.cubeCommissionBps }),
    ...(row.cubeExternalRef === null ? {} : { cubeId: row.cubeExternalRef }),
    currency: row.currency,
  };
}
function fail(field: string, message: string): never {
  throw new RequestValidationError(message, field);
}

/** Local Plan B import workflow. No user authentication is introduced in this phase.
 * Confirmation revalidates saved input and commits all business rows atomically.
 * A transaction-level lock serializes confirmations, including cumulative refunds.
 */
export class CsvBatchService {
  constructor(private readonly db: PrismaClient) {}

  private async lock(tx: Tx) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(5703, 101)::text`;
  }

  private async validate(tx: Tx, upload: CsvBatchUpload): Promise<Validation> {
    let inspected;
    try {
      inspected = inspectCsvRows(upload.csv);
    } catch (error) {
      if (!(error instanceof RequestValidationError)) throw error;
      return {
        totalRows: 0,
        rows: [],
        issues: [
          { lineNumber: null, field: error.field, code: 'CSV_INVALID', reason: error.message },
        ],
      };
    }
    if (inspected.rows.length > 1000)
      return {
        totalRows: inspected.rows.length,
        rows: [],
        issues: [
          {
            lineNumber: null,
            field: 'file',
            code: 'TOO_MANY_ROWS',
            reason: 'At most 1,000 rows may be imported per batch.',
          },
        ],
      };
    const issues: CsvBatchIssue[] = inspected.errors.map((error) => ({ ...error }));
    const rows: Row[] = [];
    const transactionIds = new Set<string>();
    const issue = (
      row: { lineNumber: number },
      field: string,
      reason: string,
      code = 'ROW_INVALID',
    ) => {
      issues.push({ lineNumber: row.lineNumber, field, reason, code });
    };
    for (const input of inspected.rows) {
      if (!input.record) continue;
      const raw = input.record;
      try {
        if (transactionIds.has(raw.sourceTransactionId))
          fail('sourceTransactionId', 'Transaction IDs must be unique within a file.');
        transactionIds.add(raw.sourceTransactionId);
        if (raw.currency !== 'TWD')
          fail('currency', 'Only TWD is supported by the settlement calculator.');
        const artist = await tx.artist.findUnique({ where: { externalRef: raw.artistId } });
        if (!artist) fail('artistId', 'Unknown artist reference: ' + raw.artistId);
        const venue = await tx.venue.findUnique({ where: { externalRef: raw.venueId } });
        if (!venue) fail('venueId', 'Unknown venue reference: ' + raw.venueId);
        const byRef = await tx.product.findUnique({ where: { externalRef: raw.productId } });
        const bySku = raw.sku
          ? await tx.product.findUnique({
              where: { artistId_sku: { artistId: artist.id, sku: raw.sku } },
            })
          : null;
        if (byRef && bySku && byRef.id !== bySku.id)
          fail('productId', 'Product reference and SKU identify different products.');
        const product = byRef ?? bySku;
        if (!product || product.artistId !== artist.id)
          fail(
            'productId',
            'Product must exist for this artist (external reference or artist-scoped SKU).',
          );
        if (raw.sku && product.sku !== raw.sku)
          fail('sku', 'SKU does not match the selected product.');
        const normalized = normalizeRawPosRecords([raw], upload.commissionRateUnit);
        const canonical = normalized.records[0] ?? null;
        if (canonical) {
          const rental = await tx.rental.findUnique({ where: { externalRef: canonical.rentalId } });
          if (!rental || rental.artistId !== artist.id || rental.venueId !== venue.id)
            fail('rentalId', 'Rental must belong to the selected artist and venue.');
          if (
            raw.recordType === 'sale' &&
            (new Date(raw.occurredAt) < rental.effectiveFrom ||
              (rental.effectiveTo && new Date(raw.occurredAt) >= rental.effectiveTo))
          )
            fail('occurredAt', 'Sale date is outside the rental period.');
          Object.assign(canonical, {
            artistId: artist.id,
            artistName: artist.name,
            venueId: venue.id,
            venueName: venue.name,
            productId: product.id,
            productName: product.name,
            rentalId: rental.id,
          });
        }
        rows.push({
          lineNumber: input.lineNumber,
          columns: input.columns,
          raw,
          artistId: artist.id,
          artistName: artist.name,
          venueId: venue.id,
          productId: product.id,
          productName: product.name,
          canonical,
          duplicate: false,
          fingerprint: '',
        });
      } catch (error) {
        if (error instanceof RequestValidationError) issue(input, error.field, error.message);
        else if (error instanceof z.ZodError)
          issue(
            input,
            error.issues[0]?.path.join('.') ?? 'record',
            error.issues[0]?.message ?? 'Invalid normalized record.',
          );
        else throw error;
      }
    }
    const originals = new Map<string, CanonicalSale>();
    for (const row of rows)
      if (row.canonical?.recordType === 'sale')
        originals.set(row.raw.sourceTransactionId, row.canonical);
    for (const row of rows) {
      const record = row.canonical;
      if (record?.recordType !== 'refund') continue;
      let parent = originals.get(record.parentTransactionId!);
      if (!parent) {
        const matches = await tx.sale.findMany({
          where: { sourceTransactionId: record.parentTransactionId! },
          include: { parentSale: true },
          take: 2,
        });
        if (matches.length !== 1 || matches[0]!.recordType !== 'SALE') {
          issue(
            row,
            'parentTransactionId',
            'Original sale was not found unambiguously in this file or the database.',
            'PARENT_SALE_NOT_FOUND',
          );
          continue;
        }
        parent = fromStored(matches[0]!);
        originals.set(record.parentTransactionId!, parent);
      }
      if (
        parent.artistId !== record.artistId ||
        parent.productId !== record.productId ||
        parent.venueId !== record.venueId ||
        parent.rentalId !== record.rentalId ||
        parent.currency !== record.currency
      ) {
        issue(
          row,
          'parentTransactionId',
          'Refund ownership, product, rental and currency must match the original sale.',
        );
        continue;
      }
      if (
        new Date(record.soldAt) < new Date(parent.soldAt) ||
        record.unitPriceCents !== parent.unitPriceCents
      ) {
        issue(
          row,
          'parentTransactionId',
          'Refund cannot predate its sale and must retain the original unit price.',
        );
        continue;
      }
      record.rentalCommissionBps = parent.rentalCommissionBps;
      if (parent.cubeCommissionBps === undefined) delete record.cubeCommissionBps;
      else record.cubeCommissionBps = parent.cubeCommissionBps;
    }
    // Overlapping files are allowed only when the stored semantic record is identical.
    for (const row of rows) {
      if (issues.some((error) => error.lineNumber === row.lineNumber)) continue;
      const existing = await tx.sale.findMany({
        where: {
          OR: [
            { sourceTransactionId: row.raw.sourceTransactionId },
            { sourceRecordId: row.raw.sourceRecordId },
          ],
        },
        include: { parentSale: true },
        take: 2,
      });
      const audits = await tx.rawPosRecord.findMany({
        where: {
          importBatch: { status: 'IMPORTED' },
          recordType: 'EXCHANGE',
          OR: [
            { sourceTransactionId: row.raw.sourceTransactionId },
            { sourceRecordId: row.raw.sourceRecordId },
          ],
        },
        select: { checksum: true },
      });
      row.fingerprint = hash(
        row.canonical
          ? comparable(row.canonical)
          : JSON.stringify([
              'exchange',
              row.raw.sourceRecordId,
              row.raw.sourceTransactionId,
              row.raw.parentTransactionId ?? null,
              row.artistId,
              row.venueId,
              row.productId,
              row.raw.quantity,
              new Date(row.raw.occurredAt).toISOString(),
              row.raw.currency,
            ]),
      );
      if (
        row.canonical &&
        existing.length === 1 &&
        comparable(fromStored(existing[0]!)) === comparable(row.canonical) &&
        audits.length === 0
      ) {
        row.duplicate = true;
        row.existingSaleId = existing[0]!.id;
      } else if (
        !row.canonical &&
        existing.length === 0 &&
        audits.length > 0 &&
        audits.every((audit) => audit.checksum === row.fingerprint)
      ) {
        row.duplicate = true;
      } else if (existing.length > 0 || audits.length > 0)
        issue(
          row,
          'sourceTransactionId',
          'This transaction or source record ID already exists with different content.',
          'DUPLICATE_CONFLICT',
        );
    }
    // Include previously imported refunds as well as every new refund in this batch.
    const totals = new Map<string, { amount: bigint; quantity: bigint }>();
    for (const row of rows) {
      const record = row.canonical;
      if (
        record?.recordType !== 'refund' ||
        row.duplicate ||
        issues.some((error) => error.lineNumber === row.lineNumber)
      )
        continue;
      const key = record.parentTransactionId!;
      let total = totals.get(key);
      if (!total) {
        const prior = await tx.sale.aggregate({
          where: { recordType: 'REFUND', parentSale: { sourceTransactionId: key } },
          _sum: { grossSalesCents: true, quantitySold: true },
        });
        total = {
          amount: -(prior._sum.grossSalesCents ?? 0n),
          quantity: -BigInt(prior._sum.quantitySold ?? 0),
        };
        totals.set(key, total);
      }
      total.amount -= BigInt(record.grossSalesCents);
      total.quantity -= BigInt(record.quantitySold);
      const parent = originals.get(key)!;
      if (
        total.amount > BigInt(parent.grossSalesCents) ||
        total.quantity > BigInt(parent.quantitySold)
      )
        issue(
          row,
          'parentTransactionId',
          'Cumulative refunds exceed the original sale amount or quantity.',
          'REFUND_EXCEEDS_SALE',
        );
    }
    return { totalRows: inspected.rows.length, rows, issues };
  }

  private detail(
    id: string,
    createdAt: Date,
    upload: CsvBatchUpload,
    checked: Validation,
    imported = false,
  ): CsvBatch {
    const invalidRows = checked.issues.some((issue) => issue.lineNumber === null)
      ? checked.totalRows
      : new Set(checked.issues.map((issue) => issue.lineNumber)).size;
    return CsvBatchSchema.parse({
      id,
      fileName: upload.fileName,
      status: imported ? 'IMPORTED' : checked.issues.length ? 'FAILED' : 'VALIDATED',
      commissionRateUnit: upload.commissionRateUnit,
      createdAt: createdAt.toISOString(),
      confirmedAt: imported ? new Date().toISOString() : null,
      totalRows: checked.totalRows,
      validRows: Math.max(0, checked.totalRows - invalidRows),
      invalidRows,
      summary: {
        saleRows: checked.rows.filter((row) => row.raw.recordType === 'sale').length,
        refundRows: checked.rows.filter((row) => row.raw.recordType === 'refund').length,
        exchangeRows: checked.rows.filter((row) => row.raw.recordType === 'exchange').length,
        newRecords: checked.rows.filter((row) => row.canonical && !row.duplicate).length,
        duplicateRecords: checked.rows.filter((row) => row.canonical && row.duplicate).length,
        newExchanges: checked.rows.filter((row) => !row.canonical && !row.duplicate).length,
        duplicateExchanges: checked.rows.filter((row) => !row.canonical && row.duplicate).length,
      },
      issues: checked.issues,
      preview: checked.rows.slice(0, 100).map((row) => ({
        lineNumber: row.lineNumber,
        recordType: row.raw.recordType,
        sourceTransactionId: row.raw.sourceTransactionId,
        artistName: row.artistName,
        productName: row.productName,
        occurredAt: new Date(row.raw.occurredAt).toISOString(),
        grossSalesCents: row.canonical?.grossSalesCents ?? null,
        duplicate: row.duplicate,
      })),
    });
  }

  private async save(tx: Tx, upload: CsvBatchUpload, detail: CsvBatch) {
    await tx.importBatch.update({
      where: { id: detail.id },
      data: {
        status: detail.status,
        totalRows: detail.totalRows,
        validRows: detail.validRows,
        invalidRows: detail.invalidRows,
        metadata: json({ kind: 'csv-batch-v1', upload, detail }),
      },
    });
    await tx.importError.deleteMany({ where: { importBatchId: detail.id } });
    if (detail.issues.length)
      await tx.importError.createMany({
        data: detail.issues.map((issue) => ({
          importBatchId: detail.id,
          rowNumber: issue.lineNumber,
          field: issue.field,
          code: issue.code,
          message: issue.reason,
        })),
      });
  }

  async upload(input: unknown, requestId: string) {
    const upload = CsvBatchUploadSchema.parse(input);
    if (Buffer.byteLength(upload.csv, 'utf8') > 512_000)
      throw new ReportError(413, 'CSV_TOO_LARGE', 'CSV files are limited to 500 KB.');
    const checksum = hash(JSON.stringify(['csv-batch-v1', upload.commissionRateUnit, upload.csv]));
    return this.db.$transaction(
      async (tx) => {
        await this.lock(tx);
        const batch = await tx.importBatch.upsert({
          where: { checksum },
          update: {},
          create: {
            source: 'CSV',
            sourceFileName: upload.fileName,
            checksum,
          },
        });
        if (batch.status === 'IMPORTED') return MetadataSchema.parse(batch.metadata).detail;
        const detail = this.detail(
          batch.id,
          batch.createdAt,
          upload,
          await this.validate(tx, upload),
        );
        await this.save(tx, upload, detail);
        await tx.auditEvent.create({
          data: {
            actorType: 'local-demo',
            module: 'import',
            action: 'CSV_VALIDATED',
            entityType: 'ImportBatch',
            entityId: batch.id,
            requestId,
            result: detail.status,
          },
        });
        return detail;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
  }

  async confirm(id: string, requestId: string) {
    return this.db.$transaction(
      async (tx) => {
        await this.lock(tx);
        const batch = await tx.importBatch.findUnique({ where: { id } });
        const stored = MetadataSchema.safeParse(batch?.metadata);
        if (!batch || !stored.success)
          throw new ReportError(404, 'IMPORT_NOT_FOUND', 'CSV batch not found.');
        if (batch.status === 'IMPORTED') return stored.data.detail;
        const upload = stored.data.upload;
        const checked = await this.validate(tx, upload);
        if (checked.issues.length) {
          const detail = this.detail(id, batch.createdAt, upload, checked);
          await this.save(tx, upload, detail);
          return detail;
        }
        const saleIds = new Map<string, string>();
        const ordered = [...checked.rows].sort(
          (a, b) => Number(a.raw.recordType !== 'sale') - Number(b.raw.recordType !== 'sale'),
        );
        for (const row of ordered) {
          const record = row.canonical;
          let saleId = row.existingSaleId ?? null;
          if (record && !row.duplicate) {
            let parentSaleId: string | null = null;
            if (record.recordType === 'refund') {
              parentSaleId =
                saleIds.get(record.parentTransactionId!) ??
                (
                  await tx.sale.findFirst({
                    where: { sourceTransactionId: record.parentTransactionId!, recordType: 'SALE' },
                    select: { id: true },
                  })
                )?.id ??
                null;
              if (!parentSaleId) throw new Error('Validated parent sale disappeared.');
            }
            const sale = await tx.sale.create({
              data: {
                dedupeKey: record.sourceTransactionId,
                sourceRecordId: record.sourceRecordId,
                sourceTransactionId: record.sourceTransactionId,
                importBatchId: id,
                artistId: record.artistId,
                venueId: record.venueId,
                productId: record.productId,
                rentalId: record.rentalId,
                recordType: record.recordType === 'sale' ? 'SALE' : 'REFUND',
                parentSaleId,
                soldAt: new Date(record.soldAt),
                quantitySold: record.quantitySold,
                unitPriceCents: BigInt(record.unitPriceCents),
                grossSalesCents: BigInt(record.grossSalesCents),
                sourceCommissionAmountCents: BigInt(record.sourceCommissionAmountCents),
                sourceTenantAmountCents: BigInt(record.sourceTenantAmountCents),
                rentalCommissionBps: record.rentalCommissionBps,
                cubeCommissionBps: record.cubeCommissionBps ?? null,
                cubeExternalRef: record.cubeId ?? null,
                currency: record.currency,
              },
            });
            saleId = sale.id;
          }
          if (saleId) saleIds.set(row.raw.sourceTransactionId, saleId);
          const rawRecord = await tx.rawPosRecord.create({
            data: {
              importBatchId: id,
              sourceRecordId: row.raw.sourceRecordId,
              sourceTransactionId: row.raw.sourceTransactionId,
              parentTransactionId: row.raw.parentTransactionId ?? null,
              recordType:
                row.raw.recordType === 'sale'
                  ? 'SALE'
                  : row.raw.recordType === 'refund'
                    ? 'REFUND'
                    : 'EXCHANGE',
              canonicalSaleId: saleId,
              quantity: row.raw.quantity,
              occurredAt: new Date(row.raw.occurredAt),
              unitPriceCents: record ? BigInt(record.unitPriceCents) : null,
              totalAmountCents: record ? BigInt(record.grossSalesCents) : null,
              commissionAmountCents: record ? BigInt(record.sourceCommissionAmountCents) : null,
              tenantAmountCents: record ? BigInt(record.sourceTenantAmountCents) : null,
              rentalExternalRef: row.raw.recordType === 'exchange' ? null : row.raw.rentalId,
              cubeExternalRef: row.raw.recordType === 'exchange' ? null : (row.raw.cubeId ?? null),
              rentalRateRaw:
                row.raw.recordType === 'exchange' ? null : row.raw.rentalCommissionRate,
              cubeRateRaw:
                row.raw.recordType === 'exchange' ? null : (row.raw.cubeCommissionRate ?? null),
              checksum: row.fingerprint,
              rawPayload: json({ columns: row.columns, record: row.raw }),
              status: 'NORMALIZED',
            },
          });
          if (!record && !row.duplicate)
            await tx.auditEvent.create({
              data: {
                actorType: 'local-demo',
                module: 'import',
                action: 'EXCHANGE_RECORDED',
                entityType: 'RawPosRecord',
                entityId: rawRecord.id,
                requestId,
                result: 'RECORDED',
              },
            });
        }
        const detail = this.detail(id, batch.createdAt, upload, checked, true);
        await this.save(tx, upload, detail);
        await tx.auditEvent.create({
          data: {
            actorType: 'local-demo',
            module: 'import',
            action: 'CSV_IMPORTED',
            entityType: 'ImportBatch',
            entityId: id,
            requestId,
            result: 'IMPORTED',
            metadata: json(detail.summary),
          },
        });
        return detail;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
  }

  async get(id: string) {
    const batch = await this.db.importBatch.findUnique({ where: { id } });
    const metadata = MetadataSchema.safeParse(batch?.metadata);
    if (!metadata.success) throw new ReportError(404, 'IMPORT_NOT_FOUND', 'CSV batch not found.');
    return metadata.data.detail;
  }

  async list(input: unknown) {
    const query = CsvBatchListQuerySchema.parse(input);
    const where: Prisma.ImportBatchWhereInput = {
      metadata: { path: ['kind'], equals: 'csv-batch-v1' },
      ...(query.status ? { status: query.status } : {}),
    };
    if (query.before) {
      const cursor = await this.db.importBatch.findFirst({ where: { ...where, id: query.before } });
      if (!cursor)
        throw new ReportError(
          400,
          'INVALID_CURSOR',
          'Import history cursor does not match this filter.',
        );
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const batches = await this.db.importBatch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const selected = batches.slice(0, query.limit);
    return CsvBatchListSchema.parse({
      items: selected.map((batch) => MetadataSchema.parse(batch.metadata).detail),
      nextCursor: batches.length > query.limit ? selected.at(-1)!.id : null,
    });
  }
}
