import {
  CanonicalSaleSchema,
  type CommissionRateUnit,
  type ImportNormalizationResult,
  type RawPosRecord,
  type RawPosRefundRecord,
  type RawPosSaleRecord,
} from '@cornven/contracts';

import { RequestValidationError } from '../../shared/errors.js';

function parseFixedDecimal(value: string): { numerator: bigint; scale: bigint } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new RequestValidationError(`Invalid decimal value: ${value}`, 'records');
  }

  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;

  return {
    numerator: sign * BigInt(`${match[2]}${fraction}`),
    scale: 10n ** BigInt(fraction.length),
  };
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value);

  if (!Number.isSafeInteger(result)) {
    throw new RequestValidationError(`${label} is outside the safe integer range.`, 'records');
  }

  return result;
}

export function decimalStringToCents(value: string): number {
  const { numerator, scale } = parseFixedDecimal(value);
  const scaled = numerator * 100n;

  if (scaled % scale !== 0n) {
    throw new RequestValidationError(
      `Money value has more than two decimal places: ${value}`,
      'records',
    );
  }

  return safeNumber(scaled / scale, 'Money amount');
}

export function commissionRateToBasisPoints(value: string, unit: CommissionRateUnit): number {
  const { numerator, scale } = parseFixedDecimal(value);
  const multiplier = unit === 'fraction' ? 10_000n : unit === 'percentage' ? 100n : 1n;
  const scaled = numerator * multiplier;

  if (scaled % scale !== 0n) {
    throw new RequestValidationError(
      `Commission rate cannot be represented as whole basis points: ${value}`,
      'commissionRateUnit',
    );
  }

  const basisPoints = safeNumber(scaled / scale, 'Commission rate');

  if (basisPoints < 0 || basisPoints > 10_000) {
    throw new RequestValidationError(
      `Commission rate must be between 0 and 10,000 basis points: ${value}`,
      'commissionRateUnit',
    );
  }

  return basisPoints;
}

function createCanonicalRecord(
  record: RawPosSaleRecord | RawPosRefundRecord,
  commissionRateUnit: CommissionRateUnit,
) {
  return {
    recordType: record.recordType,
    sourceRecordId: record.sourceRecordId,
    sourceTransactionId: record.sourceTransactionId,
    parentTransactionId: record.recordType === 'refund' ? record.parentTransactionId : null,

    artistId: record.artistId,
    artistName: record.artistName,
    venueId: record.venueId,
    venueName: record.venueName,

    productId: record.productId,
    ...(record.sku ? { sku: record.sku } : {}),
    productName: record.productName,

    soldAt: record.occurredAt,
    quantitySold: record.quantity,
    unitPriceCents: decimalStringToCents(record.unitPrice),

    grossSalesCents: decimalStringToCents(record.totalAmount),
    sourceCommissionAmountCents: decimalStringToCents(record.commissionAmount),
    sourceTenantAmountCents: decimalStringToCents(record.tenantAmount),

    rentalId: record.rentalId,
    rentalCommissionBps: commissionRateToBasisPoints(
      record.rentalCommissionRate,
      commissionRateUnit,
    ),

    ...(record.cubeId ? { cubeId: record.cubeId } : {}),
    ...(record.cubeCommissionRate
      ? {
          cubeCommissionBps: commissionRateToBasisPoints(
            record.cubeCommissionRate,
            commissionRateUnit,
          ),
        }
      : {}),

    currency: record.currency,
  };
}

export function normalizeRawPosRecords(
  records: RawPosRecord[],
  commissionRateUnit: CommissionRateUnit,
): ImportNormalizationResult {
  const sourceRecordIds = new Set<string>();

  for (const record of records) {
    if (sourceRecordIds.has(record.sourceRecordId)) {
      throw new RequestValidationError(
        `Duplicate source record ID: ${record.sourceRecordId}.`,
        'records',
      );
    }

    sourceRecordIds.add(record.sourceRecordId);
  }

  // SALE and REFUND are both independent Canonical records.
  // M1 persistence resolves REFUND.parentTransactionId to the internal parentSaleId.
  const canonicalSales = records
    .filter(
      (record): record is RawPosSaleRecord | RawPosRefundRecord =>
        record.recordType === 'sale' || record.recordType === 'refund',
    )
    .map((record) => CanonicalSaleSchema.parse(createCanonicalRecord(record, commissionRateUnit)));

  // EXCHANGE remains audit-only and does not enter settlement records.
  const auditEvents = records
    .filter((record) => record.recordType === 'exchange')
    .map((record) => ({
      eventType: 'exchange' as const,
      sourceRecordId: record.sourceRecordId,
      sourceTransactionId: record.sourceTransactionId,
      ...(record.parentTransactionId ? { parentTransactionId: record.parentTransactionId } : {}),
      productId: record.productId,
      occurredAt: record.occurredAt,
      quantity: record.quantity,
    }));

  return {
    summary: {
      totalRows: records.length,
      saleRows: records.filter((record) => record.recordType === 'sale').length,
      refundRows: records.filter((record) => record.recordType === 'refund').length,
      exchangeRows: auditEvents.length,
      canonicalSales: canonicalSales.length,
    },
    records: canonicalSales,
    auditEvents,
  };
}
