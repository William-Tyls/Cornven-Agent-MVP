import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { SettlementMonthSchema } from './reporting.js';
import { SettlementPreviewSchema } from './settlement.js';

// Public query; transaction context and time cutoffs are resolved by the server.
export const MonthlySettlementPreviewRequestSchema = z
  .object({
    artistId: z.string().uuid(),
    settlementMonth: SettlementMonthSchema,
  })
  .strict();

export const MonthlySettlementPreviewResponseSchema = z
  .object({
    artistId: z.string().uuid(),
    settlementMonth: SettlementMonthSchema,
    calculatedAt: IsoDateTimeSchema,
    dataCutoff: IsoDateTimeSchema,
    readOnly: z.literal(true),
    result: SettlementPreviewSchema,
  })
  .strict();

export type MonthlySettlementPreviewRequest = z.infer<typeof MonthlySettlementPreviewRequestSchema>;
export type MonthlySettlementPreviewResponse = z.infer<
  typeof MonthlySettlementPreviewResponseSchema
>;
