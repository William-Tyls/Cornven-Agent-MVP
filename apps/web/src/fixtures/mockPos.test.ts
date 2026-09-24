import { describe, expect, it } from 'vitest';

import { mockPosImport } from './mockPos';

describe('mock POS import fixture', () => {
  it('provides the sale, matched refund, and exchange records required by the v0.3 import contract', () => {
    expect(mockPosImport.commissionRateUnit).toBe('fraction');
    expect(mockPosImport.records.map((record) => record.recordType)).toEqual([
      'sale',
      'refund',
      'exchange',
    ]);

    const refund = mockPosImport.records[1];
    expect(refund).toMatchObject({
      parentTransactionId: 'TX-001',
      quantity: -1,
      totalAmount: '-50.00',
      currency: 'TWD',
    });
  });
});
