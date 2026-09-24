import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { RawPosImportRequestSchema } from '@cornven/contracts';

import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';
import { buildMonthlyReportContext } from '../src/modules/import/monthly-report-context.service.js';

const crossMonthImport = RawPosImportRequestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pos/cross-month-refund.json', import.meta.url), 'utf8'),
  ),
);

const normalization = normalizeRawPosRecords(
  crossMonthImport.records,
  crossMonthImport.commissionRateUnit,
);

describe('buildMonthlyReportContext', () => {
  it('puts the October REFUND in sales and the original August SALE in historicalRecords', () => {
    const context = buildMonthlyReportContext({
      artistId: 'ART-001',
      settlementMonth: '2026-10',
      asOf: '2026-10-31T15:59:59.999Z',
      records: normalization.records,
    });

    expect(context.sales).toEqual([
      expect.objectContaining({
        recordType: 'refund',
        sourceTransactionId: 'TX-REFUND-CROSS-MONTH-001',
        parentTransactionId: 'TX-SALE-CROSS-MONTH-001',
        grossSalesCents: -5_000,
        rentalCommissionBps: 8_500,
      }),
    ]);

    expect(context.historicalRecords).toEqual([
      expect.objectContaining({
        recordType: 'sale',
        sourceTransactionId: 'TX-SALE-CROSS-MONTH-001',
        grossSalesCents: 10_000,
        rentalCommissionBps: 8_500,
      }),
    ]);
  });

  it('does not include the future October REFUND in an August report', () => {
    const context = buildMonthlyReportContext({
      artistId: 'ART-001',
      settlementMonth: '2026-08',
      asOf: '2026-08-31T15:59:59.999Z',
      records: normalization.records,
    });

    expect(context.sales).toEqual([
      expect.objectContaining({
        recordType: 'sale',
        sourceTransactionId: 'TX-SALE-CROSS-MONTH-001',
        grossSalesCents: 10_000,
      }),
    ]);

    expect(context.sales).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransactionId: 'TX-REFUND-CROSS-MONTH-001',
        }),
      ]),
    );

    expect(context.historicalRecords).toEqual([]);
  });

  it('includes an earlier REFUND in historicalRecords when the same SALE is refunded again', () => {
    const originalRefund = normalization.records.find((record) => record.recordType === 'refund');

    if (!originalRefund || originalRefund.recordType !== 'refund') {
      throw new Error('Expected a REFUND in the cross-month fixture.');
    }

    const earlierRefund = {
      ...originalRefund,
      sourceRecordId: 'SRC-REFUND-CROSS-MONTH-EARLIER-001',
      sourceTransactionId: 'TX-REFUND-CROSS-MONTH-EARLIER-001',
      soldAt: '2026-09-10T04:00:00.000Z',
    };

    const context = buildMonthlyReportContext({
      artistId: 'ART-001',
      settlementMonth: '2026-10',
      asOf: '2026-10-31T15:59:59.999Z',
      records: [...normalization.records, earlierRefund],
    });

    expect(context.sales).toEqual([
      expect.objectContaining({
        recordType: 'refund',
        sourceTransactionId: 'TX-REFUND-CROSS-MONTH-001',
        parentTransactionId: 'TX-SALE-CROSS-MONTH-001',
      }),
    ]);

    expect(context.historicalRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: 'sale',
          sourceTransactionId: 'TX-SALE-CROSS-MONTH-001',
        }),
        expect.objectContaining({
          recordType: 'refund',
          sourceTransactionId: 'TX-REFUND-CROSS-MONTH-EARLIER-001',
          parentTransactionId: 'TX-SALE-CROSS-MONTH-001',
        }),
      ]),
    );

    expect(context.historicalRecords).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransactionId: 'TX-REFUND-CROSS-MONTH-001',
        }),
      ]),
    );
  });
});
