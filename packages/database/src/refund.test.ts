import { describe, expect, it } from 'vitest';

import {
  buildRefundSaleFields,
  type ParentSaleSnapshot,
  type RefundSourceRecord,
} from './refund.js';

describe('refund rate snapshot (client-confirmed rule)', () => {
  it("uses the ORIGINAL sale rate, not the Rental's current rate, for a cross-month refund", () => {
    // Original SALE was recorded when the Rental's rate was 8500 bps (85%).
    const parentSale: ParentSaleSnapshot = {
      id: 'sale-original-001',
      unitPriceCents: 5000n,
      rentalCommissionBps: 8500,
      cubeCommissionBps: null,
    };

    // Between the original sale and this refund, the Rental's rate was
    // changed to 8000 bps (80%) -- this must NOT affect the refund below.
    const currentRentalRateAfterChange = 8000;

    const crossMonthRefund: RefundSourceRecord = {
      sourceRecordId: 'SRC-REFUND-001',
      sourceTransactionId: 'TX-REFUND-001',
      quantity: -1,
      totalAmount: '-50.00',
      commissionAmount: '-42.50',
      tenantAmount: '-7.50',
      currency: 'TWD',
      occurredAt: '2026-10-05T00:00:00.000Z', // months after the original sale
    };

    const result = buildRefundSaleFields(parentSale, crossMonthRefund);

    expect(result.rentalCommissionBps).toBe(8500);
    expect(result.rentalCommissionBps).not.toBe(currentRentalRateAfterChange);
    expect(result.parentSaleId).toBe('sale-original-001');
  });
});
