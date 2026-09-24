import { database } from '@cornven/database';

export interface SalesSearchInput {
  artistId: string;
  rentalId?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface SalesSearchRecord {
  id: string;
  recordType: string;
  rentalId: string;
  soldAt: string;
  grossSalesCents: number;
  sourceCommissionAmountCents: number;
  sourceTenantAmountCents: number;
  currency: string;
}

export interface SalesSearchOutput {
  recordCount: number;
  grossSalesCents: number;
  refundAmountCents: number;
  netSalesCents: number;
  sourceCommissionAmountCents: number;
  sourceTenantAmountCents: number;
  currency: string;
  records: SalesSearchRecord[];
}

function toSafeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return result;
}

/**
 * Implements the sales.search Agent Tool. Queries permission-filtered
 * canonical sales records for one artist, and returns Tool-computed
 * deterministic summary totals alongside the individual records -- per
 * M5's guidance, the Assistant must never compute these totals itself.
 */
export async function searchSales(input: SalesSearchInput): Promise<SalesSearchOutput> {
  // Date filters are independent: providing only one bound must not
  // silently drop the filter. periodEnd is inclusive of the whole day
  // (23:59:59.999), not midnight, so records on the end date are not
  // missed.
  // Business dates are interpreted in Asia/Taipei (UTC+8), per the
  // client's confirmed timezone. A date-only string like "2026-08-31"
  // must be treated as Taipei midnight/end-of-day, not UTC midnight --
  // naively using new Date() or setUTCHours() operates in UTC and is off
  // by 8 hours (the same class of bug fixed earlier in the InventorySnapshot
  // mock data).
  const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

  const soldAtFilter: { gte?: Date; lte?: Date } = {};
  if (input.periodStart) {
    // Start of day in Asia/Taipei == that UTC date's midnight minus 8 hours.
    soldAtFilter.gte = new Date(
      new Date(`${input.periodStart}T00:00:00.000Z`).getTime() - TAIPEI_OFFSET_MS,
    );
  }
  if (input.periodEnd) {
    // End of day (23:59:59.999) in Asia/Taipei == that UTC date's midnight
    // plus (24h - 1ms) minus the 8-hour offset.
    const endOfDayTaipei =
      new Date(`${input.periodEnd}T00:00:00.000Z`).getTime() +
      (24 * 60 * 60 * 1000 - 1) -
      TAIPEI_OFFSET_MS;
    soldAtFilter.lte = new Date(endOfDayTaipei);
  }

  const sales = await database.sale.findMany({
    where: {
      artistId: input.artistId,
      ...(input.rentalId && { rentalId: input.rentalId }),
      ...(Object.keys(soldAtFilter).length > 0 && { soldAt: soldAtFilter }),
    },
    orderBy: { soldAt: 'asc' },
  });

  let grossSalesCents = 0n;
  let refundAmountCents = 0n;
  let sourceCommissionAmountCents = 0n;
  let sourceTenantAmountCents = 0n;
  let currency = 'TWD';

  const records: SalesSearchRecord[] = sales.map((sale) => {
    if (sale.recordType === 'SALE') {
      grossSalesCents += sale.grossSalesCents;
    } else if (sale.recordType === 'REFUND') {
      refundAmountCents += sale.grossSalesCents < 0n ? -sale.grossSalesCents : sale.grossSalesCents;
    }
    sourceCommissionAmountCents += sale.sourceCommissionAmountCents;
    sourceTenantAmountCents += sale.sourceTenantAmountCents;
    currency = sale.currency;

    return {
      id: sale.id,
      recordType: sale.recordType,
      rentalId: sale.rentalId,
      soldAt: sale.soldAt.toISOString(),
      grossSalesCents: toSafeNumber(sale.grossSalesCents, 'grossSalesCents'),
      sourceCommissionAmountCents: toSafeNumber(
        sale.sourceCommissionAmountCents,
        'sourceCommissionAmountCents',
      ),
      sourceTenantAmountCents: toSafeNumber(
        sale.sourceTenantAmountCents,
        'sourceTenantAmountCents',
      ),
      currency: sale.currency,
    };
  });

  const netSalesCents = grossSalesCents - refundAmountCents;

  return {
    recordCount: records.length,
    grossSalesCents: toSafeNumber(grossSalesCents, 'grossSalesCents'),
    refundAmountCents: toSafeNumber(refundAmountCents, 'refundAmountCents'),
    netSalesCents: toSafeNumber(netSalesCents, 'netSalesCents'),
    sourceCommissionAmountCents: toSafeNumber(
      sourceCommissionAmountCents,
      'sourceCommissionAmountCents',
    ),
    sourceTenantAmountCents: toSafeNumber(sourceTenantAmountCents, 'sourceTenantAmountCents'),
    currency,
    records,
  };
}

export interface ArtistGetInput {
  artistId: string;
}

export interface ArtistActiveRental {
  rentalId: string;
  venueId: string;
  commissionBps: number;
  fixedRentCents: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ArtistGetOutput {
  artistId: string;
  name: string;
  activeRentals: ArtistActiveRental[];
}

/**
 * Implements the artist.get Agent Tool. Returns an artist's basic profile
 * and their currently-active Rentals (effectiveFrom has passed and
 * effectiveTo is either unset or hasn't passed yet).
 */
/**
 * Throws when the artist does not exist. The Tool's Output Schema has no
 * representation for "not found" -- callers (the executor layer) must
 * catch this and map it to the appropriate Agent Tool error, never pass a
 * null/absent result through as if it were a valid Tool output.
 */
export class ArtistNotFoundError extends Error {
  constructor(artistId: string) {
    super(`Artist not found: ${artistId}`);
    this.name = 'ArtistNotFoundError';
  }
}

export async function getArtist(input: ArtistGetInput): Promise<ArtistGetOutput> {
  const artist = await database.artist.findUnique({
    where: { id: input.artistId },
    include: { rentals: true },
  });

  if (!artist) {
    throw new ArtistNotFoundError(input.artistId);
  }

  const now = new Date();
  const activeRentals = artist.rentals
    .filter((rental) => {
      const hasStarted = rental.effectiveFrom <= now;
      const hasNotEnded = rental.effectiveTo === null || rental.effectiveTo >= now;
      return hasStarted && hasNotEnded;
    })
    .map((rental) => ({
      rentalId: rental.id,
      venueId: rental.venueId,
      commissionBps: rental.commissionBps,
      fixedRentCents: rental.fixedRentCents,
      effectiveFrom: rental.effectiveFrom.toISOString(),
      effectiveTo: rental.effectiveTo ? rental.effectiveTo.toISOString() : null,
    }));

  return {
    artistId: artist.id,
    name: artist.name,
    activeRentals,
  };
}
