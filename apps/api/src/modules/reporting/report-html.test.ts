import { describe, expect, it } from 'vitest';

import type { MonthlyReportDocument } from '@cornven/contracts';

import { renderMonthlyReportHtml } from './report-html.js';

const completeReport = {
  reportId: 'REPORT-2026-09-001',
  generatedAt: '2026-10-02T03:04:05.000Z',
  language: 'en',
  reportStatus: 'draft',
  settlementMonth: '2026-09',
  settlementPeriod: {
    from: '2026-09-01',
    to: '2026-09-30',
    asOf: '2026-10-01T01:02:03.000Z',
  },
  creator: {
    artistId: 'ARTIST-001',
    artistName: 'Yuen',
    brandName: "Yuen's Factory",
    displayName: "Yuen's Factory",
  },
  currency: 'TWD',
  businessTimezone: 'Asia/Taipei',
  isProvisional: true,
  financialSummary: {
    totalProductSalesCents: 123_456,
    refundsCents: 5_000,
    validSalesCents: 118_456,
    creatorRevenueShareAmountCents: 77_500,
    bankTransferFeeCents: 300,
    amountPayableToCreatorCents: 77_200,
  },
  rentals: [
    {
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      venueName: 'Nan Cheng Lane',
      rentalAmountCents: 160_000,
      totalProductSalesCents: 80_000,
      refundsCents: 2_000,
      validSalesCents: 78_000,
      creatorRevenueShareAmountCents: 50_700,
      revenueShares: [
        {
          creatorCommissionBps: 6_500,
          platformCommissionBps: 3_500,
          totalProductSalesCents: 50_000,
          refundsCents: 1_000,
          validSalesCents: 49_000,
          creatorRevenueShareAmountCents: 31_850,
        },
        {
          creatorCommissionBps: 7_000,
          platformCommissionBps: 3_000,
          totalProductSalesCents: 30_000,
          refundsCents: 1_000,
          validSalesCents: 29_000,
          creatorRevenueShareAmountCents: 20_300,
        },
      ],
    },
    {
      rentalId: 'RENTAL-002',
      venueId: 'VENUE-002',
      venueName: 'Second Gallery',
      rentalAmountCents: null,
      totalProductSalesCents: 43_456,
      refundsCents: 3_000,
      validSalesCents: 40_456,
      creatorRevenueShareAmountCents: 26_800,
      revenueShares: [],
    },
  ],
  monthlyProductSalesDetails: [
    {
      productId: 'PRODUCT-001',
      productName: 'Moon Rabbit Print',
      sku: 'SKU-MOON-01',
      rentalId: 'RENTAL-001',
      venueId: 'VENUE-001',
      unitPriceCents: 20_000,
      quantitySold: 4,
      salesAmountCents: 80_000,
    },
  ],
  lowStockReminder: {
    status: 'available',
    capturedAt: '2026-10-01T00:30:00.000Z',
    products: [
      {
        productId: 'PRODUCT-LOW-001',
        productName: 'Low Stock Postcard',
        sku: 'SKU-LOW-01',
        venueId: 'VENUE-001',
        venueName: 'Nan Cheng Lane',
        currentStock: 1,
        monthlyQuantitySold: 9,
      },
    ],
    message: null,
  },
  notes: ['Awaiting customer confirmation.'],
} satisfies MonthlyReportDocument;

const completeRental = completeReport.rentals[0]!;
const completeProductSale = completeReport.monthlyProductSalesDetails[0]!;

function render(report: MonthlyReportDocument = completeReport): string {
  return renderMonthlyReportHtml(report);
}

function declarationsForSelector(html: string, selector: string): string {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

  return rules
    .filter(([, selectors]) =>
      selectors
        ?.split(',')
        .map((candidate) => candidate.trim())
        .includes(selector),
    )
    .map(([, , declarations]) => declarations ?? '')
    .join('\n');
}

