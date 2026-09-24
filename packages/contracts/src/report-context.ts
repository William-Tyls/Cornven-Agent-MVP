import { z } from 'zod';
import { IdentifierSchema, IsoDateTimeSchema, MoneyCentsSchema } from './common.js';
import { CanonicalSaleSchema } from './sales.js';
import { ReportInventorySchema, ReportRentalSchema } from './settlement.js';
import { SettlementMonthSchema } from './reporting.js';

export const MonthlyReportContextQuerySchema = z
  .object({
    artistId: IdentifierSchema,
    settlementMonth: SettlementMonthSchema,
    asOf: IsoDateTimeSchema,
  })
  .strict()
  .refine((q) => Date.parse(q.asOf) >= Date.parse(`${q.settlementMonth}-01T00:00:00+08:00`), {
    message: 'asOf must not precede the month.',
    path: ['asOf'],
  });
export const MonthlyReportContextSchema = z
  .object({
    artistId: IdentifierSchema,
    artistName: z.string().trim().min(1),
    brandName: z.string().trim().min(1).nullable(),
    sales: z.array(CanonicalSaleSchema),
    historicalRecords: z.array(CanonicalSaleSchema),
    rentals: z.array(ReportRentalSchema),
    inventory: ReportInventorySchema.nullable(),
    bankTransferFeeCents: MoneyCentsSchema.nullable(),
  })
  .strict();
export const ArtistSummarySchema = z
  .object({
    artistId: IdentifierSchema,
    artistName: z.string().min(1),
    brandName: z.string().nullable(),
  })
  .strict();
export const ArtistListQuerySchema = z
  .object({
    query: z.string().trim().max(120).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const ArtistListResponseSchema = z
  .object({
    items: z.array(ArtistSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type MonthlyReportContextQuery = z.infer<typeof MonthlyReportContextQuerySchema>;
export type MonthlyReportContext = z.infer<typeof MonthlyReportContextSchema>;
export type ArtistListQuery = z.infer<typeof ArtistListQuerySchema>;
export type ArtistListResponse = z.infer<typeof ArtistListResponseSchema>;
export interface MonthlyReportContextProvider {
  getMonthlyReportContext(query: MonthlyReportContextQuery): Promise<MonthlyReportContext>;
}
