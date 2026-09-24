import { describe, expect, it } from 'vitest';

import { database } from '@cornven/database';

import { getArtist, searchSales } from '../src/modules/sales/sales.service.js';

describe.skipIf(process.env.RUN_REPORT_INTEGRATION !== 'true')('sales.search Tool executor', () => {
  it('returns deterministic summary totals for a real seeded artist', async () => {
    const artist = await database.artist.findFirst({
      where: { externalRef: 'ART-001' },
    });
    if (!artist) {
      throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');
    }

    const result = await searchSales({ artistId: artist.id });

    // The Tool must return pre-computed totals -- the caller (Assistant)
    // should never need to sum these itself.
    expect(result.recordCount).toBeGreaterThan(0);
    expect(result.currency).toBe('TWD');
    expect(result.netSalesCents).toBe(result.grossSalesCents - result.refundAmountCents);
    expect(result.records.length).toBe(result.recordCount);
  });

  it('returns an empty result for an artist with no sales', async () => {
    const result = await searchSales({ artistId: 'non-existent-artist-id' });
    expect(result.recordCount).toBe(0);
    expect(result.grossSalesCents).toBe(0);
    expect(result.records).toEqual([]);
  });
});

describe.skipIf(process.env.RUN_REPORT_INTEGRATION !== 'true')('artist.get Tool executor', () => {
  it('returns the artist profile with only currently-active rentals, including fixedRentCents', async () => {
    const artist = await database.artist.findFirst({
      where: { externalRef: 'ART-001' },
    });
    if (!artist) {
      throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');
    }

    const result = await getArtist({ artistId: artist.id });

    expect(result).not.toBeNull();
    expect(result?.artistId).toBe(artist.id);
    expect(result?.activeRentals.length).toBeGreaterThan(0);
    expect(result?.activeRentals[0]?.fixedRentCents).toBe(160000);
  });

  it('throws ArtistNotFoundError for a non-existent artist, instead of returning null', async () => {
    await expect(getArtist({ artistId: 'non-existent-artist-id' })).rejects.toThrow(
      'Artist not found',
    );
  });
});

describe.skipIf(process.env.RUN_REPORT_INTEGRATION !== 'true')(
  'sales.search date filtering (M5 review fix)',
  () => {
    it('does not silently drop the filter when only periodStart is provided', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist) throw new Error('Expected seeded artist ART-001 to exist.');

      const farFuture = await searchSales({
        artistId: artist.id,
        periodStart: '2099-01-01',
      });
      // A start date far in the future, with no end date, must still filter
      // -- it should exclude all existing (past) records, not ignore the bound.
      expect(farFuture.recordCount).toBe(0);
    });

    it('includes records that occur on the periodEnd date itself, not just before midnight', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist) throw new Error('Expected seeded artist ART-001 to exist.');

      // The seeded sale occurs on 2026-08-05; periodEnd on that same day
      // must include it (i.e. must extend to 23:59:59.999, not 00:00:00).
      const result = await searchSales({
        artistId: artist.id,
        periodStart: '2026-08-05',
        periodEnd: '2026-08-05',
      });
      expect(result.recordCount).toBeGreaterThan(0);
    });
  },
);
