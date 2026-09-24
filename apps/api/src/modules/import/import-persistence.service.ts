import { createHash } from 'node:crypto';

import { database } from '@cornven/database';
import type { CanonicalSale } from '@cornven/contracts';

export interface PersistImportBatchInput {
  sourceFileName?: string;
  /** Raw file bytes or a stable representation, used to compute the batch checksum. */
  fileContent: string;
  records: CanonicalSale[];
  /** Per-row failures M2's validation already identified before calling this. */
  failedRows: Array<{
    rowNumber?: number;
    field?: string;
    code: string;
    message: string;
    rawValue?: unknown;
  }>;
}

export interface PersistImportBatchResult {
  batchId: string;
  // The database has no "partially imported" status -- a batch with at
  // least one successful row is IMPORTED; per-row failures are recorded
  // separately in ImportError, not reflected in this top-level status.
  status: 'IMPORTED' | 'FAILED';
  totalRows: number;
  validRows: number;
  invalidRows: number;
}

function toDbRecordType(recordType: 'sale' | 'refund'): 'SALE' | 'REFUND' {
  return recordType === 'sale' ? 'SALE' : 'REFUND';
}

function toCents(value: number): bigint {
  return BigInt(Math.round(value));
}

/**
 * Persists a batch of already-validated Canonical Sale records (M2's
 * output) into the database, along with any per-row failures M2 already
 * identified during its own validation. This function does not perform
 * CSV parsing, field validation, or normalization -- that is M2's
 * responsibility. It only owns the write path: ImportBatch, Sale,
 * RawPosRecord, and ImportError.
 *
 * Money fields on CanonicalSale (grossSalesCents etc.) are expected to
 * already be integer cents, per the shared contract.
 */
export async function persistImportBatch(
  input: PersistImportBatchInput,
): Promise<PersistImportBatchResult> {
  const checksum = createHash('sha256').update(input.fileContent).digest('hex');
  const totalRows = input.records.length + input.failedRows.length;
  const validRows = input.records.length;
  const invalidRows = input.failedRows.length;

  const status: PersistImportBatchResult['status'] = validRows === 0 ? 'FAILED' : 'IMPORTED';

  const result = await database.$transaction(async (tx) => {
    const batch = await tx.importBatch.upsert({
      where: { checksum },
      update: {},
      create: {
        source: 'CSV',
        status,
        sourceFileName: input.sourceFileName ?? null,
        checksum,
        totalRows,
        validRows,
        invalidRows,
      },
    });

    const saleIdByTransactionId = new Map<string, string>();

    // Sales before refunds, so a refund can always find its parent's id --
    // same ordering rule as seed.ts, for the same reason.
    const sales = [...input.records].sort((a, b) =>
      a.recordType === b.recordType ? 0 : a.recordType === 'sale' ? -1 : 1,
    );

    for (const record of sales) {
      const dbRecordType = toDbRecordType(record.recordType);
      const parentSaleId =
        record.recordType === 'refund' && record.parentTransactionId
          ? (saleIdByTransactionId.get(record.parentTransactionId) ?? null)
          : null;

      const sale = await tx.sale.upsert({
        where: { dedupeKey: record.sourceTransactionId },
        update: {},
        create: {
          dedupeKey: record.sourceTransactionId,
          sourceRecordId: record.sourceRecordId,
          sourceTransactionId: record.sourceTransactionId,
          importBatchId: batch.id,
          artistId: record.artistId,
          venueId: record.venueId,
          productId: record.productId,
          rentalId: record.rentalId,
          cubeExternalRef: record.cubeId ?? null,
          recordType: dbRecordType,
          parentSaleId,
          soldAt: new Date(record.soldAt),
          quantitySold: record.quantitySold,
          unitPriceCents: toCents(record.unitPriceCents),
          grossSalesCents: toCents(record.grossSalesCents),
          refundAmountCents: 0n,
          sourceCommissionAmountCents: toCents(record.sourceCommissionAmountCents),
          sourceTenantAmountCents: toCents(record.sourceTenantAmountCents),
          rentalCommissionBps: record.rentalCommissionBps,
          cubeCommissionBps: record.cubeCommissionBps ?? null,
          currency: record.currency,
        },
      });

      saleIdByTransactionId.set(record.sourceTransactionId, sale.id);
    }

    if (input.failedRows.length > 0) {
      await tx.importError.createMany({
        data: input.failedRows.map((row) => ({
          importBatchId: batch.id,
          rowNumber: row.rowNumber ?? null,
          field: row.field ?? null,
          code: row.code,
          message: row.message,
          rawValue: row.rawValue as never,
        })),
      });
    }

    return batch;
  });

  return {
    batchId: result.id,
    status,
    totalRows,
    validRows,
    invalidRows,
  };
}
