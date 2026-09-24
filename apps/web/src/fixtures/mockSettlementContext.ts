import type { SettlementPreviewInput } from '@cornven/contracts';

/**
 * Mirrors the non-sales fields of fixtures/settlement/golden-case.json (the team's
 * v0.3 monthly report acceptance example). Sales/historicalRecords come from
 * normalizing fixtures/pos/mock-sales.json instead, matching apps/api's own
 * "M3 HTTP integration" test.
 */
export const mockSettlementContext: Pick<
  SettlementPreviewInput,
  | 'artistId'
  | 'artistName'
  | 'settlementMonth'
  | 'asOf'
  | 'rentals'
  | 'bankTransferFeeCents'
  | 'inventory'
> = {
  artistId: 'ART-001',
  artistName: 'Sample Artist',
  settlementMonth: '2026-08',
  asOf: '2026-09-01T00:00:00+08:00',
  rentals: [
    {
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      venueName: 'Cornven Sample Venue',
      effectiveFrom: '2026-05-16T00:00:00+08:00',
      effectiveTo: null,
      monthlyRentCents: 300_000,
    },
  ],
  bankTransferFeeCents: null,
  inventory: {
    capturedAt: '2026-08-31T15:59:59.000Z',
    complete: true,
    items: [
      {
        productId: 'PROD-001',
        productName: 'Sample Ceramic Cup',
        sku: 'SKU-A-001',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 1,
      },
      {
        productId: 'PROD-002',
        productName: 'Hand-painted Vase',
        sku: 'SKU-A-002',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 0,
      },
      {
        productId: 'PROD-003',
        productName: 'Woven Coaster Set',
        sku: 'SKU-A-003',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 0,
      },
      {
        productId: 'PROD-004',
        productName: 'Ceramic Plate',
        sku: 'SKU-A-004',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 1,
      },
      {
        productId: 'PROD-005',
        productName: 'Clay Incense Holder',
        sku: 'SKU-A-005',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 2,
      },
      {
        productId: 'PROD-006',
        productName: 'Textured Bowl',
        sku: 'SKU-A-006',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 3,
      },
      {
        productId: 'PROD-007',
        productName: 'Glazed Mug',
        sku: 'SKU-A-007',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 5,
      },
      {
        productId: 'PROD-008',
        productName: 'Small Planter',
        sku: 'SKU-A-008',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 8,
      },
      {
        productId: 'PROD-009',
        productName: 'Decorative Tile',
        sku: 'SKU-A-009',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 12,
      },
      {
        productId: 'PROD-010',
        productName: 'Wall Hanging',
        sku: 'SKU-A-010',
        venueId: 'VENUE-001',
        venueName: 'Cornven Sample Venue',
        currentStock: 20,
      },
    ],
  },
};
