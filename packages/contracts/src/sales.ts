import { z } from 'zod';

import {
  BasisPointsSchema,
  CurrencySchema,
  DecimalMoneyStringSchema,
  DecimalRateStringSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  PositiveMoneyCentsSchema,
} from './common.js';

const SignedMoneyCentsSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

const RawPosRecordBaseSchema = z.object({
  sourceRecordId: IdentifierSchema,
  sourceTransactionId: IdentifierSchema,
  artistId: IdentifierSchema,
  artistName: z.string().trim().min(1),
  venueId: IdentifierSchema,
  venueName: z.string().trim().min(1),
  productId: IdentifierSchema,
  sku: IdentifierSchema.nullish(),
  productName: z.string().trim().min(1),
  occurredAt: IsoDateTimeSchema,
  currency: CurrencySchema,
});

const RawPosMoneyFieldsSchema = z.object({
  unitPrice: DecimalMoneyStringSchema,
  totalAmount: DecimalMoneyStringSchema,
  commissionAmount: DecimalMoneyStringSchema,
  tenantAmount: DecimalMoneyStringSchema,
  rentalId: IdentifierSchema,
  rentalCommissionRate: DecimalRateStringSchema,
  cubeId: IdentifierSchema.nullish(),
  cubeCommissionRate: DecimalRateStringSchema.nullish(),
});

function decimalMoneyToCents(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

function addSplitIssue(
  record: { totalAmount: string; commissionAmount: string; tenantAmount: string },
  context: z.RefinementCtx,
): void {
  if (
    decimalMoneyToCents(record.commissionAmount) + decimalMoneyToCents(record.tenantAmount) !==
    decimalMoneyToCents(record.totalAmount)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commissionAmount'],
      message: 'POS commission and tenant amounts must add up to the total amount.',
    });
  }
}

export const RawPosSaleRecordSchema = RawPosRecordBaseSchema.merge(RawPosMoneyFieldsSchema)
  .extend({
    recordType: z.literal('sale'),
    parentTransactionId: z.null().optional(),
    quantity: z.number().int().positive().max(2_147_483_647),
  })
  .superRefine((record, context) => {
    for (const field of ['unitPrice', 'totalAmount', 'commissionAmount', 'tenantAmount'] as const) {
      if (decimalMoneyToCents(record[field]) < 0n) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Original sale amounts must not be negative.',
        });
      }
    }
    if (decimalMoneyToCents(record.unitPrice) <= 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPrice'],
        message: 'Unit price must be greater than zero.',
      });
    }
    addSplitIssue(record, context);
  });

export const RawPosRefundRecordSchema = RawPosRecordBaseSchema.merge(RawPosMoneyFieldsSchema)
  .extend({
    recordType: z.literal('refund'),
    parentTransactionId: IdentifierSchema,
    quantity: z.number().int().negative().min(-2_147_483_648),
  })
  .superRefine((record, context) => {
    if (decimalMoneyToCents(record.unitPrice) <= 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPrice'],
        message: 'Refund unit price must remain greater than zero.',
      });
    }
    if (decimalMoneyToCents(record.totalAmount) >= 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalAmount'],
        message: 'Refund total amount must be negative in the raw POS layer.',
      });
    }

    for (const field of ['commissionAmount', 'tenantAmount'] as const) {
      if (decimalMoneyToCents(record[field]) > 0n) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Refund split amounts must not be positive in the raw POS layer.',
        });
      }
    }
    addSplitIssue(record, context);
  });

export const RawPosExchangeRecordSchema = RawPosRecordBaseSchema.extend({
  recordType: z.literal('exchange'),
  parentTransactionId: IdentifierSchema.nullish(),
  quantity: z.number().int().positive().max(2_147_483_647),
});

export const RawPosRecordSchema = z.union([
  RawPosSaleRecordSchema,
  RawPosRefundRecordSchema,
  RawPosExchangeRecordSchema,
]);

export const RawPosRecordsSchema = z.array(RawPosRecordSchema).min(1);

export const CommissionRateUnitSchema = z.enum(['fraction', 'percentage', 'basis_points']);

export const RawPosImportRequestSchema = z.object({
  commissionRateUnit: CommissionRateUnitSchema,
  records: RawPosRecordsSchema,
});

export const CsvPosImportRequestSchema = z.object({
  commissionRateUnit: CommissionRateUnitSchema,
  csv: z.string().trim().min(1),
});

