import { z } from 'zod';
import { IdentifierSchema, IsoDateTimeSchema } from './common.js';
import { SettlementMonthSchema } from './reporting.js';

export const GenerateMonthlyReportRequestSchema = z
  .object({
    artistId: IdentifierSchema,
    period: z.literal('current_month'),
    format: z.literal('pdf'),
  })
  .strict();
export const IdempotencyKeySchema = z.string().trim().min(1).max(120);
export const GenerateMonthlyReportResponseSchema = z
  .object({
    reportId: IdentifierSchema,
    artistId: IdentifierSchema,
    displayName: z.string().min(1),
    settlementMonth: SettlementMonthSchema,
    asOf: IsoDateTimeSchema,
    generatedAt: IsoDateTimeSchema,
    isProvisional: z.boolean(),
    reportStatus: z.literal('draft'),
    generationStatus: z.literal('ready'),
    pdfFileReference: z.string().trim().min(1),
  })
  .strict();
export const ReportSummarySchema = GenerateMonthlyReportResponseSchema.extend({
  approvalStatus: z.enum(['draft', 'pending', 'approved', 'rejected']).optional(),
  trigger: z.enum(['manual', 'scheduled']),
  version: z.number().int().positive(),
}).strict();
export const ReportListQuerySchema = z
  .object({
    artistId: IdentifierSchema.optional(),
    settlementMonth: SettlementMonthSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const ReportListResponseSchema = z
  .object({
    items: z.array(ReportSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type GenerateMonthlyReportRequest = z.infer<typeof GenerateMonthlyReportRequestSchema>;
export type GenerateMonthlyReportResponse = z.infer<typeof GenerateMonthlyReportResponseSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
export type ReportListQuery = z.infer<typeof ReportListQuerySchema>;
export type ReportListResponse = z.infer<typeof ReportListResponseSchema>;
