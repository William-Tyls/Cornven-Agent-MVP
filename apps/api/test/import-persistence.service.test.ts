import { database } from '@cornven/database';
import type { CanonicalSale } from '@cornven/contracts';
import { describe, expect, it } from 'vitest';

import { persistImportBatch } from '../src/modules/import/import-persistence.service.js';

function buildSale(overrides: Partial<CanonicalSale> = {}): CanonicalSale {
  return {
    recordType: 'sale',
    sourceRecordId: `SRC-${Math.random()}`,
    sourceTransactionId: `TX-${Math.random()}`,
    artistId: 'ART-001',
    artistName: 'Sample Artist',
    venueId: 'VENUE-001',
    venueName: 'Sample Venue',
    productId: 'PROD-001',
    productName: 'Sample Product',
    soldAt: '2026-09-01T00:00:00.000Z',
    quantitySold: 2,
    unitPriceCents: 5_000,
    grossSalesCents: 10_000,
    sourceCommissionAmountCents: 2_500,
    sourceTenantAmountCents: 7_500,
    rentalId: 'RENTAL-001',
    rentalCommissionBps: 2_500,
    currency: 'TWD',
    ...overrides,
  } as CanonicalSale;
}

describe.skipIf(
  process.env.RUN_REPORT_INTEGRATION !== 'true' ||
    !process.env.DATABASE_URL?.includes('/cornven_planb_import_test'),
)('persistImportBatch (M1 persistence service for M2 to call)', () => {
  it('creates an ImportBatch and Sale rows for valid canonical records', async () => {
    const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
    const venue = await database.venue.findFirst({ where: { externalRef: 'VENUE-001' } });
    const product = await database.product.findFirst({ where: { sku: 'SKU-A-001' } });
    const rental = await database.rental.findFirst({ where: { externalRef: 'RENTAL-001' } });
    if (!artist || !venue || !product || !rental) {
      throw new Error('Expected seeded ART-001/VENUE-001/SKU-A-001/RENTAL-001 to exist.');
    }

    const sale = buildSale({
      artistId: artist.id,
      venueId: venue.id,
      productId: product.id,
      rentalId: rental.id,
      sourceTransactionId: `TX-persist-test-${Date.now()}`,
    });

    const result = await persistImportBatch({
      fileContent: `unique-test-content-${Date.now()}`,
      records: [sale],
      failedRows: [],
    });

    expect(result.status).toBe('IMPORTED');
    expect(result.validRows).toBe(1);
    expect(result.invalidRows).toBe(0);

    const storedSale = await database.sale.findUnique({
      where: { dedupeKey: sale.sourceTransactionId },
    });
    expect(storedSale).not.toBeNull();
    expect(storedSale?.recordType).toBe('SALE');
  });

  it('links a refund to its parent sale within the same batch via parentTransactionId', async () => {
    const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
    const venue = await database.venue.findFirst({ where: { externalRef: 'VENUE-001' } });
    const product = await database.product.findFirst({ where: { sku: 'SKU-A-001' } });
    const rental = await database.rental.findFirst({ where: { externalRef: 'RENTAL-001' } });
    if (!artist || !venue || !product || !rental) {
      throw new Error('Expected seeded ART-001/VENUE-001/SKU-A-001/RENTAL-001 to exist.');
    }

    const parentTxnId = `TX-persist-parent-${Date.now()}`;
    const originalSale = buildSale({
      artistId: artist.id,
      venueId: venue.id,
      productId: product.id,
      rentalId: rental.id,
      sourceTransactionId: parentTxnId,
    });
    const refund = buildSale({
      recordType: 'refund',
      artistId: artist.id,
      venueId: venue.id,
      productId: product.id,
      rentalId: rental.id,
      sourceTransactionId: `TX-persist-refund-${Date.now()}`,
      parentTransactionId: parentTxnId,
      quantitySold: -1,
      grossSalesCents: -5_000,
      sourceCommissionAmountCents: -1_250,
      sourceTenantAmountCents: -3_750,
    });

    // Deliberately out of order (refund first) to verify the two-pass
    // ordering guarantees the parent is always resolvable.
    await persistImportBatch({
      fileContent: `unique-test-content-refund-${Date.now()}`,
      records: [refund, originalSale],
      failedRows: [],
    });

    const storedRefund = await database.sale.findUnique({
      where: { dedupeKey: refund.sourceTransactionId },
    });
    const storedOriginal = await database.sale.findUnique({
      where: { dedupeKey: originalSale.sourceTransactionId },
    });

    expect(storedRefund?.parentSaleId).toBe(storedOriginal?.id);
  });

  it('records failed rows as ImportError without failing the whole batch', async () => {
    const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
    const venue = await database.venue.findFirst({ where: { externalRef: 'VENUE-001' } });
    const product = await database.product.findFirst({ where: { sku: 'SKU-A-001' } });
    const rental = await database.rental.findFirst({ where: { externalRef: 'RENTAL-001' } });
    if (!artist || !venue || !product || !rental) {
      throw new Error('Expected seeded ART-001/VENUE-001/SKU-A-001/RENTAL-001 to exist.');
    }

    const sale = buildSale({
      artistId: artist.id,
      venueId: venue.id,
      productId: product.id,
      rentalId: rental.id,
      sourceTransactionId: `TX-persist-partial-${Date.now()}`,
    });

    const result = await persistImportBatch({
      fileContent: `unique-test-content-partial-${Date.now()}`,
      records: [sale],
      failedRows: [
        { rowNumber: 7, field: 'unitPriceCents', code: 'INVALID_NUMBER', message: 'Not a number' },
      ],
    });

    expect(result.status).toBe('IMPORTED'); // at least one row succeeded
    expect(result.validRows).toBe(1);
    expect(result.invalidRows).toBe(1);

    const errors = await database.importError.findMany({
      where: { importBatchId: result.batchId },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('INVALID_NUMBER');
  });

  it('returns FAILED status when every row fails validation', async () => {
    const result = await persistImportBatch({
      fileContent: `unique-test-content-allfail-${Date.now()}`,
      records: [],
      failedRows: [{ rowNumber: 1, code: 'MISSING_FIELD', message: 'artistId missing' }],
    });

    expect(result.status).toBe('FAILED');
    expect(result.validRows).toBe(0);
    expect(result.invalidRows).toBe(1);
  });
});
