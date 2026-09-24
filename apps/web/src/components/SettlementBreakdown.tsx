import type { SettlementPreview } from '@cornven/contracts';
import { formatNullableCents, formatTaipeiTime } from '../utils/format';

type Details = Pick<
  SettlementPreview,
  | 'currency'
  | 'totalProductSalesCents'
  | 'refundsCents'
  | 'validSalesCents'
  | 'creatorRevenueShareAmountCents'
  | 'bankTransferFeeCents'
  | 'amountPayableToCreatorCents'
  | 'rentals'
  | 'monthlyProductSalesDetails'
  | 'lowStockReminder'
  | 'notes'
>;
export function SettlementBreakdown({ result: r }: { result: Details }) {
  const money = (amount: number | null) => formatNullableCents(amount, r.currency);
  const amounts: [string, number | null][] = [
    ['Product sales', r.totalProductSalesCents],
    ['Refunds', r.refundsCents],
    ['Valid sales', r.validSalesCents],
    ['Creator revenue share', r.creatorRevenueShareAmountCents],
    ['Bank transfer fee', r.bankTransferFeeCents],
    ['Amount payable', r.amountPayableToCreatorCents],
  ];
  return (
    <>
      <dl className="report-amounts">
        {amounts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{money(value)}</dd>
          </div>
        ))}
      </dl>
      <h3>Rentals</h3>
      <p>Fixed rent is shown for reference and is not deducted from the payout.</p>
      {r.rentals.map((rental) => (
        <div key={rental.rentalId}>
          <h4>{rental.venueName}</h4>
          <p>
            Rent: {money(rental.rentalAmountCents)} · Creator share:{' '}
            {money(rental.creatorRevenueShareAmountCents)}
          </p>
          {rental.revenueShares.map((share, i) => (
            <p key={i}>
              Creator rate:{' '}
              {share.creatorCommissionBps === null
                ? 'Unknown'
                : `${share.creatorCommissionBps / 100}%`}{' '}
              · Valid sales: {money(share.validSalesCents)} · Share:{' '}
              {money(share.creatorRevenueShareAmountCents)}
            </p>
          ))}
        </div>
      ))}
      <h3>Product sales (before refunds)</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Quantity sold</th>
              <th>Sales</th>
            </tr>
          </thead>
          <tbody>
            {r.monthlyProductSalesDetails.map((p) => (
              <tr key={`${p.productId}:${p.rentalId}:${p.unitPriceCents}`}>
                <td>
                  {p.productName} ({p.sku})
                </td>
                <td>{p.quantitySold}</td>
                <td>{money(p.salesAmountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Low stock</h3>
      <p>
        {r.lowStockReminder.capturedAt
          ? `Captured ${formatTaipeiTime(r.lowStockReminder.capturedAt)} (Asia/Taipei)`
          : 'No available inventory snapshot'}
      </p>
      {r.lowStockReminder.status === 'unavailable' ? (
        <p>{r.lowStockReminder.message ?? 'Inventory unavailable'}</p>
      ) : r.lowStockReminder.products.length === 0 ? (
        <p>No low-stock products.</p>
      ) : (
        <ul>
          {r.lowStockReminder.products.map((p) => (
            <li key={`${p.productId}:${p.venueId}`}>
              {p.productName} ({p.sku}): {p.currentStock} in stock · {p.monthlyQuantitySold} sold
              this month
            </li>
          ))}
        </ul>
      )}
      {r.notes.length > 0 && (
        <>
          <h3>Notes</h3>
          <ul>
            {r.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
