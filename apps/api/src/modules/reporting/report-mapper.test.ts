import { describe, expect, it } from 'vitest';

import { mapM3SettlementPreviewToMonthlyReport } from './report-mapper.js';

const completeM3SettlementPreview = {
  settlementMonth: '08/2026',
  creator: {
    artistId: 'ARTIST-001',
    artistName: 'Yuen',
    brandName: "Yuen's Factory",
  },
  venues: [
    {
      venueId: 'VENUE-001',
      venueName: 'Nan Cheng Lane',
    },
    {
      venueId: 'VENUE-002',
      venueName: 'Second Gallery',
    },
  ],
  settlementPeriod: {
    from: '2026-08-01',
    to: '2026-08-31',
    asOf: '2026-09-01T01:02:03.000Z',
  },
  currency: 'TWD',
  businessTimezone: 'Asia/Taipei',
  isProvisional: true,
  totalProductSalesCents: 123_456,
  refundsCents: 5_000,
  validSalesCents: 118_456,
  creatorRevenueShareAmountCents: 77_500,
  bankTransferFeeCents: 300,
  amountPayableToCreatorCents: 77_200,
  rentals: [
    {
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      venueName: 'Nan Cheng Lane',
      rentalAmountCents: 160_000,
      totalProductSalesCents: 80_000,
      refundsCents: 2_000,
      validSalesCents: 78_000,
      creatorRevenueShareAmountCents: 50_700,
      revenueShares: [
        {
          creatorCommissionBps: 6_500,
          platformCommissionBps: 3_500,
          totalProductSalesCents: 50_000,
          refundsCents: 1_000,
          validSalesCents: 49_000,
          creatorRevenueShareAmountCents: 31_850,
        },
        {
          creatorCommissionBps: 7_000,
          platformCommissionBps: 3_000,
          totalProductSalesCents: 30_000,
          refundsCents: 1_000,
          validSalesCents: 29_000,
          creatorRevenueShareAmountCents: 20_300,
        },
      ],
    },
    {
      rentalId: 'RENTAL-002',
      venueId: 'VENUE-002',
      venueName: 'Second Gallery',
      rentalAmountCents: null,
      totalProductSalesCents: 43_456,
      refundsCents: 3_000,
      validSalesCents: 40_456,
      creatorRevenueShareAmountCents: 26_800,
      revenueShares: [],
    },
  ],
  monthlyProductSalesDetails: [
    {
      productId: 'PRODUCT-001',
      productName: 'Moon Rabbit Print',
      sku: 'SKU-MOON-01',
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      unitPriceCents: 20_000,
      quantitySold: 4,
      salesAmountCents: 80_000,
    },
  ],
  lowStockReminder: {
    status: 'available',
    capturedAt: '2026-09-01T00:30:00.000Z',
    products: [
      {
        productId: 'PRODUCT-LOW-001',
        productName: 'Low Stock Postcard',
        sku: 'SKU-LOW-01',
        venueId: 'VENUE-001',
        venueName: 'Nan Cheng Lane',
        currentStock: 1,
        monthlyQuantitySold: 9,
      },
    ],
    message: null,
  },
  notes: ['Synthetic M3 settlement fixture.'],
} as const;

function map(settlement: unknown = completeM3SettlementPreview) {
  return mapM3SettlementPreviewToMonthlyReport({
    reportId: 'REPORT-2026-08-001',
    generatedAt: '2026-09-02T03:04:05.000Z',
    settlement,
  });
}

