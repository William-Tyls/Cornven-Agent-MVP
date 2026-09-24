import { describe, expect, it } from 'vitest';

import { MonthlyReportDocumentSchema } from './reporting.js';

const validReport = {
  reportId: 'REPORT-2026-09-ART-001',
  generatedAt: '2026-10-01T09:30:00+08:00',
  language: 'en',
  reportStatus: 'draft',
  settlementMonth: '2026-09',
  settlementPeriod: {
    from: '2026-09-01',
    to: '2026-09-30',
    asOf: '2026-10-01T09:00:00+08:00',
  },
  creator: {
    artistId: 'ART-001',
    artistName: 'Example Artist',
    brandName: 'Example Studio',
    displayName: 'Example Studio',
  },
  currency: 'TWD',
  businessTimezone: 'Asia/Taipei',
  isProvisional: true,
  financialSummary: {
    totalProductSalesCents: 50_000,
    refundsCents: 5_000,
    validSalesCents: 45_000,
    creatorRevenueShareAmountCents: 27_000,
    bankTransferFeeCents: null,
    amountPayableToCreatorCents: null,
  },
  rentals: [
    {
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      venueName: 'Cornven Taipei',
      rentalAmountCents: 160_000,
      totalProductSalesCents: 50_000,
      refundsCents: 5_000,
      validSalesCents: 45_000,
      creatorRevenueShareAmountCents: 27_000,
      revenueShares: [
        {
          creatorCommissionBps: 6_000,
          platformCommissionBps: 4_000,
          totalProductSalesCents: 50_000,
          refundsCents: 5_000,
          validSalesCents: 45_000,
          creatorRevenueShareAmountCents: 27_000,
        },
      ],
    },
  ],
  monthlyProductSalesDetails: [
    {
      productId: 'PRODUCT-001',
      productName: 'Example Print',
      sku: 'SKU-001',
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      unitPriceCents: 10_000,
      quantitySold: 5,
      salesAmountCents: 50_000,
    },
  ],
  lowStockReminder: {
    status: 'available',
    capturedAt: '2026-10-01T08:45:00+08:00',
    products: [
      {
        productId: 'PRODUCT-001',
        productName: 'Example Print',
        sku: 'SKU-001',
        venueId: 'VENUE-001',
        venueName: 'Cornven Taipei',
        currentStock: 1,
        monthlyQuantitySold: 5,
      },
    ],
    message: null,
  },
  notes: ['Bank transfer fee and final amount are pending confirmation.'],
} as const;

describe('MonthlyReportDocumentSchema', () => {
  it('accepts a complete canonical M4 report document without changing it', () => {
    expect(MonthlyReportDocumentSchema.parse(validReport)).toEqual(validReport);
  });

  it('accepts legal nulls and empty report sections', () => {
    const minimalReport = {
      ...validReport,
      creator: {
        ...validReport.creator,
        artistName: null,
        brandName: null,
        displayName: 'ART-001',
      },
      financialSummary: {
        ...validReport.financialSummary,
        creatorRevenueShareAmountCents: null,
        bankTransferFeeCents: null,
        amountPayableToCreatorCents: null,
      },
      rentals: [],
      monthlyProductSalesDetails: [],
      lowStockReminder: {
        status: 'unavailable',
        capturedAt: null,
        products: [],
        message: null,
      },
      notes: [],
    } as const;

    expect(MonthlyReportDocumentSchema.parse(minimalReport)).toEqual(minimalReport);
  });

  it('requires the M4-owned draft report status and rejects legacy settlement metadata', () => {
    expect(
      MonthlyReportDocumentSchema.safeParse({ ...validReport, reportStatus: 'calculated' }).success,
    ).toBe(false);
    expect(
      MonthlyReportDocumentSchema.safeParse({
        ...validReport,
        settlementRunId: 'SETTLEMENT-RUN-001',
      }).success,
    ).toBe(false);
  });

  it('uses YYYY-MM internally and rejects the display-only MM/YYYY form', () => {
    expect(MonthlyReportDocumentSchema.safeParse(validReport).success).toBe(true);
    expect(
      MonthlyReportDocumentSchema.safeParse({ ...validReport, settlementMonth: '09/2026' }).success,
    ).toBe(false);
    expect(
      MonthlyReportDocumentSchema.safeParse({ ...validReport, settlementMonth: '1999-12' }).success,
    ).toBe(false);
  });

  it('requires the mapper-provided creator display name', () => {
    const creatorWithoutDisplayName = {
      artistId: validReport.creator.artistId,
      artistName: validReport.creator.artistName,
      brandName: validReport.creator.brandName,
    };

    expect(
      MonthlyReportDocumentSchema.safeParse({
        ...validReport,
        creator: creatorWithoutDisplayName,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['currency', { ...validReport, currency: 'AUD' }],
    ['business timezone', { ...validReport, businessTimezone: 'Australia/Sydney' }],
    ['language', { ...validReport, language: 'zh-TW' }],
  ])('rejects an unsupported %s', (_label, report) => {
    expect(MonthlyReportDocumentSchema.safeParse(report).success).toBe(false);
  });

  it('rejects a malformed required numeric value', () => {
    const malformedReport = {
      ...validReport,
      financialSummary: {
        ...validReport.financialSummary,
        totalProductSalesCents: '50000',
      },
    };

    expect(MonthlyReportDocumentSchema.safeParse(malformedReport).success).toBe(false);
  });

  it('accepts type-valid but arithmetically inconsistent totals without recalculating them', () => {
    const m3OwnedAmounts = {
      ...validReport,
      financialSummary: {
        ...validReport.financialSummary,
        totalProductSalesCents: 100,
        refundsCents: 90,
        validSalesCents: 999,
        creatorRevenueShareAmountCents: -123,
      },
    };

    expect(MonthlyReportDocumentSchema.parse(m3OwnedAmounts)).toEqual(m3OwnedAmounts);
  });

  it('does not enforce or recalculate the M3-owned low-stock threshold', () => {
    const m3SelectedLowStock = {
      ...validReport,
      lowStockReminder: {
        ...validReport.lowStockReminder,
        products: [
          {
            ...validReport.lowStockReminder.products[0],
            currentStock: 42,
          },
        ],
      },
    };

    expect(MonthlyReportDocumentSchema.parse(m3SelectedLowStock)).toEqual(m3SelectedLowStock);
    expect(
      MonthlyReportDocumentSchema.safeParse({
        ...validReport,
        lowStockReminder: { ...validReport.lowStockReminder, products: [] },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields at the report and nested object boundaries', () => {
    expect(MonthlyReportDocumentSchema.safeParse({ ...validReport, version: 1 }).success).toBe(
      false,
    );
    expect(
      MonthlyReportDocumentSchema.safeParse({
        ...validReport,
        creator: { ...validReport.creator, unexpected: true },
      }).success,
    ).toBe(false);
  });
});
