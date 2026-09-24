import {
  ArtistListQuerySchema,
  ArtistListResponseSchema,
  CanonicalSaleSchema,
  MonthlyReportContextQuerySchema,
  MonthlyReportContextSchema,
  type MonthlyReportContextProvider,
  type MonthlyReportContextQuery,
} from '@cornven/contracts';
import { Prisma, type PrismaClient } from '@cornven/database';
import { z } from 'zod';
import { buildMonthlyReportContext } from './monthly-report-context.service.js';
import type { ReportActor } from '../../shared/report-auth.js';
import { decodeCursor, encodeCursor } from '../../shared/report-cursor.js';
import { ReportError } from '../../shared/report-errors.js';
import { reportRange } from '../../shared/report-time.js';

function cents(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Unsafe integer amount');
  return result;
}

export class DatabaseMonthlyReportContext implements MonthlyReportContextProvider {
  constructor(private readonly db: PrismaClient) {}

  async getMonthlyReportContext(query: MonthlyReportContextQuery) {
    const parsed = MonthlyReportContextQuerySchema.parse(query);
    const { start, cutoff } = reportRange(parsed.settlementMonth, parsed.asOf);
    try {
      return await this.db.$transaction(
        async (tx) => {
          const artist = await tx.artist.findUnique({ where: { id: parsed.artistId } });
          if (!artist) throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Artist not found.');
          const rows = await tx.sale.findMany({
            where: {
              artistId: artist.id,
              soldAt: { lte: cutoff },
              recordType: { in: ['SALE', 'REFUND'] },
            },
            include: { product: true, venue: true, rental: true, parentSale: true },
            orderBy: [{ soldAt: 'asc' }, { id: 'asc' }],
          });
          const records = rows.map((row) => {
            if (
              row.product.artistId !== artist.id ||
              row.rental.artistId !== artist.id ||
              row.rental.venueId !== row.venueId ||
              (row.parentSale &&
                (row.parentSale.artistId !== artist.id || row.parentSale.recordType !== 'SALE'))
            ) {
              throw new Error('Inconsistent record ownership');
            }
            if (row.currency !== 'TWD') throw new Error('Unsupported currency');
            return CanonicalSaleSchema.parse({
              recordType: row.recordType === 'SALE' ? 'sale' : 'refund',
              sourceRecordId: row.sourceRecordId,
              sourceTransactionId: row.sourceTransactionId,
              parentTransactionId: row.parentSale?.sourceTransactionId ?? null,
              artistId: artist.id,
              artistName: artist.name,
              venueId: row.venueId,
              venueName: row.venue.name,
              productId: row.productId,
              productName: row.product.name,
              ...(row.product.sku ? { sku: row.product.sku } : {}),
              soldAt: row.soldAt.toISOString(),
              quantitySold: row.quantitySold,
              unitPriceCents: cents(row.unitPriceCents),
              grossSalesCents: cents(row.grossSalesCents),
              sourceCommissionAmountCents: cents(row.sourceCommissionAmountCents),
              sourceTenantAmountCents: cents(row.sourceTenantAmountCents),
              rentalId: row.rentalId,
              rentalCommissionBps: row.rentalCommissionBps,
              ...(row.cubeExternalRef ? { cubeId: row.cubeExternalRef } : {}),
              ...(row.cubeCommissionBps !== null
                ? { cubeCommissionBps: row.cubeCommissionBps }
                : {}),
              currency: row.currency,
            });
          });
          const { sales, historicalRecords } = buildMonthlyReportContext({
            ...parsed,
            asOf: cutoff.toISOString(),
            records,
          });
          const rentals = await tx.rental.findMany({
            where: {
              artistId: artist.id,
              OR: [
                {
                  effectiveFrom: { lte: cutoff },
                  OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }],
                },
                { id: { in: [...new Set(sales.map((s) => s.rentalId))] } },
              ],
            },
            include: { venue: true },
            orderBy: { id: 'asc' },
          });
          const latest = await tx.inventorySnapshot.findFirst({
            where: { product: { artistId: artist.id }, capturedAt: { lte: cutoff } },
            orderBy: [{ capturedAt: 'desc' }, { id: 'asc' }],
          });
          let inventory = null;
          if (latest) {
            const stock = await tx.inventorySnapshot.findMany({
              where: { product: { artistId: artist.id }, capturedAt: latest.capturedAt },
              include: { product: true, venue: true },
              orderBy: [{ productId: 'asc' }, { venueId: 'asc' }],
            });
            // PR27 is a known complete fixture. Additional local demo batches carry an explicit
            // source-owned manifest; row count alone must never imply full inventory coverage.
            const expected = new Set(
              Array.from({ length: 10 }, (_, i) => `SKU-A-${String(i + 1).padStart(3, '0')}`),
            );
            let complete =
              artist.externalRef === 'ART-001' &&
              latest.capturedAt.toISOString() === '2026-08-31T15:59:59.000Z' &&
              stock.length === expected.size &&
              stock.every(
                (s) => s.venue.externalRef === 'VENUE-001' && expected.delete(s.product.sku ?? ''),
              ) &&
              expected.size === 0;
            if (!complete) {
              const batches = await tx.importBatch.findMany({
                where: {
                  source: 'MOCK',
                  status: 'IMPORTED',
                  sourceFileName: 'local-september-demo-v1.json',
                },
                select: { metadata: true },
              });
              const manifestSchema = z.object({
                demoDataset: z.literal('september-2026-v1'),
                inventorySnapshots: z.array(
                  z.object({
                    artistExternalRef: z.string(),
                    capturedAt: z.string().datetime(),
                    items: z
                      .array(z.object({ sku: z.string(), venueExternalRef: z.string() }))
                      .min(1),
                  }),
                ),
              });
              complete = batches.some((batch) => {
                const parsed = manifestSchema.safeParse(batch.metadata);
                if (!parsed.success) return false;
                return parsed.data.inventorySnapshots.some((manifest) => {
                  if (
                    manifest.artistExternalRef !== artist.externalRef ||
                    manifest.capturedAt !== latest.capturedAt.toISOString()
                  )
                    return false;
                  const keys = new Set(
                    manifest.items.map((item) => JSON.stringify([item.sku, item.venueExternalRef])),
                  );
                  return (
                    keys.size === manifest.items.length &&
                    keys.size === stock.length &&
                    stock.every((row) =>
                      keys.delete(JSON.stringify([row.product.sku, row.venue.externalRef])),
                    ) &&
                    keys.size === 0
                  );
                });
              });
            }
            inventory = {
              capturedAt: latest.capturedAt.toISOString(),
              complete,
              items: stock.map((s) => ({
                productId: s.productId,
                productName: s.product.name,
                sku: s.product.sku,
                venueId: s.venueId,
                venueName: s.venue.name,
                currentStock: s.quantity,
              })),
            };
          }
          return MonthlyReportContextSchema.parse({
            artistId: artist.id,
            artistName: artist.name,
            brandName: artist.brandName,
            sales,
            historicalRecords,
            bankTransferFeeCents: null,
            inventory,
            rentals: rentals.map((r) => ({
              rentalId: r.id,
              venueId: r.venueId,
              venueName: r.venue.name,
              effectiveFrom: r.effectiveFrom.toISOString(),
              effectiveTo: r.effectiveTo?.toISOString() ?? null,
              monthlyRentCents: r.fixedRentCents,
            })),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (error instanceof ReportError) throw error;
      throw new ReportError(
        503,
        'REPORT_DATA_UNAVAILABLE',
        'Report data could not be read or mapped.',
      );
    }
  }

  async listArtists(input: unknown, actor: ReportActor) {
    const query = ArtistListQuerySchema.parse(input);
    const filter = JSON.stringify({ query: query.query });
    const cursor = decodeCursor(query.cursor, filter);
    const rows = await this.db.artist.findMany({
      where: {
        AND: [
          actor.artistIds === '*' ? {} : { id: { in: [...actor.artistIds] } },
          cursor ? { id: { gt: cursor.id } } : {},
          {
            OR: [
              { name: { contains: query.query, mode: 'insensitive' } },
              { brandName: { contains: query.query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    const selected = rows.slice(0, query.limit);
    return ArtistListResponseSchema.parse({
      items: selected.map((a) => ({ artistId: a.id, artistName: a.name, brandName: a.brandName })),
      nextCursor: rows.length > query.limit ? encodeCursor(filter, selected.at(-1)!.id) : null,
    });
  }

  async listMonthlyReportArtistIds(query: {
    settlementMonth: string;
    asOf: string;
    limit: number;
    cursor?: string;
  }) {
    const { start, cutoff } = reportRange(query.settlementMonth, query.asOf);
    const artists = await this.db.artist.findMany({
      where: {
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        OR: [
          {
            sales: {
              some: { soldAt: { gte: start, lte: cutoff }, recordType: { in: ['SALE', 'REFUND'] } },
            },
          },
          {
            rentals: {
              some: {
                effectiveFrom: { lte: cutoff },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }],
              },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    const selected = artists.slice(0, query.limit);
    return {
      artistIds: selected.map((a) => a.id),
      nextCursor: artists.length > query.limit ? selected.at(-1)!.id : null,
    };
  }
}
