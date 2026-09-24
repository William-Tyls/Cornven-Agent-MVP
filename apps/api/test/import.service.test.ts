import { describe, expect, it } from 'vitest';

import type { RawPosRefundRecord, RawPosSaleRecord } from '@cornven/contracts';

import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';

describe('normalizeRawPosRecords', () => {
  it('keeps a SALE and its cross-month REFUND as two independent canonical records', () => {
    const sale: RawPosSaleRecord = {
      recordType: 'sale',
      sourceRecordId: 'SRC-SALE-100',
      sourceTransactionId: 'TX-SALE-100',
      artistId: 'ART-001',
      artistName: 'Sample Artist',
      venueId: 'VENUE-001',
      venueName: 'Cornven Sample Venue',
      productId: 'PROD-001',
      productName: 'Sample Ceramic Cup',
      occurredAt: '2026-08-20T04:00:00.000Z',
      quantity: 2,
      unitPrice: '50.00',
      totalAmount: '100.00',
      commissionAmount: '85.00',
      tenantAmount: '15.00',
      rentalId: 'RENTAL-001',
      rentalCommissionRate: '0.85',
      currency: 'TWD',
    };

    const refund: RawPosRefundRecord = {
      recordType: 'refund',
      sourceRecordId: 'SRC-REFUND-100',
      sourceTransactionId: 'TX-REFUND-100',
      parentTransactionId: 'TX-SALE-100',
      artistId: 'ART-001',
      artistName: 'Sample Artist',
      venueId: 'VENUE-001',
      venueName: 'Cornven Sample Venue',
      productId: 'PROD-001',
      productName: 'Sample Ceramic Cup',
      occurredAt: '2026-10-03T04:00:00.000Z',
      quantity: -1,
      unitPrice: '50.00',
      totalAmount: '-50.00',
      commissionAmount: '-42.50',
      tenantAmount: '-7.50',
      rentalId: 'RENTAL-001',
      rentalCommissionRate: '0.85',
      currency: 'TWD',
    };

    const result = normalizeRawPosRecords([sale, refund], 'fraction');

    expect(result.summary).toMatchObject({
      totalRows: 2,
      saleRows: 1,
      refundRows: 1,
      canonicalSales: 2,
    });

    expect(result.records).toHaveLength(2);

    expect(result.records[0]).toMatchObject({
      recordType: 'sale',
      sourceTransactionId: 'TX-SALE-100',
      grossSalesCents: 10_000,
      rentalCommissionBps: 8_500,
    });

    expect(result.records[1]).toMatchObject({
      recordType: 'refund',
      sourceTransactionId: 'TX-REFUND-100',
      parentTransactionId: 'TX-SALE-100',
      grossSalesCents: -5_000,
      rentalCommissionBps: 8_500,
    });

    expect(result.records[0]).not.toHaveProperty('refundAmountCents');
  });

  it('rejects duplicate source record IDs', () => {
    const firstSale: RawPosSaleRecord = {
      recordType: 'sale',
      sourceRecordId: 'SRC-DUPLICATE-001',
      sourceTransactionId: 'TX-SALE-201',
      artistId: 'ART-001',
      artistName: 'Sample Artist',
      venueId: 'VENUE-001',
      venueName: 'Cornven Sample Venue',
      productId: 'PROD-001',
      productName: 'Sample Ceramic Cup',
      occurredAt: '2026-08-20T04:00:00.000Z',
      quantity: 1,
      unitPrice: '50.00',
      totalAmount: '50.00',
      commissionAmount: '42.50',
      tenantAmount: '7.50',
      rentalId: 'RENTAL-001',
      rentalCommissionRate: '0.85',
      currency: 'TWD',
    };

    const repeatedIdSale: RawPosSaleRecord = {
      ...firstSale,
      sourceTransactionId: 'TX-SALE-202',
    };

    expect(() => normalizeRawPosRecords([firstSale, repeatedIdSale], 'fraction')).toThrow(
      'Duplicate source record ID: SRC-DUPLICATE-001.',
    );
  });
});