export const CanonicalSaleSchema = z
  .object({
    recordType: z.enum(['sale', 'refund']),
    sourceRecordId: IdentifierSchema,
    sourceTransactionId: IdentifierSchema,
    parentTransactionId: IdentifierSchema.nullish(),

    artistId: IdentifierSchema,
    artistName: z.string().trim().min(1),
    venueId: IdentifierSchema,
    venueName: z.string().trim().min(1),

    productId: IdentifierSchema,
    sku: IdentifierSchema.optional(),
    productName: z.string().trim().min(1),

    soldAt: IsoDateTimeSchema,
    quantitySold: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    unitPriceCents: PositiveMoneyCentsSchema,

    grossSalesCents: SignedMoneyCentsSchema,
    sourceCommissionAmountCents: SignedMoneyCentsSchema,
    sourceTenantAmountCents: SignedMoneyCentsSchema,

    rentalId: IdentifierSchema,
    rentalCommissionBps: BasisPointsSchema,
    cubeId: IdentifierSchema.optional(),
    cubeCommissionBps: BasisPointsSchema.optional(),
    currency: CurrencySchema,
  })
  .superRefine((record, context) => {
    const moneyFields = [
      'grossSalesCents',
      'sourceCommissionAmountCents',
      'sourceTenantAmountCents',
    ] as const;

    if (record.recordType === 'sale') {
      if (record.parentTransactionId != null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parentTransactionId'],
          message: 'SALE records must not have a parent transaction ID.',
        });
      }

      if (record.quantitySold <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantitySold'],
          message: 'SALE quantity must be positive.',
        });
      }

      for (const field of moneyFields) {
        if (record[field] < 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'SALE amounts must not be negative.',
          });
        }
      }
    }

    if (record.recordType === 'refund') {
      if (record.parentTransactionId == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parentTransactionId'],
          message: 'REFUND records must include a parent transaction ID.',
        });
      }

      if (record.quantitySold >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantitySold'],
          message: 'REFUND quantity must be negative.',
        });
      }

      if (record.grossSalesCents >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['grossSalesCents'],
          message: 'REFUND gross sales must be negative.',
        });
      }

      for (const field of ['sourceCommissionAmountCents', 'sourceTenantAmountCents'] as const) {
        if (record[field] > 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'REFUND split amounts must not be positive.',
          });
        }
      }
    }

    if (
      BigInt(record.sourceCommissionAmountCents) + BigInt(record.sourceTenantAmountCents) !==
      BigInt(record.grossSalesCents)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceCommissionAmountCents'],
        message: 'POS commission and tenant amounts must add up to gross sales.',
      });
    }
  });

export const CanonicalSalesSchema = z.array(CanonicalSaleSchema).min(1);

export const PosAuditEventSchema = z.object({
  eventType: z.literal('exchange'),
  sourceRecordId: IdentifierSchema,
  sourceTransactionId: IdentifierSchema,
  parentTransactionId: IdentifierSchema.optional(),
  productId: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
  quantity: z.number().int().positive().max(2_147_483_647),
});

export const ImportValidationSummarySchema = z.object({
  totalRows: z.number().int().nonnegative(),
  saleRows: z.number().int().nonnegative(),
  refundRows: z.number().int().nonnegative(),
  exchangeRows: z.number().int().nonnegative(),
  canonicalSales: z.number().int().nonnegative(),
});

export const ImportNormalizationResultSchema = z.object({
  summary: ImportValidationSummarySchema,
  records: z.array(CanonicalSaleSchema),
  auditEvents: z.array(PosAuditEventSchema),
});

export const AggregateSalesReportRowSchema = z.object({
  artistName: z.string().trim().min(1),
  artistEmail: z.string().email(),
  productName: z.string().trim().min(1),
  category: z.string().trim().min(1),
  quantity: z.number().int(),
  totalAmount: DecimalMoneyStringSchema,
  commissionAmount: DecimalMoneyStringSchema,
});

export type RawPosRecord = z.infer<typeof RawPosRecordSchema>;
export type RawPosSaleRecord = z.infer<typeof RawPosSaleRecordSchema>;
export type RawPosRefundRecord = z.infer<typeof RawPosRefundRecordSchema>;
export type CommissionRateUnit = z.infer<typeof CommissionRateUnitSchema>;
export type RawPosImportRequest = z.infer<typeof RawPosImportRequestSchema>;
export type CsvPosImportRequest = z.infer<typeof CsvPosImportRequestSchema>;
export type CanonicalSale = z.infer<typeof CanonicalSaleSchema>;
export type PosAuditEvent = z.infer<typeof PosAuditEventSchema>;
export type ImportValidationSummary = z.infer<typeof ImportValidationSummarySchema>;
export type ImportNormalizationResult = z.infer<typeof ImportNormalizationResultSchema>;
export type AggregateSalesReportRow = z.infer<typeof AggregateSalesReportRowSchema>;