describe('mapM3SettlementPreviewToMonthlyReport', () => {
  it('maps a complete PR25-shaped M3 settlement preview into the M4 report document', () => {
    const report = map();

    expect(report).toMatchObject({
      reportId: 'REPORT-2026-08-001',
      generatedAt: '2026-09-02T03:04:05.000Z',
      language: 'en',
      reportStatus: 'draft',
      settlementMonth: '2026-08',
      creator: {
        artistId: 'ARTIST-001',
        artistName: 'Yuen',
        brandName: "Yuen's Factory",
        displayName: "Yuen's Factory",
      },
    });
    expect(report.financialSummary).toEqual({
      totalProductSalesCents: 123_456,
      refundsCents: 5_000,
      validSalesCents: 118_456,
      creatorRevenueShareAmountCents: 77_500,
      bankTransferFeeCents: 300,
      amountPayableToCreatorCents: 77_200,
    });
    expect(report.rentals).toEqual(completeM3SettlementPreview.rentals);
    expect(report.monthlyProductSalesDetails).toEqual(
      completeM3SettlementPreview.monthlyProductSalesDetails,
    );
    expect(report.lowStockReminder).toEqual(completeM3SettlementPreview.lowStockReminder);
    expect(report.notes).toEqual(completeM3SettlementPreview.notes);
  });

  it.each([
    {
      creator: { artistId: 'ARTIST-001', artistName: 'Yuen', brandName: 'Studio' },
      displayName: 'Studio',
    },
    {
      creator: { artistId: 'ARTIST-001', artistName: 'Yuen', brandName: null },
      displayName: 'Yuen',
    },
    {
      creator: { artistId: 'ARTIST-001', artistName: null, brandName: null },
      displayName: 'ARTIST-001',
    },
  ])('uses the required creator display-name fallback', ({ creator, displayName }) => {
    const report = map({ ...completeM3SettlementPreview, creator });

    expect(report.creator.displayName).toBe(displayName);
  });

  it('preserves nullable M3 amounts without calculating replacements', () => {
    const report = map({
      ...completeM3SettlementPreview,
      creatorRevenueShareAmountCents: null,
      bankTransferFeeCents: null,
      amountPayableToCreatorCents: null,
      rentals: [
        {
          ...completeM3SettlementPreview.rentals[0],
          rentalAmountCents: null,
          creatorRevenueShareAmountCents: null,
        },
      ],
    });

    expect(report.financialSummary.creatorRevenueShareAmountCents).toBeNull();
    expect(report.financialSummary.bankTransferFeeCents).toBeNull();
    expect(report.financialSummary.amountPayableToCreatorCents).toBeNull();
    expect(report.rentals[0]?.rentalAmountCents).toBeNull();
    expect(report.rentals[0]?.creatorRevenueShareAmountCents).toBeNull();
  });

  it('rejects malformed PR25 venue rows even though venues are not part of the M4 document', () => {
    expect(() =>
      map({
        ...completeM3SettlementPreview,
        venues: [{ venueId: 1, venueName: 'Nan Cheng Lane' }],
      }),
    ).toThrow();
  });

  it.each([
    [
      'an impossible from day',
      { from: '2026-02-30', to: completeM3SettlementPreview.settlementPeriod.to },
    ],
    [
      'an impossible to day',
      { from: completeM3SettlementPreview.settlementPeriod.from, to: '2026-02-30' },
    ],
    [
      'an invalid from month',
      { from: '2026-13-01', to: completeM3SettlementPreview.settlementPeriod.to },
    ],
    [
      'an invalid to month',
      { from: completeM3SettlementPreview.settlementPeriod.from, to: '2026-00-01' },
    ],
  ])('rejects %s at the M4 calendar-date boundary', (_label, dates) => {
    expect(() =>
      map({
        ...completeM3SettlementPreview,
        settlementPeriod: {
          ...completeM3SettlementPreview.settlementPeriod,
          ...dates,
        },
      }),
    ).toThrow();
  });

  it('accepts and preserves a valid leap-day settlement period', () => {
    const report = map({
      ...completeM3SettlementPreview,
      settlementMonth: '02/2028',
      settlementPeriod: {
        from: '2028-02-29',
        to: '2028-02-29',
        asOf: '2028-03-01T01:02:03.000Z',
      },
    });

    expect(report.settlementPeriod).toEqual({
      from: '2028-02-29',
      to: '2028-02-29',
      asOf: '2028-03-01T01:02:03.000Z',
    });
  });

  it.each([
    ['malformed month', { ...completeM3SettlementPreview, settlementMonth: '2026-08' }],
    ['impossible month', { ...completeM3SettlementPreview, settlementMonth: '13/2026' }],
    [
      'malformed period date',
      {
        ...completeM3SettlementPreview,
        settlementPeriod: { ...completeM3SettlementPreview.settlementPeriod, from: '2026/08/01' },
      },
    ],
    [
      'malformed monetary amount',
      { ...completeM3SettlementPreview, totalProductSalesCents: '123456' },
    ],
  ])('rejects %s at the M3 boundary', (_label, settlement) => {
    expect(() => map(settlement)).toThrow();
  });
});
