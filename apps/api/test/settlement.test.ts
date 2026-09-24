import request from 'supertest';
import { createApp } from '../src/app.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RawPosImportRequestSchema,
  SettlementPreviewInputSchema,
  SettlementPreviewSchema,
  type CanonicalSale,
} from '@cornven/contracts';
import { normalizeRawPosRecords } from '../src/modules/import/import.service.js';
import { calculateSettlementPreview } from '../src/modules/settlement/settlement.service.js';

const raw = RawPosImportRequestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pos/mock-sales.json', import.meta.url), 'utf8'),
  ),
);
const m2 = normalizeRawPosRecords(raw.records, raw.commissionRateUnit).records;
const golden = JSON.parse(
  readFileSync(new URL('../../../fixtures/settlement/golden-case.json', import.meta.url), 'utf8'),
);
const original = m2.find((r) => r.recordType === 'sale')!;
const refund = m2.find((r) => r.recordType === 'refund')!;
function report(change: Record<string, unknown> = {}) {
  return calculateSettlementPreview(
    SettlementPreviewInputSchema.parse({
      artistId: 'ART-001',
      artistName: 'Sample Artist',
      settlementMonth: '2026-08',
      asOf: '2026-09-01T00:00:00+08:00',
      sales: m2,
      bankTransferFeeCents: 0,
      ...change,
    }),
  );
}
function sale(id: string, change: Partial<CanonicalSale> = {}): CanonicalSale {
  return { ...original, sourceRecordId: id, sourceTransactionId: `TX-${id}`, ...change };
}

