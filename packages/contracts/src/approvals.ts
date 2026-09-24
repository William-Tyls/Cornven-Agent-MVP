import { z } from 'zod';
import { IdentifierSchema } from './common.js';
import { MonthlyReportDocumentSchema } from './reporting.js';
import { ReportSummarySchema } from './report-api.js';
export const ApprovalStatusSchema = z.enum(['draft', 'pending', 'approved', 'rejected']);
export const ApprovalCommandSchema = z
  .object({
    action: z.enum(['submit', 'approve', 'reject']),
    requestId: z.string().uuid(),
    reason: z.string().trim().max(2000).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'reject' && !value.reason)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A rejection reason is required.',
      });
  });
export const ApprovalListQuerySchema = z
  .object({
    status: ApprovalStatusSchema.optional(),
    artistQuery: z.string().trim().max(200).optional(),
    settlementMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const ApprovalSummarySchema = ReportSummarySchema.extend({
  approvalStatus: ApprovalStatusSchema,
  approvalUpdatedAt: z.string().datetime().nullable(),
});
export const ApprovalListResponseSchema = z
  .object({
    items: z.array(ApprovalSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const ApprovalDetailSchema = z
  .object({
    summary: ApprovalSummarySchema,
    report: MonthlyReportDocumentSchema,
    events: z.array(
      z
        .object({
          id: IdentifierSchema,
          action: z.enum(['submit', 'approve', 'reject']),
          actorId: z.string(),
          reason: z.string().nullable(),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export type ApprovalCommand = z.infer<typeof ApprovalCommandSchema>;
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;
