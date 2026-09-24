import { describe, expect, it } from 'vitest';

import {
  agentToolDefinitions,
  CanonicalSaleSchema,
  CitationSchema,
  DocumentSearchInputSchema,
  DocumentSearchOutputSchema,
  RawPosImportRequestSchema,
  SettlementPreviewInputSchema,
} from './index.js';

const sale = {
  recordType: 'sale' as const,
  sourceRecordId: 'SRC-SALE-001',
  sourceTransactionId: 'TX-001',
  parentTransactionId: null,

  artistId: 'ART-001',
  artistName: 'Sample Artist',
  venueId: 'VENUE-001',
  venueName: 'Sample Venue',

  productId: 'PROD-001',
  sku: 'SKU-001',
  productName: 'Sample Product',

  soldAt: '2026-08-05T02:00:00.000Z',
  quantitySold: 4,
  unitPriceCents: 5_000,

  grossSalesCents: 20_000,
  sourceCommissionAmountCents: 5_000,
  sourceTenantAmountCents: 15_000,

  rentalId: 'RENTAL-001',
  rentalCommissionBps: 2_000,
  cubeId: 'CUBE-001',
  cubeCommissionBps: 2_500,
  currency: 'TWD',
};

const refund = {
  ...sale,
  recordType: 'refund' as const,
  sourceRecordId: 'SRC-REFUND-001',
  sourceTransactionId: 'TX-REFUND-001',
  parentTransactionId: 'TX-001',

  soldAt: '2026-08-06T02:00:00.000Z',
  quantitySold: -1,

  grossSalesCents: -5_000,
  sourceCommissionAmountCents: -1_250,
  sourceTenantAmountCents: -3_750,
};

const settlement = {
  artistId: 'ART-001',
  settlementMonth: '2026-08',
  asOf: '2026-09-01T00:00:00+08:00',
  sales: [sale],
};

