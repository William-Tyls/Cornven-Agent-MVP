import { describe, expect, it } from 'vitest';
import { SettlementPreviewInputSchema } from './settlement.js';

const input = {
  artistId: 'ART-001',
  settlementMonth: '2026-08',
  asOf: '2026-09-01T00:00:00+08:00',
  sales: [],
};

describe('M3 monthly report contract', () => {
  it('accepts zero-transaction reports and defaults to TWD/Taipei', () => {
    expect(SettlementPreviewInputSchema.parse(input)).toMatchObject({
      currency: 'TWD',
      businessTimezone: 'Asia/Taipei',
      sales: [],
      bankTransferFeeCents: null,
    });
  });
  it('rejects unsupported context and legacy single-rental parameters', () => {
    for (const change of [
      { businessTimezone: 'Australia/Sydney' },
      { currency: 'AUD' },
      { settlementMonth: '2026-13' },
      { asOf: '2026-07-01T00:00:00Z' },
      { rentalCommissionBps: 2000 },
      { creatorRules: [] },
    ]) {
      expect(SettlementPreviewInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it('returns validation issues for invalid dates instead of throwing', () => {
    expect(() =>
      SettlementPreviewInputSchema.safeParse({ ...input, asOf: 'invalid' }),
    ).not.toThrow();
    expect(SettlementPreviewInputSchema.safeParse({ ...input, asOf: 'invalid' }).success).toBe(
      false,
    );
  });
});
