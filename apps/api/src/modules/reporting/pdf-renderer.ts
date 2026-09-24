import puppeteer from 'puppeteer';

export interface MonthlyReportPdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

export class PuppeteerMonthlyReportPdfRenderer implements MonthlyReportPdfRenderer {
  async render(html: string): Promise<Uint8Array> {
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
        await page.emulateMediaType('print');
        return await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
        });
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
