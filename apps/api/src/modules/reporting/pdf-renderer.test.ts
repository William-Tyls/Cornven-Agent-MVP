import { describe, expect, it } from 'vitest';

import { PuppeteerMonthlyReportPdfRenderer } from './pdf-renderer.js';

const standaloneHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PDF renderer test</title>
    <style>
      body { font-family: sans-serif; }
      h1 { color: #1f2937; }
    </style>
  </head>
  <body>
    <h1>Standalone PDF renderer test</h1>
    <p>This document tests PDF generation without any reporting business logic.</p>
  </body>
</html>`;

describe('PuppeteerMonthlyReportPdfRenderer', () => {
  it('renders standalone HTML as a non-empty PDF', async () => {
    const renderer = new PuppeteerMonthlyReportPdfRenderer();

    const bytes = await renderer.render(standaloneHtml);
    const pdfText = Buffer.from(bytes).toString('latin1');

    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(100);
    expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true);
  }, 30_000);
});
