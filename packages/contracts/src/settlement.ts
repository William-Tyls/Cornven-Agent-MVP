import { z } from 'zod';

import {
  BasisPointsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MoneyCentsSchema,
  SignedMoneyCentsSchema,
} from './common.js';
import { CanonicalSaleSchema } from './sales.js';

export const SettlementStatusSchema = z.enum([
  'draft',
  'calculated',
  'pending_approval',
  'approved',
  'rejected',
  'locked',
  'exported',
]);
export const SettlementTimezoneSchema = z.literal('Asia/Taipei');
export const SettlementRateSourceSchema = z.literal('rental');
const NameSchema = z.string().trim().min(1);
const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM.')
  .refine((v) => Number(v.slice(0, 4)) >= 2000, 'Year must be at least 2000.');

export const ReportRentalSchema = z
  .object({
    rentalId: IdentifierSchema,
    venueId: IdentifierSchema,
    venueName: NameSchema,
    effectiveFrom: IsoDateTimeSchema,
    effectiveTo: IsoDateTimeSchema.nullable().default(null),
    monthlyRentCents: MoneyCentsSchema.nullable().default(null),
  })
  .strict()
  .superRefine((rental, ctx) => {
    if (rental.effectiveTo && Date.parse(rental.effectiveTo) <= Date.parse(rental.effectiveFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'Rental end must be after its start.',
      });
    }
  });

export const ReportInventorySchema = z
  .object({
    capturedAt: IsoDateTimeSchema,
    complete: z.boolean(),
    items: z.array(
      z
        .object({
          productId: IdentifierSchema,
          productName: NameSchema,
          sku: IdentifierSchema.nullable().default(null),
          venueId: IdentifierSchema,
          venueName: NameSchema,
          currentStock: z.number().int().safe().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const SettlementPreviewInputSchema = z
  .object({
    artistId: IdentifierSchema,
    artistName: NameSchema.optional(),
    brandName: NameSchema.nullable().default(null),
    settlementMonth: MonthSchema,
    // Inclusive data cutoff; complete-month filtering still excludes next month's start.
    asOf: IsoDateTimeSchema,
    businessTimezone: SettlementTimezoneSchema.default('Asia/Taipei'),
    currency: z.literal('TWD').default('TWD'),
    // Pass normalization.records unchanged; rentalCommissionBps is the formal platform rate.
    // M3 selects artist and period and derives creator rate as 10000 minus platform rate.
    sales: z.array(CanonicalSaleSchema),
    // Same M2 shape: original sales AND earlier refunds for cross-month validation.
    historicalRecords: z.array(CanonicalSaleSchema).default([]),
    // Scoped to artistId. Includes active rentals even when there are no sales.
    rentals: z.array(ReportRentalSchema).default([]),
    bankTransferFeeCents: MoneyCentsSchema.nullable().default(null),
    inventory: ReportInventorySchema.nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    const start = Date.parse(`${input.settlementMonth}-01T00:00:00+08:00`);
    if (Date.parse(input.asOf) < start)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asOf'],
        message: 'Data cutoff must not precede the settlement month.',
      });
    const ids = input.rentals.map((r) => r.rentalId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rentals'],
        message: 'Rental IDs must be unique.',
      });
    if (input.inventory) {
      if (Date.parse(input.inventory.capturedAt) > Date.parse(input.asOf))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inventory', 'capturedAt'],
          message: 'Inventory must not be newer than the report cutoff.',
        });
      const keys = input.inventory.items.map((r) => JSON.stringify([r.productId, r.venueId]));
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inventory', 'items'],
          message: 'Only one stock balance per product and venue is allowed.',
        });
    }
  });

export const ReportAmountsSchema = z
  .object({
    totalProductSalesCents: MoneyCentsSchema,
    refundsCents: MoneyCentsSchema,
    validSalesCents: SignedMoneyCentsSchema,
    creatorRevenueShareAmountCents: SignedMoneyCentsSchema.nullable(),
  })
  .strict();
export const ReportRateBreakdownSchema = ReportAmountsSchema.extend({
  creatorCommissionBps: BasisPointsSchema.nullable(),
  platformCommissionBps: BasisPointsSchema.nullable(),
});
export const ReportRentalBreakdownSchema = ReportAmountsSchema.extend({
  rentalId: IdentifierSchema,
  venueId: IdentifierSchema,
  venueName: NameSchema,
  rentalAmountCents: MoneyCentsSchema.nullable(),
  revenueShares: z.array(ReportRateBreakdownSchema),
});
export const ProductSalesDetailSchema = z
  .object({
    productId: IdentifierSchema,
    productName: NameSchema,
    sku: IdentifierSchema.nullable(),
    rentalId: IdentifierSchema,
    venueId: IdentifierSchema,
    unitPriceCents: MoneyCentsSchema,
    quantitySold: z.number().int().safe().nonnegative(),
    salesAmountCents: MoneyCentsSchema,
  })
  .strict();
export const LowStockProductSchema = z
  .object({
    productId: IdentifierSchema,
    productName: NameSchema,
    sku: IdentifierSchema.nullable(),
    venueId: IdentifierSchema,
    venueName: NameSchema,
    currentStock: z.number().int().safe().nonnegative(),
    monthlyQuantitySold: z.number().int().safe().nonnegative(),
  })
  .strict();

// Report-facing output only: no POS split totals, reconciliation differences or internal IDs of runs/rules.
export const SettlementPreviewSchema = ReportAmountsSchema.extend({
  settlementMonth: z.string().regex(/^(0[1-9]|1[0-2])\/\d{4}$/),
  creator: z
    .object({
      artistId: IdentifierSchema,
      artistName: NameSchema.nullable(),
      brandName: NameSchema.nullable(),
    })
    .strict(),
  venues: z.array(z.object({ venueId: IdentifierSchema, venueName: NameSchema }).strict()),
  settlementPeriod: z
    .object({ from: z.string(), to: z.string(), asOf: IsoDateTimeSchema })
    .strict(),
  currency: z.literal('TWD'),
  businessTimezone: SettlementTimezoneSchema,
  isProvisional: z.boolean(),
  rentals: z.array(ReportRentalBreakdownSchema),
  bankTransferFeeCents: MoneyCentsSchema.nullable(),
  amountPayableToCreatorCents: SignedMoneyCentsSchema.nullable(),
  monthlyProductSalesDetails: z.array(ProductSalesDetailSchema),
  lowStockReminder: z
    .object({
      status: z.enum(['available', 'unavailable']),
      capturedAt: IsoDateTimeSchema.nullable(),
      products: z.array(LowStockProductSchema),
      message: NameSchema.nullable(),
    })
    .strict(),
  notes: z.array(NameSchema),
});

export type SettlementPreviewInput = z.infer<typeof SettlementPreviewInputSchema>;
export type SettlementPreview = z.infer<typeof SettlementPreviewSchema>;
export type ReportRentalBreakdown = z.infer<typeof ReportRentalBreakdownSchema>;
export type ProductSalesDetail = z.infer<typeof ProductSalesDetailSchema>;
export type SettlementStatus = z.infer<typeof SettlementStatusSchema>;
export type SettlementRateSource = z.infer<typeof SettlementRateSourceSchema>;
