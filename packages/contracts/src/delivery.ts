import { z } from 'zod';
import { IdentifierSchema } from './common.js';
import { SettlementMonthSchema } from './reporting.js';
export const DeliveryProfileInputSchema = z
  .object({
    recipientEmail: z.string().trim().email().max(254).nullable(),
    automaticEnabled: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.automaticEnabled && !v.recipientEmail)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientEmail'],
        message: 'Automatic sending requires a recipient email.',
      });
  });
export const DeliveryProfileSchema = z
  .object({
    artistId: IdentifierSchema,
    recipientEmail: z.string().email().nullable(),
    automaticEnabled: z.boolean(),
  })
  .strict();
export const SendReportRequestSchema = z.object({ reportId: IdentifierSchema }).strict();
export const DeliveryStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'failed',
  'unknown',
  'skipped',
]);
export const DeliveryRecordSchema = z
  .object({
    id: IdentifierSchema,
    artistId: IdentifierSchema,
    artistName: z.string(),
    reportId: IdentifierSchema.nullable(),
    settlementMonth: SettlementMonthSchema,
    version: z.number().int().positive().nullable(),
    recipientEmail: z.string().email().nullable(),
    trigger: z.enum(['manual', 'scheduled']),
    mode: z.enum(['local', 'smtp']),
    status: DeliveryStatusSchema,
    actorId: z.string(),
    attemptCount: z.number().int().nonnegative(),
    messageId: z.string().nullable(),
    pdfChecksum: z.string().nullable(),
    sentAt: z.string().datetime().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const DeliveryListQuerySchema = z
  .object({
    artistId: IdentifierSchema.optional(),
    settlementMonth: SettlementMonthSchema.optional(),
    status: DeliveryStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
export const DeliveryListResponseSchema = z
  .object({ items: z.array(DeliveryRecordSchema), nextCursor: z.string().nullable() })
  .strict();
export const DeliveryConfigSchema = z
  .object({
    mode: z.enum(['disabled', 'local', 'smtp']),
    configured: z.boolean(),
    from: z.string().nullable(),
    timezone: z.literal('Asia/Taipei'),
    schedule: z.literal('Every month on day 1 at 10:00'),
    nextScheduledAt: z.string().datetime(),
    inboxUrl: z.string().url().nullable(),
  })
  .strict();
export type DeliveryProfile = z.infer<typeof DeliveryProfileSchema>;
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;
