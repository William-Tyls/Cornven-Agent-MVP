import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  RawPosImportRequestSchema,
  SettlementPreviewInputSchema,
  SettlementPreviewSchema,
} from '@cornven/contracts';

import { buildMonthlyReportContext } from '../src/modules/import/monthly-report-context.service.js';
import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';
import { calculateSettlementPreview } from '../src/modules/settlement/settlement.service.js';

const raw = RawPosImportRequestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pos/cross-month-refund.json', import.meta.url), 'utf8'),
  ),
);

const goldenCase = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/settlement/cross-month-refund-golden-case.json', import.meta.url),
    'utf8',
  ),
) as {
  input: unknown;
  expected: unknown;
};

const normalization = normalizeRawPosRecords(raw.records, raw.commissionRateUnit);

const providerContext = buildMonthlyReportContext({
  artistId: 'ART-001',
  artistName: 'Sample Artist',
  brandName: 'Sample Artist',
  settlementMonth: '2026-10',
  asOf: '2026-10-31T15:59:59.999Z',
  records: normalization.records,
  rentals: [
    {
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      venueName: 'Cornven Sample Venue',
      effectiveFrom: '2026-05-16T00:00:00+08:00',
      effectiveTo: null,
      monthlyRentCents: 300_000,
    },
  ],
  bankTransferFeeCents: null,
  inventory: null,
});

describe('cross-month refund golden case', () => {
  it('matches the M3-calculated October settlement result', () => {
    const expectedInput = SettlementPreviewInputSchema.parse(goldenCase.input);
    const expectedResult = SettlementPreviewSchema.parse(goldenCase.expected);

    expect(providerContext).toEqual(expectedInput);
    expect(calculateSettlementPreview(providerContext)).toEqual(expectedResult);
  });
});
