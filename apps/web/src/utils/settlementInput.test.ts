import { describe, expect, it } from 'vitest';

import { mockSettlementContext } from '../fixtures/mockSettlementContext';
import { createMonthlySettlementInput } from './settlementInput';

describe('createMonthlySettlementInput', () => {
  it('merges normalized sales into the shared monthly report context', () => {
    const sales = [{ sourceRecordId: 'SRC-SALE-001' }] as never;

    expect(createMonthlySettlementInput(sales)).toMatchObject({
      artistId: mockSettlementContext.artistId,
      settlementMonth: mockSettlementContext.settlementMonth,
      asOf: mockSettlementContext.asOf,
      rentals: mockSettlementContext.rentals,
      bankTransferFeeCents: null,
      inventory: mockSettlementContext.inventory,
      sales,
      historicalRecords: [],
    });
  });

  it('allows overriding the settlement month and bank transfer fee', () => {
    expect(
      createMonthlySettlementInput([], { settlementMonth: '2026-09', bankTransferFeeCents: 1500 }),
    ).toMatchObject({
      settlementMonth: '2026-09',
      bankTransferFeeCents: 1500,
    });
  });
});