describe('POS-aligned contracts', () => {
  it('accepts an independent Canonical SALE record', () => {
    expect(CanonicalSaleSchema.parse(sale)).toEqual(sale);
  });

  it('accepts an independent Canonical REFUND record', () => {
    expect(CanonicalSaleSchema.parse(refund)).toEqual(refund);
  });

  it('rejects a SALE with a parent transaction ID', () => {
    expect(
      CanonicalSaleSchema.safeParse({
        ...sale,
        parentTransactionId: 'TX-OTHER',
      }).success,
    ).toBe(false);
  });

  it('rejects a REFUND without a parent transaction ID', () => {
    expect(
      CanonicalSaleSchema.safeParse({
        ...refund,
        parentTransactionId: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a REFUND with a non-negative quantity', () => {
    expect(
      CanonicalSaleSchema.safeParse({
        ...refund,
        quantitySold: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects POS split amounts that do not add up to gross sales', () => {
    expect(
      CanonicalSaleSchema.safeParse({
        ...sale,
        sourceTenantAmountCents: 14_999,
      }).success,
    ).toBe(false);
  });

  it('validates raw refund records with negative quantities and amounts', () => {
    const rawRefund = {
      recordType: 'refund',
      sourceRecordId: 'SRC-REFUND-001',
      sourceTransactionId: 'TX-REFUND-001',
      parentTransactionId: 'TX-001',
      artistId: 'ART-001',
      artistName: 'Sample Artist',
      venueId: 'VENUE-001',
      venueName: 'Sample Venue',
      productId: 'PROD-001',
      productName: 'Sample Product',
      occurredAt: '2026-08-05T03:00:00.000Z',
      currency: 'AUD',
      quantity: -1,
      unitPrice: '50.00',
      totalAmount: '-50.00',
      commissionAmount: '-12.50',
      tenantAmount: '-37.50',
      rentalId: 'RENTAL-001',
      rentalCommissionRate: '0.20',
    };

    expect(
      RawPosImportRequestSchema.safeParse({
        commissionRateUnit: 'fraction',
        records: [rawRefund],
      }).success,
    ).toBe(true);

    expect(
      RawPosImportRequestSchema.safeParse({
        commissionRateUnit: 'fraction',
        records: [{ ...rawRefund, quantity: 1 }],
      }).success,
    ).toBe(false);

    expect(
      RawPosImportRequestSchema.safeParse({
        commissionRateUnit: 'fraction',
        records: [{ ...rawRefund, tenantAmount: '-37.49' }],
      }).success,
    ).toBe(false);
  });

  it('accepts multiple rentals but rejects removed single-rental parameters', () => {
    expect(
      SettlementPreviewInputSchema.safeParse({
        ...settlement,
        sales: [sale, { ...sale, sourceRecordId: 'OTHER', rentalId: 'RENTAL-OTHER' }],
      }).success,
    ).toBe(true);
    expect(
      SettlementPreviewInputSchema.safeParse({
        ...settlement,
        rentalId: 'RENTAL-OTHER',
      }).success,
    ).toBe(false);
  });

  it('uses TWD/Taipei and rejects the old Sydney context', () => {
    expect(SettlementPreviewInputSchema.parse(settlement)).toMatchObject({
      currency: 'TWD',
      businessTimezone: 'Asia/Taipei',
    });
    expect(
      SettlementPreviewInputSchema.safeParse({
        ...settlement,
        businessTimezone: 'Australia/Sydney',
      }).success,
    ).toBe(false);
  });

  it('returns a validation result instead of throwing for an invalid timestamp', () => {
    expect(() =>
      SettlementPreviewInputSchema.safeParse({
        ...settlement,
        sales: [{ ...sale, soldAt: 'not-a-date' }],
      }),
    ).not.toThrow();
  });

  it('declares unique, read-only Agent tools with input and output boundaries', () => {
    expect(new Set(agentToolDefinitions.map((tool) => tool.name)).size).toBe(
      agentToolDefinitions.length,
    );

    expect(
      agentToolDefinitions.every(
        (tool) => tool.readOnly && tool.input.type === 'object' && tool.output.type === 'object',
      ),
    ).toBe(true);
  });

  it('rejects client-supplied document permissions and inconsistent evidence flags', () => {
    expect(
      DocumentSearchInputSchema.safeParse({
        query: '補貨流程',
        permissionTags: ['staff'],
      }).success,
    ).toBe(false);

    expect(
      DocumentSearchOutputSchema.safeParse({
        query: '補貨流程',
        evidenceSufficient: true,
        results: [],
      }).success,
    ).toBe(false);
  });

  it('keeps document search results compatible with the Assistant citation contract', () => {
    const searchResult = DocumentSearchOutputSchema.parse({
      query: '補貨流程',
      evidenceSufficient: true,
      results: [
        {
          documentId: 'onsite-operations',
          documentVersion: '2026-09-07-local-export',
          chunkId: 'a'.repeat(64),
          title: '南埕衖事 Cornven 現場營運',
          locator: '補貨 > 需要先通知',
          excerpt: '補貨前應先通知相關人員。',
          content: '補貨前應先通知相關人員。',
        },
      ],
    }).results[0];

    expect(
      CitationSchema.safeParse({
        documentId: searchResult?.documentId,
        documentVersion: searchResult?.documentVersion,
        chunkId: searchResult?.chunkId,
        title: searchResult?.title,
        locator: searchResult?.locator,
        excerpt: searchResult?.excerpt,
      }).success,
    ).toBe(true);
  });

  it('accepts the full Assistant message length as a document query', () => {
    expect(DocumentSearchInputSchema.safeParse({ query: '問'.repeat(4_000) }).success).toBe(true);
    expect(DocumentSearchInputSchema.safeParse({ query: '問'.repeat(4_001) }).success).toBe(false);
  });
});

describe('sales.search and artist.get Agent Tool contracts (M5 review)', () => {
  it('sales.search input allows optional rentalId, periodStart, periodEnd', () => {
    const salesSearchTool = agentToolDefinitions.find((tool) => tool.name === 'sales.search');
    expect(salesSearchTool?.input.required).toEqual(['artistId']);
    expect(salesSearchTool?.input.properties).toHaveProperty('rentalId');
    expect(salesSearchTool?.input.properties).toHaveProperty('periodStart');
    expect(salesSearchTool?.input.properties).toHaveProperty('periodEnd');
  });

  it('sales.search output declares Tool-computed top-level summary fields', () => {
    const salesSearchTool = agentToolDefinitions.find((tool) => tool.name === 'sales.search');
    const requiredOutput = salesSearchTool?.output.required ?? [];
    expect(requiredOutput).toEqual(
      expect.arrayContaining([
        'recordCount',
        'grossSalesCents',
        'refundAmountCents',
        'netSalesCents',
        'sourceCommissionAmountCents',
        'sourceTenantAmountCents',
        'currency',
        'records',
      ]),
    );
  });

  it('artist.get activeRentals includes fixedRentCents', () => {
    const artistGetTool = agentToolDefinitions.find((tool) => tool.name === 'artist.get');
    const activeRentalsSchema = artistGetTool?.output.properties.activeRentals as {
      items: { properties: Record<string, unknown> };
    };
    expect(activeRentalsSchema.items.properties).toHaveProperty('fixedRentCents');
  });
});

describe('monthly refund tool contract', () => {
  it('adds focused metrics without replacing the existing sales.search contract', () => {
    const tool = agentToolDefinitions.find((item) => item.name === 'sales.refunds');
    expect(tool?.input.required).toEqual(['artistId', 'settlementMonth']);
    expect(tool?.output.required).toEqual(
      expect.arrayContaining([
        'refundQuantity',
        'refundTransactionCount',
        'refundRecordCount',
        'refundAmountCents',
      ]),
    );
  });
});
