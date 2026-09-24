import { z } from 'zod';
import { CommissionRateUnitSchema } from './sales.js';

export const CsvBatchUploadSchema = z
  .object({
    csv: z.string().min(1).max(512_000),
    fileName: z.string().trim().min(1).max(180),
    commissionRateUnit: CommissionRateUnitSchema,
  })
  .strict();
export const CsvBatchIssueSchema = z.object({
  lineNumber: z.number().int().positive().nullable(),
  field: z.string(),
  code: z.string(),
  reason: z.string(),
});
export const CsvBatchSummarySchema = z.object({
  saleRows: z.number().int().nonnegative(),
  refundRows: z.number().int().nonnegative(),
  exchangeRows: z.number().int().nonnegative(),
  newRecords: z.number().int().nonnegative(),
  duplicateRecords: z.number().int().nonnegative(),
  newExchanges: z.number().int().nonnegative(),
  duplicateExchanges: z.number().int().nonnegative(),
});
export const CsvBatchSchema = z.object({
  id: z.string().min(1),
  fileName: z.string(),
  status: z.enum(['VALIDATED', 'FAILED', 'IMPORTED']),
  commissionRateUnit: CommissionRateUnitSchema,
  createdAt: z.string().datetime(),
  confirmedAt: z.string().datetime().nullable(),
  totalRows: z.number().int().nonnegative(),
  validRows: z.number().int().nonnegative(),
  invalidRows: z.number().int().nonnegative(),
  summary: CsvBatchSummarySchema,
  issues: z.array(CsvBatchIssueSchema),
  preview: z.array(
    z.object({
      lineNumber: z.number().int().positive(),
      recordType: z.enum(['sale', 'refund', 'exchange']),
      sourceTransactionId: z.string(),
      artistName: z.string(),
      productName: z.string(),
      occurredAt: z.string().datetime(),
      grossSalesCents: z.number().int().nullable(),
      duplicate: z.boolean(),
    }),
  ),
});
export const CsvBatchListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.string().uuid().optional(),
    status: z.enum(['VALIDATED', 'FAILED', 'IMPORTED']).optional(),
  })
  .strict();
export const CsvBatchListSchema = z.object({
  items: z.array(CsvBatchSchema.omit({ issues: true, preview: true })),
  nextCursor: z.string().uuid().nullable(),
});
export type CsvBatch = z.infer<typeof CsvBatchSchema>;
export type CsvBatchIssue = z.infer<typeof CsvBatchIssueSchema>;
export type CsvBatchUpload = z.infer<typeof CsvBatchUploadSchema>;
export type CsvBatchList = z.infer<typeof CsvBatchListSchema>;
