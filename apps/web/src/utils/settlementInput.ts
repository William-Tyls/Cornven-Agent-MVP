import type { CanonicalSale, SettlementPreviewInput } from '@cornven/contracts';

import { mockSettlementContext } from '../fixtures/mockSettlementContext';

export function createMonthlySettlementInput(
  sales: CanonicalSale[],
  overrides: Partial<
    Pick<SettlementPreviewInput, 'settlementMonth' | 'asOf' | 'bankTransferFeeCents'>
  > = {},
): SettlementPreviewInput {
  const asOf = overrides.asOf ?? mockSettlementContext.asOf;
  const inventory = mockSettlementContext.inventory;
  // A snapshot captured after the report cutoff cannot describe stock "as of" that
  // earlier moment, so drop it rather than send a request the API will reject.
  const inventoryIsUsable = !inventory || Date.parse(inventory.capturedAt) <= Date.parse(asOf);

  return {
    ...mockSettlementContext,
    brandName: null,
    currency: 'TWD',
    businessTimezone: 'Asia/Taipei',
    inventory: inventoryIsUsable ? inventory : null,
    ...overrides,
    sales,
    historicalRecords: [],
  };
}
