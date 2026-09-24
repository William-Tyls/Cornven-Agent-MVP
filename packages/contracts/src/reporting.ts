import { z } from 'zod';

import {
  BasisPointsSchema,
  IdentifierSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneyCentsSchema,
  SignedMoneyCentsSchema,
} from './common.js';

const NonEmptyTextSchema = z.string().trim().min(1);
const NonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
export const SettlementMonthSchema = z
  .string()
  .regex(/^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/, 'Expected a YYYY-MM month from the year 2000 onward.');

const ReportSettlementPeriodSchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    asOf: IsoDateTimeSchema,
  })
  .strict();

const ReportCreatorSchema = z
  .object({
    artistId: IdentifierSchema,
    artistName: NonEmptyTextSchema.nullable(),
    brandName: NonEmptyTextSchema.nullable(),
    displayName: NonEmptyTextSchema,
  })
  .strict();

const ReportFinancialSummarySchema = z
  .object({
    totalProductSalesCents: MoneyCentsSchema,
    refundsCents: MoneyCentsSchema,
    validSalesCents: SignedMoneyCentsSchema,
    creatorRevenueShareAmountCents: SignedMoneyCentsSchema.nullable(),
    bankTransferFeeCents: MoneyCentsSchema.nullable(),
    amountPayableToCreatorCents: SignedMoneyCentsSchema.nullable(),
  })
  .strict();

const ReportRevenueShareSchema = z
  .object({
    creatorCommissionBps: BasisPointsSchema.nullable(),
    platformCommissionBps: BasisPointsSchema.nullable(),
    totalProductSalesCents: MoneyCentsSchema,
    refundsCents: MoneyCentsSchema,
    validSalesCents: SignedMoneyCentsSchema,
    creatorRevenueShareAmountCents: SignedMoneyCentsSchema.nullable(),
  })
  .strict();

const ReportRentalSchema = z
  .object({
    rentalId: IdentifierSchema,
    venueId: IdentifierSchema,
    venueName: NonEmptyTextSchema,
    rentalAmountCents: MoneyCentsSchema.nullable(),
    totalProductSalesCents: MoneyCentsSchema,
    refundsCents: MoneyCentsSchema,
    validSalesCents: SignedMoneyCentsSchema,
    creatorRevenueShareAmountCents: SignedMoneyCentsSchema.nullable(),
    revenueShares: z.array(ReportRevenueShareSchema),
  })
  .strict();

const MonthlyProductSalesDetailSchema = z
  .object({
    productId: IdentifierSchema,
    productName: NonEmptyTextSchema,
    sku: IdentifierSchema.nullable(),
    rentalId: IdentifierSchema,
    venueId: IdentifierSchema,
    unitPriceCents: MoneyCentsSchema,
    quantitySold: NonNegativeSafeIntegerSchema,
    salesAmountCents: MoneyCentsSchema,
  })
  .strict();

const LowStockProductSchema = z
  .object({
    productId: IdentifierSchema,
    productName: NonEmptyTextSchema,
    sku: IdentifierSchema.nullable(),
    venueId: IdentifierSchema,
    venueName: NonEmptyTextSchema,
    currentStock: NonNegativeSafeIntegerSchema,
    monthlyQuantitySold: NonNegativeSafeIntegerSchema,
  })
  .strict();

const LowStockReminderSchema = z
  .object({
    status: z.enum(['available', 'unavailable']),
    capturedAt: IsoDateTimeSchema.nullable(),
    products: z.array(LowStockProductSchema),
    message: NonEmptyTextSchema.nullable(),
  })
  .strict();

export const MonthlyReportDocumentSchema = z
  .object({
    reportId: IdentifierSchema,
    generatedAt: IsoDateTimeSchema,
    language: z.literal('en'),
    reportStatus: z.literal('draft'),
    settlementMonth: SettlementMonthSchema,
    settlementPeriod: ReportSettlementPeriodSchema,
    creator: ReportCreatorSchema,
    currency: z.literal('TWD'),
    businessTimezone: z.literal('Asia/Taipei'),
    isProvisional: z.boolean(),
    financialSummary: ReportFinancialSummarySchema,
    rentals: z.array(ReportRentalSchema),
    monthlyProductSalesDetails: z.array(MonthlyProductSalesDetailSchema),
    lowStockReminder: LowStockReminderSchema,
    notes: z.array(NonEmptyTextSchema),
  })
  .strict();

export type MonthlyReportDocument = z.infer<typeof MonthlyReportDocumentSchema>;
