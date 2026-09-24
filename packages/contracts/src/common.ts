import { z } from 'zod';

export const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Expected a three-letter ISO 4217 currency code.');
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneyCentsSchema = z.number().int().safe().nonnegative();
export const PositiveMoneyCentsSchema = z.number().int().safe().positive();
export const SignedMoneyCentsSchema = z.number().int().safe();
export const BasisPointsSchema = z.number().int().safe().min(0).max(10_000);
export const IdentifierSchema = z.string().trim().min(1).max(120);
export const VerbatimExcerptSchema = z.string().trim().min(1).max(480);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DecimalMoneyStringSchema = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,8}(?:\.\d{1,2})?$/,
    'Expected a Decimal(10,2) amount with at most eight whole-number digits.',
  );
export const DecimalRateStringSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,4})?$/, 'Expected a non-negative decimal rate.');

export const RequestContextSchema = z.object({
  requestId: IdentifierSchema,
  actorId: IdentifierSchema,
  actorType: z.enum(['staff', 'agent']),
});
export type RequestContext = z.infer<typeof RequestContextSchema>;

export const ErrorDetailSchema = z.object({
  field: z.string().optional(),
  reason: z.string(),
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z0-9_]+$/),
    message: z.string(),
    requestId: z.string(),
    details: z.array(ErrorDetailSchema).default([]),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
