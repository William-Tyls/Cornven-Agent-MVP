import type { MonthlyReportDocument } from '@cornven/contracts';

const moneyFormatter = new Intl.NumberFormat('en-TW', {
  style: 'currency',
  currency: 'TWD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeCssString(value: string | number): string {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('<', '\\3c ')
    .replaceAll('>', '\\3e ')
    .replaceAll('\r\n', '\\a ')
    .replaceAll('\r', '\\a ')
    .replaceAll('\n', '\\a ')
    .replaceAll('\f', '\\c ')
    .replaceAll('\0', '\ufffd');
}

function formatMoney(cents: number | null): string {
  if (cents === null) {
    return 'Pending confirmation';
  }

  return escapeHtml(moneyFormatter.format(cents / 100));
}

function formatBasisPoints(basisPoints: number | null): string {
  if (basisPoints === null) {
    return 'Not available';
  }

  return `${escapeHtml((basisPoints / 100).toFixed(2))}%`;
}

function formatSettlementMonth(month: string): string {
  const [year, monthNumber] = month.split('-');
  return `${escapeHtml(monthNumber ?? '')}/${escapeHtml(year ?? '')}`;
}

function formatStatus(status: string): string {
  return escapeHtml(status.replaceAll('_', ' ').toUpperCase());
}

function renderMetadata(report: MonthlyReportDocument): string {
  const provisionalBadge = report.isProvisional
    ? '<span class="badge badge-warning">PROVISIONAL</span>'
    : '';

  return `
    <header class="report-header">
      <div class="masthead">
        <p class="wordmark">CORN VEN</p>
        <div class="statement-status">
          <span class="badge">${formatStatus(report.reportStatus)}</span>
          ${provisionalBadge}
        </div>
      </div>
      <div class="statement-heading">
        <p class="eyebrow">Monthly creator statement</p>
        <h1>CORNVEN Monthly Settlement Report</h1>
        <p class="statement-subtitle">${formatSettlementMonth(report.settlementMonth)} <span aria-hidden="true">&middot;</span> ${escapeHtml(report.creator.displayName)}</p>
      </div>
    </header>
    <dl class="metadata-grid">
      <div><dt>Report ID</dt><dd>${escapeHtml(report.reportId)}</dd></div>
      <div><dt>Creator</dt><dd>${escapeHtml(report.creator.displayName)}</dd></div>
      <div><dt>Artist Name</dt><dd>${report.creator.artistName === null ? '&mdash;' : escapeHtml(report.creator.artistName)}</dd></div>
      <div><dt>Brand Name</dt><dd>${report.creator.brandName === null ? '&mdash;' : escapeHtml(report.creator.brandName)}</dd></div>
      <div><dt>Artist ID</dt><dd>${escapeHtml(report.creator.artistId)}</dd></div>
      <div><dt>Settlement Month</dt><dd>${formatSettlementMonth(report.settlementMonth)}</dd></div>
      <div><dt>Settlement Period</dt><dd>${escapeHtml(report.settlementPeriod.from)} &ndash; ${escapeHtml(report.settlementPeriod.to)}</dd></div>
      <div><dt>Data As Of</dt><dd><time datetime="${escapeHtml(report.settlementPeriod.asOf)}">${escapeHtml(report.settlementPeriod.asOf)}</time></dd></div>
      <div><dt>Timezone</dt><dd>${escapeHtml(report.businessTimezone)}</dd></div>
      <div><dt>Generated At</dt><dd><time datetime="${escapeHtml(report.generatedAt)}">${escapeHtml(report.generatedAt)}</time></dd></div>
      <div><dt>Report Status</dt><dd>${formatStatus(report.reportStatus)}</dd></div>
    </dl>`;
}

function renderFinancialSummary(report: MonthlyReportDocument): string {
  const summary = report.financialSummary;
  const rows = [
    ['Total Product Sales', formatMoney(summary.totalProductSalesCents)],
    ['Total Refunds', formatMoney(summary.refundsCents)],
    ['Valid Sales', formatMoney(summary.validSalesCents)],
    ['Creator Revenue Share Amount', formatMoney(summary.creatorRevenueShareAmountCents)],
    ['Bank Transfer Fee', formatMoney(summary.bankTransferFeeCents)],
  ];

  return `
    <section class="report-section financial-summary" aria-labelledby="financial-summary-heading">
      <h2 id="financial-summary-heading">Financial Summary</h2>
      <dl class="currency-note"><div><dt>Currency</dt><dd>${escapeHtml(report.currency)}</dd></div></dl>
      <div class="summary-ledger">
        <div class="summary-item amount-payable">
          <span>Amount Payable to Creator</span>
          <strong>${formatMoney(summary.amountPayableToCreatorCents)}</strong>
        </div>
        ${rows
          .map(
            ([label, value]) => `
              <div class="summary-item">
                <span>${label}</span>
                <strong>${value}</strong>
              </div>`,
          )
          .join('')}
      </div>
    </section>`;
}

function renderRevenueShares(
  revenueShares: MonthlyReportDocument['rentals'][number]['revenueShares'],
): string {
  if (revenueShares.length === 0) {
    return '<p class="empty-state">No revenue-share groups available.</p>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th scope="col">Creator Rate</th>
          <th scope="col">Platform Rate</th>
          <th scope="col">Product Sales</th>
          <th scope="col">Refunds</th>
          <th scope="col">Valid Sales</th>
          <th scope="col">Creator Amount</th>
        </tr>
      </thead>
      <tbody>
        ${revenueShares
          .map(
            (share) => `
              <tr>
                <td>${formatBasisPoints(share.creatorCommissionBps)}</td>
                <td>${formatBasisPoints(share.platformCommissionBps)}</td>
                <td>${formatMoney(share.totalProductSalesCents)}</td>
                <td>${formatMoney(share.refundsCents)}</td>
                <td>${formatMoney(share.validSalesCents)}</td>
                <td>${formatMoney(share.creatorRevenueShareAmountCents)}</td>
              </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderRentals(report: MonthlyReportDocument): string {
  const content =
    report.rentals.length === 0
      ? '<p class="empty-state">No rental breakdowns available.</p>'
      : report.rentals
          .map(
            (rental) => `
              <article class="rental-card">
                <header class="card-header">
                  <div>
                    <h3>${escapeHtml(rental.venueName)}</h3>
                    <p>Rental ID: ${escapeHtml(rental.rentalId)} &middot; Venue ID: ${escapeHtml(rental.venueId)}</p>
                  </div>
                  <div class="rent-amount">
                    <span>Monthly Rent &middot; Display only</span>
                    <strong>${formatMoney(rental.rentalAmountCents)}</strong>
                  </div>
                </header>
                <p class="rental-note">Rental is displayed separately and is not deducted from amount payable.</p>
                <dl class="rental-totals">
                  <div><dt>Product Sales</dt><dd>${formatMoney(rental.totalProductSalesCents)}</dd></div>
                  <div><dt>Refunds</dt><dd>${formatMoney(rental.refundsCents)}</dd></div>
                  <div><dt>Valid Sales</dt><dd>${formatMoney(rental.validSalesCents)}</dd></div>
                  <div><dt>Creator Amount</dt><dd>${formatMoney(rental.creatorRevenueShareAmountCents)}</dd></div>
                </dl>
                <h4>Revenue-share groups</h4>
                ${renderRevenueShares(rental.revenueShares)}
              </article>`,
          )
          .join('');

  return `
    <section class="report-section" aria-labelledby="rental-breakdown-heading">
      <h2 id="rental-breakdown-heading">Rental Breakdown</h2>
      ${content}
    </section>`;
}

function renderProductSales(report: MonthlyReportDocument): string {
  const details = report.monthlyProductSalesDetails;
  const content =
    details.length === 0
      ? '<p class="empty-state">No product sales recorded.</p>'
      : `
        <table>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">SKU</th>
              <th scope="col">Rental</th>
              <th scope="col">Venue</th>
              <th scope="col">Unit Price</th>
              <th scope="col">Quantity Sold</th>
              <th scope="col">Sales Amount</th>
            </tr>
          </thead>
          <tbody>
            ${details
              .map(
                (product) => `
                  <tr>
                    <td>${escapeHtml(product.productName)}<small class="reference">Product ID: ${escapeHtml(product.productId)}</small></td>
                    <td>${product.sku === null ? '&mdash;' : escapeHtml(product.sku)}</td>
                    <td class="reference-cell">${escapeHtml(product.rentalId)}</td>
                    <td class="reference-cell">${escapeHtml(product.venueId)}</td>
                    <td>${formatMoney(product.unitPriceCents)}</td>
                    <td>${escapeHtml(product.quantitySold)}</td>
                    <td>${formatMoney(product.salesAmountCents)}</td>
                  </tr>`,
              )
              .join('')}
          </tbody>
        </table>`;

  return `
    <section class="report-section" aria-labelledby="product-sales-heading">
      <h2 id="product-sales-heading">Monthly Product Sales</h2>
      ${content}
    </section>`;
}

function renderInventoryCapture(capturedAt: string | null): string {
  if (capturedAt === null) {
    return '<p class="capture-time">Inventory capture time not available.</p>';
  }

  return `<p class="capture-time">Inventory captured at <time datetime="${escapeHtml(capturedAt)}">${escapeHtml(capturedAt)}</time></p>`;
}

function renderLowStock(report: MonthlyReportDocument): string {
  const reminder = report.lowStockReminder;
  const message =
    reminder.message !== null
      ? `<p class="empty-state">${escapeHtml(reminder.message)}</p>`
      : reminder.status === 'unavailable'
        ? '<p class="empty-state">Inventory data unavailable.</p>'
        : '';
  let products: string;

  if (reminder.products.length === 0) {
    products =
      reminder.status === 'available' ? '<p class="empty-state">No low-stock products.</p>' : '';
  } else {
    products = `
      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">SKU</th>
            <th scope="col">Venue</th>
            <th scope="col">Current Stock</th>
            <th scope="col">Monthly Quantity Sold</th>
          </tr>
        </thead>
        <tbody>
          ${reminder.products
            .map(
              (product) => `
                <tr>
                  <td>${escapeHtml(product.productName)}<small class="reference">Product ID: ${escapeHtml(product.productId)}</small></td>
                  <td>${product.sku === null ? '&mdash;' : escapeHtml(product.sku)}</td>
                  <td>${escapeHtml(product.venueName)}<small class="reference">Venue ID: ${escapeHtml(product.venueId)}</small></td>
                  <td>${escapeHtml(product.currentStock)}</td>
                  <td>${escapeHtml(product.monthlyQuantitySold)}</td>
                </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
  }

  return `
    <section class="report-section low-stock" aria-labelledby="low-stock-heading">
      <h2 id="low-stock-heading">Low Stock Reminder</h2>
      <p class="inventory-status">Inventory status: ${formatStatus(reminder.status)}</p>
      ${renderInventoryCapture(reminder.capturedAt)}
      ${message}
      ${products}
    </section>`;
}

function renderNotes(report: MonthlyReportDocument): string {
  const content =
    report.notes.length === 0
      ? '<p class="empty-state">No additional notes.</p>'
      : `<ul>${report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`;

  return `
    <section class="report-section" aria-labelledby="notes-heading">
      <h2 id="notes-heading">Notes</h2>
      ${content}
    </section>`;
}

export function renderMonthlyReportHtml(report: MonthlyReportDocument): string {
  const [settlementYear, settlementMonth] = report.settlementMonth.split('-');
  const printFooterIdentity = escapeCssString(
    `CORNVEN · Report ID: ${report.reportId} · ${settlementMonth ?? ''}/${settlementYear ?? ''} · ${report.creator.displayName}`,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CORNVEN Monthly Settlement Report</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Arial, 'PingFang SC', sans-serif;
        color: #202c25;
        background: #fffefb;
      }

      * { box-sizing: border-box; }

      @page {
        size: A4;
        margin: 14mm 14mm 18mm;

        @bottom-left {
          content: "${printFooterIdentity}";
          color: #626b64;
          font-family: Arial, 'PingFang SC', sans-serif;
          font-size: 7pt;
        }

        @bottom-right {
          content: counter(page) " / " counter(pages);
          color: #626b64;
          font-family: Arial, 'PingFang SC', sans-serif;
          font-size: 7pt;
        }
      }

      body {
        margin: 0;
        font-size: 9pt;
        line-height: 1.5;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }

      h1, h2, h3, h4, p { margin-top: 0; }
      h1, h2, h3, .wordmark { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; }
      h1 { max-width: 560px; margin-bottom: 7px; font-size: 27pt; line-height: 1.15; }
      h2 { margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #dce0d8; font-size: 17pt; break-after: avoid; }
      h3 { margin-bottom: 5px; font-size: 14pt; break-after: avoid; }
      h4 { margin: 18px 0 8px; font-size: 9pt; font-weight: 400; break-after: avoid; }
      p, li { orphans: 3; widows: 3; }

      .eyebrow {
        margin-bottom: 7px;
        color: #626b64;
        font-size: 7.5pt;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .report-header { margin-bottom: 18px; }

      .masthead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid #dce0d8;
        margin-bottom: 20px;
      }

      .wordmark { margin: 0; font-size: 23pt; line-height: 1; letter-spacing: 0.08em; }
      .statement-status { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 50%; }
      .statement-heading { break-inside: avoid; }
      .statement-subtitle { margin-bottom: 0; font-size: 11pt; color: #626b64; overflow-wrap: anywhere; }

      .badge {
        display: inline-block;
        padding: 4px 8px;
        border: 1px solid #dce0d8;
        font-size: 7pt;
        letter-spacing: 0.06em;
      }

      .badge-warning { color: #8b451c; background: #fbefe3; border-color: #e6d4c2; }

      .metadata-grid, .rental-totals {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: 30px;
        row-gap: 8px;
        margin: 0;
      }

      .metadata-grid > div, .rental-totals > div {
        padding-bottom: 5px;
        border-bottom: 1px solid #dce0d8;
        break-inside: avoid;
      }

      dt, .rent-amount span {
        color: #626b64;
        font-size: 7pt;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      dd { margin: 2px 0 0; overflow-wrap: anywhere; }

      .report-section { margin-top: 24px; }

      .financial-summary { break-inside: avoid; }
      .currency-note { margin: -4px 0 6px; color: #626b64; font-size: 8pt; break-after: avoid; }
      .currency-note dt, .currency-note dd { display: inline; }
      .currency-note dd { margin-left: 8px; }
      .summary-ledger { break-inside: avoid; }
      .summary-item {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 20px;
        padding: 7px 0;
        border-bottom: 1px solid #dce0d8;
        break-inside: avoid;
      }

      .summary-item strong, .rent-amount strong { font-size: 11pt; font-weight: 400; text-align: right; font-variant-numeric: tabular-nums; }
      .summary-item span { color: #626b64; }
      .amount-payable { display: block; margin-bottom: 12px; padding: 14px 18px; border: 0; background: #eef2e9; }
      .amount-payable span { display: block; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; }
      .amount-payable strong { display: block; margin-top: 5px; text-align: left; font-family: Georgia, 'Times New Roman', serif; font-size: 27pt; line-height: 1.2; overflow-wrap: anywhere; }

      .rental-card {
        margin-bottom: 24px;
        padding-top: 8px;
      }

      .card-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        break-inside: avoid;
        break-after: avoid;
      }

      .card-header > div { min-width: 0; overflow-wrap: anywhere; }
      .card-header p { color: #626b64; font-size: 7pt; }
      .rent-amount { max-width: 45%; text-align: right; }
      .rent-amount span, .rent-amount strong { display: block; }
      .rental-note, .capture-time { color: #626b64; font-size: 8pt; break-after: avoid; }
      .rental-note { padding: 8px 10px; background: #eef2e9; }
      .rental-totals { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .rental-totals dd { font-variant-numeric: tabular-nums; }

      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 8pt;
      }

      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      th, td {
        padding: 9px 7px;
        border-bottom: 1px solid #dce0d8;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }

      th { color: #626b64; background: #eef2e9; font-weight: 400; }
      td { font-variant-numeric: tabular-nums; }
      .reference { display: block; margin-top: 4px; color: #626b64; font-size: 6.5pt; }
      .reference-cell { color: #626b64; font-size: 7pt; }
      .low-stock h2 { color: #8b451c; }
      .low-stock th { color: #8b451c; background: #fbefe3; }
      .inventory-status { padding: 8px 10px; margin-bottom: 8px; border-left: 2px solid #8b451c; background: #fbefe3; color: #8b451c; font-size: 8pt; break-after: avoid; }
      .low-stock .empty-state { border-color: #8b451c; background: #fbefe3; }

      .empty-state {
        padding: 10px;
        border-left: 2px solid #dce0d8;
        color: #626b64;
        background: #eef2e9;
      }

      ul { margin: 0; padding-left: 20px; }
      li { margin-bottom: 5px; }

      .report-footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #dce0d8; color: #626b64; font-size: 7pt; break-inside: avoid; overflow-wrap: anywhere; }
      .report-footer p { margin: 0 0 4px; }
      .footer-brand { letter-spacing: 0.1em; }

      @media print {
        .report-footer { display: none; }
      }

      @media screen {
        body { max-width: 210mm; margin: 0 auto; padding: 16mm 14mm; }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderMetadata(report)}
      ${renderFinancialSummary(report)}
      ${renderRentals(report)}
      ${renderProductSales(report)}
      ${renderLowStock(report)}
      ${renderNotes(report)}
    </main>
    <footer class="report-footer">
      <p class="footer-brand">CORNVEN &middot; Monthly Settlement Report</p>
      <p>Report ID: ${escapeHtml(report.reportId)}</p>
      <p>${formatSettlementMonth(report.settlementMonth)} &middot; ${escapeHtml(report.creator.displayName)}</p>
    </footer>
  </body>
</html>`;
}
