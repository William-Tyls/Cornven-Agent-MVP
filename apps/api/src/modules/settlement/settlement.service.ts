import {
  SettlementPreviewSchema,
  type CanonicalSale,
  type ProductSalesDetail,
  type ReportRentalBreakdown,
  type SettlementPreview,
  type SettlementPreviewInput,
} from '@cornven/contracts';

import { RequestValidationError } from '../../shared/errors.js';

function integer(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RequestValidationError(
      'Report amount or quantity exceeds the safe integer range.',
      'sales',
    );
  return result;
}
function add(a: number, b: number): number {
  return integer(BigInt(a) + BigInt(b));
}
// Explicit MVP convention: half-up to cents. Refunds reverse the difference between
// cumulative rounded refunds, so multiple partial refunds reverse a full sale exactly.
function share(amount: number, bps: number): number {
  return integer((BigInt(amount) * BigInt(bps) + 5_000n) / 10_000n);
}
function dateInTaipei(ms: number): string {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function key(...parts: unknown[]): string {
  return JSON.stringify(parts);
}
function zeroAmounts() {
  return {
    totalProductSalesCents: 0,
    refundsCents: 0,
    validSalesCents: 0,
    creatorRevenueShareAmountCents: 0 as number | null,
  };
}
function addAmounts(
  target: ReturnType<typeof zeroAmounts>,
  source: ReturnType<typeof zeroAmounts>,
) {
  target.totalProductSalesCents = add(target.totalProductSalesCents, source.totalProductSalesCents);
  target.refundsCents = add(target.refundsCents, source.refundsCents);
  target.validSalesCents = add(target.validSalesCents, source.validSalesCents);
  target.creatorRevenueShareAmountCents =
    target.creatorRevenueShareAmountCents === null || source.creatorRevenueShareAmountCents === null
      ? null
      : add(target.creatorRevenueShareAmountCents, source.creatorRevenueShareAmountCents);
}

export function calculateSettlementPreview(input: SettlementPreviewInput): SettlementPreview {
  const start = Date.parse(`${input.settlementMonth}-01T00:00:00+08:00`);
  const [year, month] = input.settlementMonth.split('-').map(Number);
  const end = Date.UTC(year!, month!, 1) - 8 * 60 * 60 * 1000;
  const cutoff = Math.min(Date.parse(input.asOf), end - 1);
  const notes = new Set<string>();
  const unique = new Map<string, CanonicalSale>();
  for (const row of [...input.historicalRecords, ...input.sales]) {
    const previous = unique.get(row.sourceRecordId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      throw new RequestValidationError(
        `Conflicting data for sourceRecordId ${row.sourceRecordId}.`,
        'sales',
      );
    }
    unique.set(row.sourceRecordId, row);
  }
  const records = [...unique.values()]
    .filter((r) => r.artistId === input.artistId && Date.parse(r.soldAt) <= cutoff)
    .sort(
      (a, b) =>
        Date.parse(a.soldAt) - Date.parse(b.soldAt) ||
        a.sourceRecordId.localeCompare(b.sourceRecordId),
    );
  const current = records.filter((r) => Date.parse(r.soldAt) >= start);
  const currentIds = new Set(current.map((r) => r.sourceRecordId));
  if (current.some((r) => r.currency !== 'TWD'))
    throw new RequestValidationError('This report only supports TWD transactions.', 'sales');
  const originals = records.filter((r) => r.recordType === 'sale');
  const resolved = new Map<string, { rate: number | null; amount: number | null }>();
  for (const row of current.filter((r) => r.recordType === 'sale')) {
    const rate = 10_000 - row.rentalCommissionBps;
    resolved.set(row.sourceRecordId, {
      rate,
      amount: share(row.grossSalesCents, rate),
    });
  }
  const refunded = new Map<string, { quantity: number; amount: number; invalid: boolean }>();
  for (const row of records.filter((r) => r.recordType === 'refund')) {
    const matches = originals.filter(
      (s) =>
        s.sourceTransactionId === row.parentTransactionId &&
        s.productId === row.productId &&
        s.rentalId === row.rentalId &&
        s.venueId === row.venueId &&
        s.currency === row.currency &&
        Date.parse(s.soldAt) <= Date.parse(row.soldAt),
    );
    if (matches.length !== 1) {
      if (currentIds.has(row.sourceRecordId))
        notes.add(
          `Creator share unavailable: refund ${row.sourceRecordId} has a missing or ambiguous original sale.`,
        );
      resolved.set(row.sourceRecordId, { rate: null, amount: null });
      continue;
    }
    const original = matches[0]!;
    const previous = refunded.get(original.sourceRecordId) ?? {
      quantity: 0,
      amount: 0,
      invalid: false,
    };
    const next = {
      quantity: add(previous.quantity, -row.quantitySold),
      amount: add(previous.amount, -row.grossSalesCents),
      invalid: previous.invalid,
    };
    next.invalid ||=
      next.quantity > original.quantitySold || next.amount > original.grossSalesCents;
    refunded.set(original.sourceRecordId, next);
    // Refunds reverse the original sale's rate, regardless of the refund row's current rate.
    const rate = 10_000 - original.rentalCommissionBps;
    if (currentIds.has(row.sourceRecordId) && next.invalid)
      notes.add(
        `Creator share unavailable: cumulative refunds for sale ${original.sourceRecordId} exceed the original quantity or amount.`,
      );
    resolved.set(row.sourceRecordId, {
      rate,
      amount: !next.invalid ? -(share(next.amount, rate) - share(previous.amount, rate)) : null,
    });
  }

  const rentals = new Map<string, ReportRentalBreakdown>();
  const rentalMetadata = new Map(input.rentals.map((r) => [r.rentalId, r]));
  for (const rental of input.rentals) {
    if (
      Date.parse(rental.effectiveFrom) <= cutoff &&
      (!rental.effectiveTo || Date.parse(rental.effectiveTo) > start)
    ) {
      rentals.set(rental.rentalId, {
        ...zeroAmounts(),
        rentalId: rental.rentalId,
        venueId: rental.venueId,
        venueName: rental.venueName,
        rentalAmountCents: rental.monthlyRentCents,
        revenueShares: [],
      });
    }
  }
  const products = new Map<string, ProductSalesDetail>();
  const productSalesQuantities = new Map<string, number>();
  for (const row of current) {
    let rental = rentals.get(row.rentalId);
    const meta = rentalMetadata.get(row.rentalId);
    if (meta && meta.venueId !== row.venueId)
      throw new RequestValidationError('Rental venue does not match the transaction.', 'rentals');
    if (!rental) {
      rental = {
        ...zeroAmounts(),
        rentalId: row.rentalId,
        venueId: row.venueId,
        venueName: row.venueName,
        rentalAmountCents: meta?.monthlyRentCents ?? null,
        revenueShares: [],
      };
      rentals.set(row.rentalId, rental);
    }
    if (rental.venueId !== row.venueId)
      throw new RequestValidationError('A rental cannot span inconsistent venues.', 'sales');
    const result = resolved.get(row.sourceRecordId)!;
    let rateGroup = rental.revenueShares.find((g) => g.creatorCommissionBps === result.rate);
    if (!rateGroup) {
      rateGroup = {
        ...zeroAmounts(),
        creatorCommissionBps: result.rate,
        platformCommissionBps: result.rate === null ? null : 10_000 - result.rate,
      };
      rental.revenueShares.push(rateGroup);
    }
    const amounts = {
      totalProductSalesCents: row.recordType === 'sale' ? row.grossSalesCents : 0,
      refundsCents: row.recordType === 'refund' ? -row.grossSalesCents : 0,
      validSalesCents: row.grossSalesCents,
      creatorRevenueShareAmountCents: result.amount,
    };
    addAmounts(rateGroup, amounts);
    addAmounts(rental, amounts);
    if (row.recordType === 'sale') {
      const productKey = key(row.rentalId, row.venueId, row.productId, row.unitPriceCents);
      const product = products.get(productKey) ?? {
        productId: row.productId,
        productName: row.productName,
        sku: row.sku ?? null,
        rentalId: row.rentalId,
        venueId: row.venueId,
        unitPriceCents: row.unitPriceCents,
        quantitySold: 0,
        salesAmountCents: 0,
      };
      product.quantitySold = add(product.quantitySold, row.quantitySold);
      product.salesAmountCents = add(product.salesAmountCents, row.grossSalesCents);
      products.set(productKey, product);
      const stockKey = key(row.productId, row.venueId);
      productSalesQuantities.set(
        stockKey,
        add(productSalesQuantities.get(stockKey) ?? 0, row.quantitySold),
      );
    }
  }
  // No transaction means no observed rate: retain zero amounts without inventing a percentage.
  for (const rental of rentals.values()) {
    if (rental.revenueShares.length === 0)
      rental.revenueShares.push({
        ...zeroAmounts(),
        creatorCommissionBps: null,
        platformCommissionBps: null,
      });
    rental.revenueShares.sort(
      (a, b) => (a.creatorCommissionBps ?? -1) - (b.creatorCommissionBps ?? -1),
    );
  }
  const rentalRows = [...rentals.values()].sort((a, b) => a.rentalId.localeCompare(b.rentalId));
  const totals = zeroAmounts();
  for (const rental of rentalRows) addAmounts(totals, rental);
  const artistName = input.artistName ?? current[0]?.artistName ?? records[0]?.artistName ?? null;
  if (!artistName)
    notes.add(
      'Creator name unavailable: provide the artist directory entry for a zero-transaction report.',
    );
  if (input.bankTransferFeeCents === null)
    notes.add('Bank transfer fee is unconfirmed; amount payable is unavailable.');
  const payable =
    totals.creatorRevenueShareAmountCents === null || input.bankTransferFeeCents === null
      ? null
      : add(totals.creatorRevenueShareAmountCents, -input.bankTransferFeeCents);
  if (payable !== null && payable < 0)
    notes.add(
      'Negative settlement balance; payment or carry-forward treatment requires confirmation.',
    );
  const inventoryReady = input.inventory?.complete === true;
  const lowStock = inventoryReady
    ? input
        .inventory!.items.filter((p) => p.currentStock <= 1)
        .map((p) => ({
          ...p,
          monthlyQuantitySold: productSalesQuantities.get(key(p.productId, p.venueId)) ?? 0,
        }))
        .sort((a, b) => key(a.venueId, a.productId).localeCompare(key(b.venueId, b.productId)))
    : [];
  return SettlementPreviewSchema.parse({
    settlementMonth: `${input.settlementMonth.slice(5)}/${input.settlementMonth.slice(0, 4)}`,
    creator: { artistId: input.artistId, artistName, brandName: input.brandName ?? artistName },
    venues: [
      ...new Map(
        rentalRows.map((r) => [r.venueId, { venueId: r.venueId, venueName: r.venueName }]),
      ).values(),
    ].sort((a, b) => a.venueId.localeCompare(b.venueId)),
    settlementPeriod: {
      from: `${input.settlementMonth}-01`,
      to: dateInTaipei(cutoff),
      asOf: input.asOf,
    },
    currency: 'TWD',
    businessTimezone: 'Asia/Taipei',
    isProvisional: Date.parse(input.asOf) < end,
    ...totals,
    rentals: rentalRows,
    bankTransferFeeCents: input.bankTransferFeeCents,
    amountPayableToCreatorCents: payable,
    monthlyProductSalesDetails: [...products.values()].sort((a, b) =>
      key(a.rentalId, a.productId, a.unitPriceCents).localeCompare(
        key(b.rentalId, b.productId, b.unitPriceCents),
      ),
    ),
    lowStockReminder: {
      status: inventoryReady ? 'available' : 'unavailable',
      capturedAt: input.inventory?.capturedAt ?? null,
      products: lowStock,
      message: !inventoryReady
        ? 'Inventory data unavailable or incomplete'
        : lowStock.length === 0
          ? 'No low stock products this month'
          : null,
    },
    notes: [...notes].sort(),
  });
}