describe('Artist monthly report calculations', () => {
  it('matches the hand-calculated full report and leaves M2 records unchanged', () => {
    const before = structuredClone(m2);
    const result = calculateSettlementPreview(
      SettlementPreviewInputSchema.parse({ ...golden.input, sales: m2 }),
    );
    expect(result).toEqual(golden.expected);
    expect(m2).toEqual(before);
    expect(result.amountPayableToCreatorCents).toBeNull();
    expect(original.rentalCommissionBps).toBe(2000);
    expect(result.creatorRevenueShareAmountCents).toBe(12000);
    expect(result.rentals[0]!.rentalAmountCents).toBe(300000);
  });

  it('supports multiple rentals and rates and deducts one artist-level fee', () => {
    const other = sale('B', { rentalId: 'RENTAL-002', rentalCommissionBps: 1000 });
    const result = report({
      sales: [original, other, refund],
      bankTransferFeeCents: 1500,
    });
    expect(result.rentals).toHaveLength(2);
    expect(result.creatorRevenueShareAmountCents).toBe(12000 + 18000);
    expect(result.amountPayableToCreatorCents).toBe(28500);
  });

  it('uses the original M2 sale rate for cross-month refunds despite changed rental rates', () => {
    const sepSale = sale('SEP', { soldAt: '2026-09-10T00:00:00+08:00', rentalCommissionBps: 1500 });
    const sepRefund = { ...refund, soldAt: '2026-09-11T00:00:00+08:00', rentalCommissionBps: 500 };
    const result = report({
      settlementMonth: '2026-09',
      asOf: '2026-10-01T00:00:00+08:00',
      sales: [sepSale, sepRefund],
      historicalRecords: [original],
    });
    expect(result.totalProductSalesCents).toBe(20000);
    expect(result.refundsCents).toBe(5000);
    expect(result.creatorRevenueShareAmountCents).toBe(17000 - 4000);
    expect(result.rentals[0]!.revenueShares.map((g) => g.creatorCommissionBps)).toEqual([
      8000, 8500,
    ]);
    expect(report().creatorRevenueShareAmountCents).toBe(12000);
  });

  it('retains negative refund-only balances rather than clamping to zero', () => {
    const result = report({
      settlementMonth: '2026-09',
      asOf: '2026-10-01T00:00:00+08:00',
      sales: [{ ...refund, soldAt: '2026-09-10T00:00:00+08:00' }],
      historicalRecords: [original],
    });
    expect(result).toMatchObject({
      totalProductSalesCents: 0,
      refundsCents: 5000,
      validSalesCents: -5000,
      creatorRevenueShareAmountCents: -4000,
      amountPayableToCreatorCents: -4000,
    });
    expect(SettlementPreviewSchema.safeParse(result).success).toBe(true);
  });

  it('selects Taipei month boundaries and the inclusive month-to-date cutoff', () => {
    const rows = [
      sale('BEFORE', { soldAt: '2026-07-31T15:59:59.999Z' }),
      sale('START', { soldAt: '2026-07-31T16:00:00.000Z' }),
      sale('LAST', { soldAt: '2026-08-31T15:59:59.999Z' }),
      sale('NEXT', { soldAt: '2026-08-31T16:00:00.000Z' }),
      sale('OTHER', { artistId: 'OTHER' }),
    ];
    expect(report({ sales: rows }).totalProductSalesCents).toBe(40000);
    const provisional = report({ sales: [original, refund], asOf: '2026-08-12T07:30:00.000Z' });
    expect(provisional).toMatchObject({
      isProvisional: true,
      refundsCents: 5000,
      settlementPeriod: { from: '2026-08-01', to: '2026-08-12' },
    });
    expect(report({ asOf: '2026-08-12T07:29:59.999Z' }).refundsCents).toBe(0);
  });

  it('shows active zero-sale rentals and excludes expired rentals without transactions', () => {
    const rental = golden.input.rentals[0];
    const result = report({
      sales: [],
      rentals: [rental, { ...rental, rentalId: 'OLD', effectiveTo: '2026-07-01T00:00:00+08:00' }],
    });
    expect(result).toMatchObject({
      totalProductSalesCents: 0,
      creatorRevenueShareAmountCents: 0,
      amountPayableToCreatorCents: 0,
    });
    expect(result.rentals).toHaveLength(1);
    expect(result.rentals[0]!.revenueShares[0]!.creatorCommissionBps).toBeNull();
    expect(result.monthlyProductSalesDetails).toEqual([]);
  });

  it('calculates shares from M2 while leaving unknown fees and inventory unfilled', () => {
    const result = report({ bankTransferFeeCents: null });
    expect(result).toMatchObject({
      validSalesCents: 15000,
      creatorRevenueShareAmountCents: 12000,
      amountPayableToCreatorCents: null,
      bankTransferFeeCents: null,
      lowStockReminder: { status: 'unavailable' },
    });
    expect(result.rentals[0]!.revenueShares[0]).toMatchObject({
      creatorCommissionBps: 8000,
      platformCommissionBps: 2000,
    });
    expect(result.notes.join(' ')).toContain('fee');
  });

  it('requires a unique original sale even when the refund carries a rate', () => {
    expect(report({ sales: [refund] }).creatorRevenueShareAmountCents).toBeNull();
    expect(
      report({
        sales: [
          original,
          refund,
          sale('AMBIGUOUS', {
            sourceTransactionId: original.sourceTransactionId,
          }),
        ],
      }).creatorRevenueShareAmountCents,
    ).toBeNull();
  });

  it('rejects over-refunds using earlier refunds, including quantities', () => {
    const earlier = {
      ...refund,
      sourceRecordId: 'EARLIER',
      sourceTransactionId: 'TX-EARLIER',
      quantitySold: -4,
      grossSalesCents: -20000,
      sourceCommissionAmountCents: -5000,
      sourceTenantAmountCents: -15000,
    };
    const result = report({
      settlementMonth: '2026-09',
      asOf: '2026-10-01T00:00:00+08:00',
      historicalRecords: [original, earlier],
      sales: [{ ...refund, soldAt: '2026-09-10T00:00:00+08:00' }],
    });
    expect(result.creatorRevenueShareAmountCents).toBeNull();
    expect(result.notes.join(' ')).toContain('exceed');
    expect(
      report({ sales: [original, { ...refund, quantitySold: -5 }] }).amountPayableToCreatorCents,
    ).toBeNull();
  });

  it('deduplicates identical records across batches but rejects conflicting IDs', () => {
    expect(report({ sales: [...m2, ...m2], historicalRecords: m2 })).toEqual(report());
    expect(() => report({ sales: [...m2, { ...original, productName: 'Changed' }] })).toThrow(
      'Conflicting data',
    );
  });

  it('uses the rental platform rate, ignoring POS split amounts and cube rates', () => {
    const rows = m2.map((r) => ({
      ...r,
      rentalCommissionBps: 1500,
      cubeCommissionBps: 9999,
      sourceCommissionAmountCents: 0,
      sourceTenantAmountCents: r.grossSalesCents,
    }));
    const result = report({ sales: rows });
    expect(result.creatorRevenueShareAmountCents).toBe(12750);
    expect(result.rentals[0]!.revenueShares[0]).toMatchObject({
      creatorCommissionBps: 8500,
      platformCommissionBps: 1500,
    });
    expect(
      report({ sales: rows.map((r) => ({ ...r, rentalCommissionBps: 10000 })) })
        .creatorRevenueShareAmountCents,
    ).toBe(0);
    expect(
      report({ sales: rows.map((r) => ({ ...r, rentalCommissionBps: 0 })) })
        .creatorRevenueShareAmountCents,
    ).toBe(15000);
  });

  it('rejects missing or invalid M2 rental rates instead of inventing a default', () => {
    for (const rate of [undefined, null, -1, 10001, 1.5])
      expect(() => report({ sales: [{ ...original, rentalCommissionBps: rate }] })).toThrow();
  });

  it('rounds cumulative partial refunds so a fully returned sale reverses exactly', () => {
    const tiny = sale('TINY', {
      rentalCommissionBps: 5000,
      quantitySold: 3,
      unitPriceCents: 1,
      grossSalesCents: 3,
      sourceCommissionAmountCents: 0,
      sourceTenantAmountCents: 3,
    });
    const returns = Array.from({ length: 3 }, (_, i) => ({
      ...tiny,
      recordType: 'refund' as const,
      sourceRecordId: `RETURN-${i}`,
      sourceTransactionId: `RTX-${i}`,
      parentTransactionId: tiny.sourceTransactionId,
      soldAt: `2026-08-${10 + i}T00:00:00+08:00`,
      quantitySold: -1,
      grossSalesCents: -1,
      sourceCommissionAmountCents: 0,
      sourceTenantAmountCents: -1,
    }));
    const input = {
      sales: [tiny, ...returns],
    };
    expect(report(input).creatorRevenueShareAmountCents).toBe(0);
    expect(report({ ...input, sales: [...returns.reverse(), tiny] })).toEqual(report(input));
    expect(
      report({ ...input, asOf: '2026-08-10T23:59:59+08:00' }).creatorRevenueShareAmountCents,
    ).toBe(1);
  });

  it('groups product sales by price and uses POS amounts rather than price times quantity', () => {
    const discounted = sale('DISCOUNT', {
      unitPriceCents: 4000,
      grossSalesCents: 10000,
      sourceCommissionAmountCents: 2500,
      sourceTenantAmountCents: 7500,
    });
    const result = report({ sales: [original, discounted, refund] });
    expect(result.monthlyProductSalesDetails).toHaveLength(2);
    expect(result.monthlyProductSalesDetails.reduce((sum, p) => sum + p.salesAmountCents, 0)).toBe(
      30000,
    );
    expect(result.monthlyProductSalesDetails.reduce((sum, p) => sum + p.quantitySold, 0)).toBe(8);
  });

  it('uses the PR27 inventory scenarios, including unsold products and the low-stock boundary', () => {
    const inventory = golden.input.inventory;
    expect(inventory.items).toHaveLength(10);
    const result = report({ inventory });
    expect(result.lowStockReminder.capturedAt).toBe('2026-08-31T15:59:59.000Z');
    expect(
      result.lowStockReminder.products.map((p) => [p.sku, p.currentStock, p.monthlyQuantitySold]),
    ).toEqual([
      ['SKU-A-001', 1, 4],
      ['SKU-A-002', 0, 0],
      ['SKU-A-003', 0, 0],
      ['SKU-A-004', 1, 0],
    ]);
    expect(
      report({ inventory, sales: [] }).lowStockReminder.products.every(
        (p) => p.monthlyQuantitySold === 0,
      ),
    ).toBe(true);
    expect(report({ inventory })).toEqual(result);
  });

  it('only claims no low stock for complete supplied inventory', () => {
    const inventory = golden.input.inventory;
    expect(report({ inventory: { ...inventory, complete: false } }).lowStockReminder.status).toBe(
      'unavailable',
    );
    expect(
      report({
        inventory: {
          ...inventory,
          items: inventory.items.map((p: object) => ({ ...p, currentStock: 2 })),
        },
      }).lowStockReminder.message,
    ).toBe('No low stock products this month');
    expect(() =>
      report({ inventory: { ...inventory, capturedAt: '2026-10-01T00:00:00Z' } }),
    ).toThrow();
  });

  it('rejects other currencies in selected transactions and inconsistent rental venues', () => {
    expect(() => report({ sales: [{ ...original, currency: 'AUD' }] })).toThrow('TWD');
    expect(() => report({ rentals: [{ ...golden.input.rentals[0], venueId: 'WRONG' }] })).toThrow(
      'venue',
    );
  });
});

describe('M3 HTTP integration', () => {
  const app = createApp();
  it('accepts unchanged M2 HTTP records plus supplied PR27 mock context and returns the full report', async () => {
    const normalized = await request(app).post('/api/v1/imports/mock/normalize').send(raw);
    expect(normalized.status).toBe(200);
    const response = await request(app)
      .post('/api/v1/settlements/preview')
      .send({ ...golden.input, sales: normalized.body.records });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(golden.expected);
    expect(response.body).not.toHaveProperty('sourceTenantAmountCents');
    expect(response.body).not.toHaveProperty('requiresReview');
  });
  it('rejects malformed M3 context through the normal API error envelope', async () => {
    const response = await request(app)
      .post('/api/v1/settlements/preview')
      .send({ ...golden.input, sales: m2, businessTimezone: 'Australia/Sydney' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
