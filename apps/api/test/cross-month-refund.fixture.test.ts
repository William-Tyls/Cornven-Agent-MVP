import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { RawPosImportRequestSchema } from '@cornven/contracts';

import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';

const crossMonthImport = RawPosImportRequestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pos/cross-month-refund.json', import.meta.url), 'utf8'),
  ),
);

describe('cross-month refund fixture', () => {
  it('keeps the August SALE and October REFUND as independent canonical records', () => {
    const result = normalizeRawPosRecords(
      crossMonthImport.records,
      crossMonthImport.commissionRateUnit,
    );

    expect(result.summary).toEqual({
      totalRows: 2,
      saleRows: 1,
      refundRows: 1,
      exchangeRows: 0,
      canonicalSales: 2,
    });

    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: 'sale',
          sourceTransactionId: 'TX-SALE-CROSS-MONTH-001',
          parentTransactionId: null,
          soldAt: '2026-08-20T04:00:00.000Z',
          quantitySold: 2,
          grossSalesCents: 10_000,
          rentalCommissionBps: 8_500,
          currency: 'TWD',
        }),
        expect.objectContaining({
          recordType: 'refund',
          sourceTransactionId: 'TX-REFUND-CROSS-MONTH-001',
          parentTransactionId: 'TX-SALE-CROSS-MONTH-001',
          soldAt: '2026-10-03T04:00:00.000Z',
          quantitySold: -1,
          grossSalesCents: -5_000,
          rentalCommissionBps: 8_500,
          currency: 'TWD',
        }),
      ]),
    );
  });
});
