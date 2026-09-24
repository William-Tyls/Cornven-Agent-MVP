import {
  IdentifierSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MonthlyReportDocumentSchema,
  SettlementPreviewSchema,
  type MonthlyReportDocument,
} from '@cornven/contracts';
import { z } from 'zod';

function isCalendarDate(value: string): boolean {
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = value.split('-').map(Number);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

const CalendarDateSchema = IsoDateSchema.refine(isCalendarDate, 'Expected a valid calendar date.');

const M3SettlementPreviewSchema = SettlementPreviewSchema.superRefine((report, ctx) => {
  for (const field of ['from', 'to'] as const) {
    if (!CalendarDateSchema.safeParse(report.settlementPeriod[field]).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settlementPeriod', field],
        message: 'Invalid calendar date.',
      });
    }
  }
});

const M3SettlementPreviewEnvelopeSchema = z
  .object({
    reportId: IdentifierSchema,
    generatedAt: IsoDateTimeSchema,
    settlement: M3SettlementPreviewSchema,
  })
  .strict();

function toCanonicalSettlementMonth(month: string): string {
  const match = /^(0[1-9]|1[0-2])\/([2-9]\d{3})$/.exec(month);

  if (match === null) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'Expected an M3 settlement month formatted MM/YYYY from the year 2000 onward.',
        path: ['settlement', 'settlementMonth'],
      },
    ]);
  }

  return `${match[2]}-${match[1]}`;
}

export function mapM3SettlementPreviewToMonthlyReport(input: unknown): MonthlyReportDocument {
  const { reportId, generatedAt, settlement } = M3SettlementPreviewEnvelopeSchema.parse(input);
  const displayName =
    settlement.creator.brandName ?? settlement.creator.artistName ?? settlement.creator.artistId;

  return MonthlyReportDocumentSchema.parse({
    reportId,
    generatedAt,
    language: 'en',
    reportStatus: 'draft',
    settlementMonth: toCanonicalSettlementMonth(settlement.settlementMonth),
    settlementPeriod: settlement.settlementPeriod,
    creator: {
      ...settlement.creator,
      displayName,
    },
    currency: settlement.currency,
    businessTimezone: settlement.businessTimezone,
    isProvisional: settlement.isProvisional,
    financialSummary: {
      totalProductSalesCents: settlement.totalProductSalesCents,
      refundsCents: settlement.refundsCents,
      validSalesCents: settlement.validSalesCents,
      creatorRevenueShareAmountCents: settlement.creatorRevenueShareAmountCents,
      bankTransferFeeCents: settlement.bankTransferFeeCents,
      amountPayableToCreatorCents: settlement.amountPayableToCreatorCents,
    },
    rentals: settlement.rentals,
    monthlyProductSalesDetails: settlement.monthlyProductSalesDetails,
    lowStockReminder: settlement.lowStockReminder,
    notes: settlement.notes,
  });
}
