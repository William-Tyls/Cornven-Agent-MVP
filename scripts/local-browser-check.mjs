import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
loadEnvFile('.env');
process.env.DATABASE_URL =
  'postgresql://cornven_planb:mock_only_local@127.0.0.1:55449/cornven_planb_test?schema=public';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));
const { createApp } = await import('../apps/api/dist/app.js');
const { createReportRuntime } = await import(
  '../apps/api/dist/modules/reporting/report-runtime.js'
);
const { database: db } = await import('../packages/database/dist/index.js');
await mkdir('.local/evidence', { recursive: true });
const artist = await db.artist.findUniqueOrThrow({ where: { externalRef: 'ART-001' } });
const artistId = artist.id;
let now = new Date('2026-08-31T15:59:59.500Z');
const runtime = createReportRuntime({
  db,
  now: () => new Date(now),
  storagePath: root + '/.local/e2e-pdfs',
  resolveActor: () => ({ id: 'browser-check', artistIds: '*' }),
  startMonth: '2026-08',
});
// Deterministic model double ONLY for repeatable integration tests. Production always uses OpenAI.
const modelCalls = [];
const assistantModel = {
  configured: true,
  async classify(input) {
    modelCalls.push(input);
    const base = {
      intent: 'settlement.preview',
      slots: { artistQuery: 'ART-001', settlementMonth: '2026-08', knowledgeQuery: null },
      clarification: null,
    };
    if (input.message === '帮我试算 ART-001')
      return {
        ...base,
        slots: { ...base.slots, settlementMonth: null },
        clarification: { missingFields: ['settlementMonth'], question: '请提供结算年月。' },
      };
    if (input.message === '查询已保存报告') return { ...base, intent: 'settlement.get' };
    if (input.message === '幫我退款') return { ...base, intent: 'unsupported' };
    if (input.message === '補貨流程')
      return {
        ...base,
        intent: 'documents.search',
        slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: '補貨流程' },
      };
    return base;
  },
  async answerKnowledge(_question, evidence) {
    return {
      answer: evidence.items[0].citation.excerpt + ' [1]',
      evidenceSufficient: true,
      citationIds: [evidence.items[0].citation.chunkId],
    };
  },
};
const server = createApp(runtime, assistantModel).listen(0, '127.0.0.1');
await once(server, 'listening');
const api = `http://127.0.0.1:${server.address().port}`;
const web = spawn(
  'pnpm',
  [
    '--filter',
    '@cornven/web',
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    '5200',
    '--strictPort',
  ],
  { cwd: root, env: { ...process.env, VITE_API_BASE_URL: api }, stdio: 'ignore' },
);
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch('http://127.0.0.1:5200')).ok) break;
    } catch {
      /* Wait for Vite to bind the dedicated test port. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const browserErrors = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  const generationRequests = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/reports') && request.method() === 'POST')
      generationRequests.push(JSON.parse(request.postData()));
  });
  await page.goto('http://127.0.0.1:5200/settlements', { waitUntil: 'networkidle0' });
  await page.waitForSelector('select option[value="' + artist.id + '"]');
  await page.select('select', artist.id);
  await page.click('[data-testid="generate-report"]');
  await page.waitForSelector('section[aria-label="Report detail"]', { timeout: 30000 });
  const text = await page.$eval('section[aria-label="Report detail"]', (el) => el.innerText);
  assert.match(text, /150\.00/);
  assert.match(text, /120\.00/);
  assert.match(text, /Pending confirmation/);
  assert.match(text, /SKU-A-004/);
  assert.deepEqual(generationRequests, [
    { artistId: artist.id, period: 'current_month', format: 'pdf' },
  ]);
  await page.screenshot({ path: '.local/evidence/manual-report.png', fullPage: true });
  const listing = await (
    await fetch(`${api}/api/v1/reports?artistId=${artist.id}&settlementMonth=2026-08`)
  ).json();
  const manual = listing.items.find((r) => r.trigger === 'manual');
  assert.ok(manual);
  const response = await fetch(api + manual.pdfFileReference);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 5000);
  await writeFile('.local/evidence/manual-report.pdf', bytes);
  const pdfText = spawnSync('pdftotext', ['.local/evidence/manual-report.pdf', '-'], {
    encoding: 'utf8',
  });
  assert.equal(pdfText.status, 0);
  assert.match(pdfText.stdout, /150\.00/);
  assert.match(pdfText.stdout, /120\.00/);
  assert.match(pdfText.stdout, /SKU-A-004/);
  await page.click('[data-testid="download-report"]');
  await page.waitForNetworkIdle();
  // Recreate the application service against the same persisted state (process-independent storage).
  const restarted = createReportRuntime({
    db,
    now: () => new Date(now),
    storagePath: root + '/.local/e2e-pdfs',
    resolveActor: () => ({ id: 'browser-check', artistIds: '*' }),
    startMonth: '2026-08',
  });
  const persisted = await restarted.service.download(manual.reportId, {
    id: 'browser-check',
    artistIds: '*',
  });
  assert.deepEqual(Buffer.from(persisted.bytes), bytes);
  // Schedule two months to prove missed-month catch-up using a fixed server clock.
  now = new Date('2026-10-01T00:10:00+08:00');
  await restarted.scheduler.tick();
  await restarted.scheduler.tick();
  await page.click('[data-testid="refresh-reports"]');
  await page.waitForFunction(() => document.body.innerText.includes('Automatic'));
  await page.screenshot({ path: '.local/evidence/automatic-reports.png', fullPage: true });
  assert.equal(
    await db.scheduledReportLock.count({ where: { artistId, settlementMonth: '2026-09' } }),
    1,
  );
  const scheduled = await db.artistMonthlyReport.findFirstOrThrow({
    where: { artistId, settlementMonth: '2026-09', trigger: 'scheduled' },
  });
  assert.equal(scheduled.isProvisional, false);
  // Exercise the real upload/confirmation UI with an isolated artist in the test database.
  now = new Date('2026-09-20T04:00:00Z');
  const tag = 'BROWSER-CSV-' + randomUUID();
  const csvArtist = await db.artist.create({
    data: { externalRef: tag + '-ART', name: 'CSV import demonstration' },
  });
  const venue = await db.venue.findUniqueOrThrow({ where: { externalRef: 'VENUE-001' } });
  await db.product.create({
    data: {
      externalRef: tag + '-PROD',
      artistId: csvArtist.id,
      name: 'Imported sample cup',
      sku: tag + '-SKU',
    },
  });
  await db.rental.create({
    data: {
      externalRef: tag + '-RENTAL',
      artistId: csvArtist.id,
      venueId: venue.id,
      commissionBps: 2500,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    },
  });
  const priorReport = await runtime.service.generate(
    { artistId: csvArtist.id, period: 'current_month', format: 'pdf' },
    randomUUID(),
    { id: 'browser-check', artistIds: '*' },
  );
  const priorSnapshot = (
    await runtime.repository.getReport(priorReport.body.reportId, {
      id: 'browser-check',
      artistIds: '*',
    })
  ).reportJson;
  const uploadCsv = (await readFile('fixtures/pos/plan-b-import-demo.csv', 'utf8'))
    .replaceAll('PLANB-P1', tag)
    .replaceAll('ART-001', tag + '-ART')
    .replaceAll('PROD-001', tag + '-PROD')
    .replaceAll('SKU-A-001', tag + '-SKU')
    .replaceAll('RENTAL-001', tag + '-RENTAL');
  const csvPath = root + '/.local/evidence/import-browser.csv';
  await writeFile(csvPath, uploadCsv);
  await page.goto('http://127.0.0.1:5200/import', { waitUntil: 'networkidle0' });
  await (await page.$('input[type="file"]')).uploadFile(csvPath);
  await page.waitForSelector('[data-testid="validate-import"]');
  const csvResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/imports/batches') && response.request().method() === 'POST',
  );
  await page.click('[data-testid="validate-import"]');
  const validated = await csvResponse;
  assert.equal(validated.status(), 201);
  const csvResult = await validated.json();
  assert.equal(csvResult.status, 'VALIDATED');
  assert.equal(csvResult.totalRows, 100);
  assert.equal(csvResult.summary.saleRows, 70);
  assert.equal(csvResult.summary.refundRows, 20);
  assert.equal(csvResult.summary.exchangeRows, 10);
  assert.equal(csvResult.summary.newRecords, 90);
  assert.equal(await db.sale.count({ where: { artistId: csvArtist.id } }), 0);
  await page.waitForSelector('[data-testid="confirm-import"]:not([disabled])');
  const confirmedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/' + csvResult.id + '/confirm') &&
      response.request().method() === 'POST',
  );
  await page.click('[data-testid="confirm-import"]');
  assert.equal((await (await confirmedResponse).json()).status, 'IMPORTED');
  await page.waitForFunction(() => document.body.innerText.includes('Import complete.'));
  await page.screenshot({ path: '.local/evidence/csv-confirmed.png', fullPage: true });
  // Re-upload is an idempotent lookup of the same saved batch.
  const replayResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/imports/batches') && response.request().method() === 'POST',
  );
  await page.click('[data-testid="validate-import"]');
  assert.equal((await (await replayResponse).json()).id, csvResult.id);
  assert.equal(await db.sale.count({ where: { artistId: csvArtist.id } }), 90);
  await page.goto('http://127.0.0.1:5200/import/errors?batch=' + csvResult.id, {
    waitUntil: 'networkidle0',
  });
  await page.waitForSelector('[data-testid="import-batch-detail"]');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('Import complete.'));
  await page.screenshot({ path: '.local/evidence/import-history.png', fullPage: true });
  await page.goto('http://127.0.0.1:5200/settlements', { waitUntil: 'networkidle0' });
  await page.waitForSelector('select option[value="' + csvArtist.id + '"]');
  await page.select('select', csvArtist.id);
  await page.click('[data-testid="generate-report"]');
  await page.waitForSelector('section[aria-label="Report detail"]');
  const importedText = await page.$eval(
    'section[aria-label="Report detail"]',
    (el) => el.innerText,
  );
  assert.match(importedText, /7,000\.00/);
  assert.match(importedText, /1,000\.00/);
  assert.match(importedText, /4,500\.00/);
  assert.deepEqual(
    (
      await runtime.repository.getReport(priorReport.body.reportId, {
        id: 'browser-check',
        artistIds: '*',
      })
    ).reportJson,
    priorSnapshot,
  );
  await page.screenshot({ path: '.local/evidence/imported-report.png', fullPage: true });
  // Live preview reads the imported data without creating reports, tasks, PDFs or approvals.
  const previewCounts = async () => ({
    reports: await db.artistMonthlyReport.count(),
    tasks: await db.reportGenerationTask.count(),
    snapshots: await db.settlementInputSnapshot.count(),
    artifacts: await db.reportArtifact.count(),
    approvals: await db.approvalEvent.count(),
    sales: await db.sale.count(),
  });
  const beforePreview = await previewCounts();
  await page.goto('http://127.0.0.1:5200/settlements/preview', { waitUntil: 'networkidle0' });
  assert.equal(new URL(page.url()).pathname, '/settlements');
  assert.equal(await page.$('nav a[href="/settlements/preview"]'), null);
  await page.waitForSelector(
    'select[aria-label="Settlement artist"]:not([disabled]) option[value="' + csvArtist.id + '"]',
  );
  await page.select('select[aria-label="Settlement artist"]', csvArtist.id);
  async function setPreviewMonth(month) {
    await page.$eval(
      'input[aria-label="Settlement month"]',
      (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          element,
          value,
        );
        element.dispatchEvent(new Event('input', { bubbles: true }));
      },
      month,
    );
  }
  await setPreviewMonth('2026-09');
  async function runPreview() {
    const pending = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/settlements/monthly-preview') &&
        response.request().method() === 'POST',
    );
    await page.click('[data-testid="preview-settlement"]');
    const response = await pending;
    assert.equal(response.status(), 200);
    await page.waitForSelector('section[aria-label="Settlement preview result"]');
    return response.json();
  }
  const preview = await runPreview();
  assert.equal(preview.result.validSalesCents, 600000);
  assert.equal(preview.result.creatorRevenueShareAmountCents, 450000);
  assert.equal(preview.result.amountPayableToCreatorCents, null);
  assert.equal(preview.result.isProvisional, true);
  assert.equal(preview.readOnly, true);
  assert.match(
    await page.$eval('section[aria-label="Settlement preview result"]', (el) => el.innerText),
    /Read-only preview/,
  );
  await page.screenshot({ path: '.local/evidence/monthly-preview.png', fullPage: true });
  await page.waitForSelector('[data-testid="preview-settlement"]:not([disabled])');
  await page.select('select[aria-label="Settlement artist"]', artistId);
  await setPreviewMonth('2026-08');
  assert.equal(await page.$('section[aria-label="Settlement preview result"]'), null);
  assert.equal(
    await page.$eval('[data-testid="generate-report"]', (button) => button.disabled),
    true,
  );
  const historicalPreview = await runPreview();
  assert.equal(historicalPreview.result.creatorRevenueShareAmountCents, 12000);
  assert.equal(historicalPreview.result.lowStockReminder.products.length, 4);
  assert.equal(historicalPreview.result.isProvisional, false);
  await page.screenshot({ path: '.local/evidence/historical-preview.png', fullPage: true });
  const toolResponse = await fetch(api + '/api/v1/assistant/tools/settlement.preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artistId, settlementMonth: '2026-08' }),
  });
  assert.equal(toolResponse.status, 200);
  assert.deepEqual(await toolResponse.json(), historicalPreview);
  assert.deepEqual(await previewCounts(), beforePreview);

  // The shared controls can then save a current-month report and view an older snapshot.
  await page.waitForSelector('[data-testid="preview-settlement"]:not([disabled])');
  await page.select('select[aria-label="Settlement artist"]', csvArtist.id);
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Current month')
      .click(),
  );
  await runPreview();
  await page.waitForSelector('[data-testid="generate-report"]:not([disabled])');
  await page.click('[data-testid="generate-report"]');
  await page.waitForSelector('section[aria-label="Report detail"]');
  assert.equal(await page.$('section[aria-label="Settlement preview result"]'), null);
  assert.match(
    await page.$eval('section[aria-label="Report detail"]', (el) => el.innerText),
    /Saved report/,
  );
  assert.match(
    await page.$eval('section[aria-label="Report detail"]', (el) => el.innerText),
    /4,500\.00/,
  );
  assert.equal((await previewCounts()).reports, beforePreview.reports + 1);
  await page.waitForSelector(
    '[data-testid="view-report-' + priorReport.body.reportId + '"]:not([disabled])',
  );
  await page.click('[data-testid="view-report-' + priorReport.body.reportId + '"]');
  await page.waitForFunction(() =>
    document.querySelector('section[aria-label="Report detail"]')?.textContent.includes('NT$0.00'),
  );
  assert.equal(await page.$('section[aria-label="Settlement preview result"]'), null);
  await page.screenshot({ path: '.local/evidence/unified-settlement-runs.png', fullPage: true });

  // Failed rows also survive navigation and reload.
  const badPath = root + '/.local/evidence/import-invalid.csv';
  await writeFile(badPath, uploadCsv.replaceAll(tag + '-ART', 'MISSING-ARTIST'));
  await page.goto('http://127.0.0.1:5200/import', { waitUntil: 'networkidle0' });
  await (await page.$('input[type="file"]')).uploadFile(badPath);
  await page.waitForSelector('[data-testid="validate-import"]');
  const failedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/imports/batches') && response.request().method() === 'POST',
  );
  await page.click('[data-testid="validate-import"]');
  const failedBatch = await (await failedResponse).json();
  assert.equal(failedBatch.status, 'FAILED');
  await page.goto('http://127.0.0.1:5200/import/errors?batch=' + failedBatch.id, {
    waitUntil: 'networkidle0',
  });
  await page.waitForFunction(() => document.body.innerText.includes('Unknown artist reference'));
  await page.screenshot({ path: '.local/evidence/import-errors.png', fullPage: true });
  await page.goto('http://127.0.0.1:5200/assistant', { waitUntil: 'networkidle0' });
  const beforeChat = {
    reports: await db.artistMonthlyReport.count(),
    tasks: await db.reportGenerationTask.count(),
    artifacts: await db.reportArtifact.count(),
  };
  async function askChat(text) {
    const count = await page.$$eval('.chat-bubble--assistant', (nodes) => nodes.length);
    await page.type('#chat-question', text);
    await page.click('.chat-composer button[type="submit"]');
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll('.chat-bubble--assistant').length > n &&
        !document.querySelector('.chat-bubble[aria-busy="true"]'),
      { timeout: 30000 },
      count,
    );
    return page
      .$eval('.chat-bubble--assistant:last-of-type', (el) => el.innerText)
      .catch(() => page.$$eval('.chat-bubble--assistant', (nodes) => nodes.at(-1).innerText));
  }
  await askChat('帮我试算 ART-001');
  assert.match(await page.$eval('.chat-thread', (el) => el.innerText), /请提供结算年月/);
  await askChat('2026年8月');
  assert.equal(modelCalls[1].history.length, 2);
  assert.match(await page.$eval('.chat-thread', (el) => el.innerText), /未保存/);
  await askChat('查询已保存报告');
  assert.match(await page.$eval('.chat-thread', (el) => el.innerText), /最新已保存报告/);
  const savedRead = await (
    await fetch(api + '/api/v1/assistant/tools/settlement.get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artistId, settlementMonth: '2026-08' }),
    })
  ).json();
  assert.equal(savedRead.report.settlementMonth, '2026-08');
  await askChat('補貨流程');
  assert.ok(await page.$('.chat-bubble blockquote'));
  await askChat('幫我退款');
  assert.match(await page.$eval('.chat-thread', (el) => el.innerText), /暂不支持/);
  assert.deepEqual(
    {
      reports: await db.artistMonthlyReport.count(),
      tasks: await db.reportGenerationTask.count(),
      artifacts: await db.reportArtifact.count(),
    },
    beforeChat,
  );
  await page.screenshot({ path: '.local/evidence/chatbot.png', fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/evidence/chatbot-mobile.png', fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  assert.deepEqual(browserErrors, []);
  await writeFile(
    '.local/evidence/browser-result.json',
    JSON.stringify(
      {
        passed: true,
        manualReportId: manual.reportId,
        scheduledReportId: scheduled.id,
        request: generationRequests[0],
        pdfBytes: bytes.length,
        browserErrors,
        checks: [
          'browser generation',
          'JSON/PDF amounts',
          'download',
          'service recreation',
          'scheduled catch-up',
          'scheduled deduplication',
          'CSV upload then atomic confirmation',
          'idempotent re-upload',
          'persistent import and error history',
          'imported transactions reach new reports',
          'previous report snapshot unchanged',
          'monthly preview reads imported transactions',
          'historical preview and M5 tool agree',
          'preview creates no reports, tasks, artifacts or approvals',
          'shared page previews then saves and views an older report',
          'historical preview cannot accidentally save current month',
          'old preview URL redirects and separate navigation is removed',
          'Chatbot free text, clarification history, M3 preview, saved snapshot, real RAG citations and unsupported action',
          'Chatbot creates no reports, tasks or artifacts (test model; no live API call)',
          'Chatbot mobile layout',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Browser and real PDF checks passed:',
    manual.reportId,
    scheduled.id,
    bytes.length,
    'bytes',
  );
} finally {
  if (browser) await browser.close();
  web.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  await db.$disconnect();
}