describe('renderMonthlyReportHtml', () => {
  it('introduces the creator statement with a brand masthead, current month, and draft status', () => {
    const header = render().match(/<header class="report-header">([\s\S]*?)<\/header>/)?.[1];

    expect(header).toContain('CORN VEN');
    expect(header).toContain('CORNVEN Monthly Settlement Report');
    expect(header).toContain('09/2026');
    expect(header).toContain('Yuen&#39;s Factory');
    expect(header).toContain('DRAFT');
    expect(header).toContain('PROVISIONAL');
  });

  it('identifies the actual report, month, and escaped creator in the statement footer', () => {
    const footer =
      render({
        ...completeReport,
        reportId: 'REPORT-2031-02-XYZ',
        settlementMonth: '2031-02',
        creator: { ...completeReport.creator, displayName: 'Ink & <Paper>' },
      }).match(/<footer[^>]*>([\s\S]*?)<\/footer>/)?.[1] ?? '';

    expect(footer).toContain('REPORT-2031-02-XYZ');
    expect(footer).toContain('02/2031');
    expect(footer).toContain('Ink &amp; &lt;Paper&gt;');
    expect(footer).not.toContain('REPORT-2026-09-001');
  });

  it('retains product identities, currency, and inventory status in visible output', () => {
    const html = render();

    expect(html).toContain('Product ID: PRODUCT-001');
    expect(html).toContain('Product ID: PRODUCT-LOW-001');
    expect(html).toMatch(/Currency<\/dt>\s*<dd>TWD<\/dd>/);
    expect(html).toContain('Inventory status: AVAILABLE');
  });

  it('presents the amount payable before the financial detail rows', () => {
    const summary =
      render().match(
        /<section[^>]+aria-labelledby="financial-summary-heading">([\s\S]*?)<\/section>/,
      )?.[1] ?? '';
    const currency = summary.indexOf('Currency');
    const payable = summary.indexOf('Amount Payable to Creator');
    const details = summary.indexOf('Total Product Sales');

    expect(currency).toBeGreaterThanOrEqual(0);
    expect(payable).toBeGreaterThan(currency);
    expect(details).toBeGreaterThan(payable);
  });

  it('renders the report identity, creator, draft status, sections, and provisional badge', () => {
    const html = render();

    expect(html).toContain('CORNVEN Monthly Settlement Report');
    expect(html).toContain('REPORT-2026-09-001');
    expect(html).toContain('Yuen&#39;s Factory');
    expect(html).toContain('DRAFT');
    expect(html).toContain('PROVISIONAL');
    expect(html).toContain('Financial Summary');
    expect(html).toContain('Rental Breakdown');
    expect(html).toContain('Monthly Product Sales');
    expect(html).toContain('Low Stock Reminder');
    expect(html).toContain('Notes');
  });

  it('shows M4 report status but no M3 settlement run or settlement business status', () => {
    const html = render();

    expect(html).toMatch(/Report Status<\/dt>\s*<dd>DRAFT<\/dd>/);
    expect(html).not.toContain('Settlement Run ID');
    expect(html).not.toContain('Settlement Status');
  });

  it('displays the settlement month as MM/YYYY instead of the internal YYYY-MM value', () => {
    const html = render();

    expect(html).toMatch(/Settlement Month<\/dt>\s*<dd>09\/2026<\/dd>/);
    expect(html).not.toMatch(/Settlement Month<\/dt>\s*<dd>2026-09<\/dd>/);
  });

  it('formats TWD cents with two decimal places and basis points as percentages', () => {
    const html = render();

    expect(html).toContain('NT$1,234.56');
    expect(html).toContain('NT$50.00');
    expect(html).toContain('65.00%');
    expect(html).toContain('35.00%');
  });

  it('shows pending confirmation for every nullable summary amount', () => {
    const html = render({
      ...completeReport,
      rentals: [],
      financialSummary: {
        ...completeReport.financialSummary,
        creatorRevenueShareAmountCents: null,
        bankTransferFeeCents: null,
        amountPayableToCreatorCents: null,
      },
    });

    expect(html).toMatch(
      /Creator Revenue Share Amount<\/span>\s*<strong>Pending confirmation<\/strong>/,
    );
    expect(html).toMatch(/Bank Transfer Fee<\/span>\s*<strong>Pending confirmation<\/strong>/);
    expect(html).toMatch(
      /Amount Payable to Creator<\/span>\s*<strong>Pending confirmation<\/strong>/,
    );
    expect(html.match(/Pending confirmation/g)).toHaveLength(3);
  });

  it('renders multiple rentals and all provided revenue-share groups without deriving totals', () => {
    const html = render();

    expect(html).toContain('RENTAL-001');
    expect(html).toContain('RENTAL-002');
    expect(html).toContain('Nan Cheng Lane');
    expect(html).toContain('Second Gallery');
    expect(html).toContain('65.00%');
    expect(html).toContain('70.00%');
    expect(html).toContain(
      'Rental is displayed separately and is not deducted from amount payable.',
    );
  });

  it('uses explicit empty-state messages for empty collections', () => {
    const html = render({
      ...completeReport,
      rentals: [],
      monthlyProductSalesDetails: [],
      lowStockReminder: {
        status: 'available',
        capturedAt: '2026-10-01T00:30:00.000Z',
        products: [],
        message: null,
      },
      notes: [],
    });

    expect(html).toContain('No rental breakdowns available.');
    expect(html).toContain('No product sales recorded.');
    expect(html).toContain('No low-stock products.');
    expect(html).toContain('No additional notes.');
  });

  it('renders an unavailable inventory message, fallback, and capture-time semantics', () => {
    const unavailableHtml = render({
      ...completeReport,
      lowStockReminder: {
        status: 'unavailable',
        capturedAt: '2026-10-01T00:30:00.000Z',
        products: [],
        message: 'Inventory sync is delayed.',
      },
    });
    const fallbackHtml = render({
      ...completeReport,
      lowStockReminder: {
        status: 'unavailable',
        capturedAt: null,
        products: [],
        message: null,
      },
    });

    expect(unavailableHtml).toContain('Inventory sync is delayed.');
    expect(unavailableHtml).toContain('Inventory captured at');
    expect(unavailableHtml).toContain('2026-10-01T00:30:00.000Z');
    expect(fallbackHtml).toContain('Inventory data unavailable.');
    expect(fallbackHtml).toContain('Inventory capture time not available.');
  });

  it('renders every supplied low-stock product without applying a stock threshold', () => {
    const html = render({
      ...completeReport,
      lowStockReminder: {
        status: 'available',
        capturedAt: '2026-10-01T00:30:00.000Z',
        products: [
          {
            productId: 'PRODUCT-42',
            productName: 'Supplied By M3',
            sku: null,
            venueId: 'VENUE-42',
            venueName: 'High Stock Venue',
            currentStock: 42,
            monthlyQuantitySold: 3,
          },
        ],
        message: null,
      },
    });

    expect(html).toContain('Supplied By M3');
    expect(html).toMatch(/Current Stock<\/th>[\s\S]*?<td>42<\/td>/);
  });

  it('renders both the message and products when available inventory supplies both', () => {
    const html = render({
      ...completeReport,
      lowStockReminder: {
        ...completeReport.lowStockReminder,
        status: 'available',
        message: 'Stock count is provisional.',
      },
    });

    expect(html).toContain('Stock count is provisional.');
    expect(html).toContain('Low Stock Postcard');
  });

  it('renders both the message and products when unavailable inventory supplies both', () => {
    const html = render({
      ...completeReport,
      lowStockReminder: {
        ...completeReport.lowStockReminder,
        status: 'unavailable',
        message: 'Some inventory locations could not be reached.',
      },
    });

    expect(html).toContain('Some inventory locations could not be reached.');
    expect(html).toContain('Low Stock Postcard');
  });

  it('escapes representative dynamic strings instead of inserting executable markup', () => {
    const script = '<script>alert("x")</script>';
    const html = render({
      ...completeReport,
      reportId: script,
      creator: {
        ...completeReport.creator,
        displayName: script,
      },
      rentals: [
        {
          ...completeRental,
          venueName: script,
        },
      ],
      monthlyProductSalesDetails: [
        {
          ...completeProductSale,
          productName: script,
          sku: script,
        },
      ],
      lowStockReminder: {
        status: 'unavailable',
        capturedAt: null,
        products: [],
        message: script,
      },
      notes: [script],
    });

    expect(html).not.toContain(script);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('does not restore obsolete reconciliation or report-version labels', () => {
    const html = render();

    expect(html).not.toContain('Reconciliation');
    expect(html).not.toContain('Source Amount');
    expect(html).not.toContain('Difference');
    expect(html).not.toContain('Requires Review');
    expect(html).not.toContain('Report Version');
  });

  it('returns a self-contained semantic A4 document with print-safe table markup', () => {
    const html = render();

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('@page');
    expect(html).toContain('size: A4');
    expect(html).toContain('print-color-adjust: exact');
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('thead {');
    expect(html).toContain('display: table-header-group');
    expect(html).toMatch(/<section[^>]+aria-labelledby="financial-summary-heading"/);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
  });

  it('allows long report sections and rental cards to flow naturally across pages', () => {
    const html = render();

    expect(declarationsForSelector(html, '.report-section')).not.toContain('break-inside: avoid');
    expect(declarationsForSelector(html, '.rental-card')).not.toContain('break-inside: avoid');
    expect(declarationsForSelector(html, 'tr')).toContain('break-inside: avoid');
    expect(declarationsForSelector(html, 'h2')).toContain('break-after: avoid');
  });

  it('prints a repeated report identity footer with current and total page numbers', () => {
    const html = render();
    const printFooter = html.match(/@bottom-left\s*{([^}]*)}/s)?.[1] ?? '';

    expect(printFooter).toContain('REPORT-2026-09-001');
    expect(printFooter).toContain('09/2026');
    expect(printFooter).toContain("Yuen's Factory");
    expect(html).toMatch(/@bottom-right\s*{[^}]*counter\(page\)[^}]*counter\(pages\)/s);
  });

  it('safely escapes dynamic report identity before placing it in print CSS', () => {
    const html = render({
      ...completeReport,
      reportId: '</style><script>alert("footer")</script>',
    });

    expect(html).not.toContain('</style><script>alert("footer")</script>');
    expect(html).toContain('\\3c /style\\3e \\3c script\\3e alert(\\"footer\\")');
  });

  it('keeps the document footer for screen output but hides it from printed pages', () => {
    const html = render();

    expect(html).toContain('<footer class="report-footer">');
    expect(html).toMatch(/@media print\s*{[\s\S]*?\.report-footer\s*{[^}]*display:\s*none;[^}]*}/);
  });

  it('keeps the compact financial ledger together to prevent a single orphaned row', () => {
    const html = render();

    expect(html).toContain('class="report-section financial-summary"');
    expect(declarationsForSelector(html, '.summary-ledger')).toContain('break-inside: avoid');
    expect(declarationsForSelector(html, '.financial-summary')).toContain('break-inside: avoid');
  });
});
