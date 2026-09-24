// Runs real HTTP, PostgreSQL and browser checks in the isolated test database. No model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.env.DATABASE_URL =
  'postgresql://cornven_planb:mock_only_local@127.0.0.1:55449/cornven_planb_test?schema=public';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));
const { database: db } = await import('../packages/database/dist/index.js');
const { createApp } = await import('../apps/api/dist/app.js');
const { createReportRuntime } = await import(
  '../apps/api/dist/modules/reporting/report-runtime.js'
);
const storagePath = await mkdtemp(join(tmpdir(), 'cornven-approval-browser-'));
const tag = 'Approval Browser ' + randomUUID();
const artist = await db.artist.create({ data: { name: tag, externalRef: tag } });
const runtime = createReportRuntime({
  db,
  storagePath,
  resolveActor: () => ({ id: 'local-demo-staff', artistIds: '*' }),
});
const server = createApp(runtime).listen(0, '127.0.0.1');
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
    '5201',
    '--strictPort',
  ],
  {
    cwd: root,
    env: { ...process.env, VITE_API_BASE_URL: api },
    stdio: 'ignore',
    detached: true,
  },
);
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch('http://127.0.0.1:5201')).ok) break;
    } catch {
      /* Vite startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1080 });
  await mkdir('.local/evidence', { recursive: true });
  async function generate() {
    await page.goto('http://127.0.0.1:5201/settlements', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.actions-row input:not([disabled])');
    await page.type('form input', tag);
    await page.click('form button');
    await page.waitForSelector(
      `select[aria-label="Settlement artist"]:not([disabled]) option[value="${artist.id}"]`,
    );
    const pending = page.waitForResponse(
      (r) => r.url() === api + '/api/v1/reports' && r.request().method() === 'POST',
    );
    await page.click('[data-testid="generate-report"]');
    const response = await pending;
    assert.equal(response.status(), 201);
    const report = await response.json();
    await page.waitForSelector(`[data-testid="submit-report-${report.reportId}"]:not([disabled])`);
    return report.reportId;
  }
  async function action(selector, status) {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/actions') && r.request().method() === 'POST',
    );
    await page.click(selector);
    const response = await pending;
    assert.equal(response.status(), 200);
    const detail = await response.json();
    assert.equal(detail.summary.approvalStatus, status);
    return detail;
  }
  async function open(id) {
    await page.goto(`http://127.0.0.1:5201/approvals?reportId=${id}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForSelector('[aria-label="Approval decision"]');
  }
  const first = await generate();
  await action(`[data-testid="submit-report-${first}"]`, 'pending');
  await open(first);
  assert.equal(await page.$eval('[data-testid="reject-report"]', (e) => e.disabled), true);
  await page.type(
    'textarea[aria-label="Review note"]',
    'Refund totals need correction before the next version.',
  );
  await action('[data-testid="reject-report"]', 'rejected');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="approval-current-status"]')?.textContent === 'Rejected',
  );
  await page.reload({ waitUntil: 'networkidle0' });
  assert.match(
    await page.$eval('[aria-label="Approval history"]', (e) => e.textContent),
    /Refund totals need correction/,
  );
  await page.screenshot({ path: '.local/evidence/approvals-rejected.png', fullPage: true });
  const second = await generate();
  const draft = await runtime.approvals.detail(second, { id: 'browser', artistIds: '*' });
  assert.equal(draft.summary.approvalStatus, 'draft');
  await action(`[data-testid="submit-report-${second}"]`, 'pending');
  await open(second);
  await page.type('textarea[aria-label="Review note"]', 'New version checked.');
  await action('[data-testid="approve-report"]', 'approved');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="approval-current-status"]')?.textContent === 'Approved',
  );
  await page.reload({ waitUntil: 'networkidle0' });
  await page.select('select[aria-label="Approval status"]', 'approved');
  await page.type('input[aria-label="Approval artist search"]', tag);
  await page.click('form button');
  await page.waitForSelector(`[data-testid="review-${second}"]`);
  assert.equal(await page.$(`[data-testid="review-${first}"]`), null);
  const pdf = await fetch(`${api}/api/v1/reports/${second}/download`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.equal(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5)), '%PDF-');
  const selected = await runtime.approvals.detail(second, { id: 'browser', artistIds: '*' });
  assert.equal(selected.events.length, 2);
  assert.equal(
    (await runtime.approvals.detail(first, { id: 'browser', artistIds: '*' })).summary
      .approvalStatus,
    'rejected',
  );
  await page.screenshot({ path: '.local/evidence/approvals-approved.png', fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    '.local/evidence/approvals-browser.json',
    JSON.stringify(
      {
        passed: true,
        checked: [
          'generate PDF',
          'submit',
          'reject reason',
          'persist after reload',
          'new version is draft',
          'resubmit new version',
          'approve',
          'filter queue',
          'download saved PDF',
          'history and version isolation',
        ],
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('Approval browser closed loop passed; screenshots saved in .local/evidence.');
} finally {
  await browser?.close();
  try {
    process.kill(-web.pid, 'SIGTERM');
  } catch {
    /* Already stopped */
  }
  await new Promise((resolve) => server.close(resolve));
  const ids = (
    await db.artistMonthlyReport.findMany({ where: { artistId: artist.id }, select: { id: true } })
  ).map((r) => r.id);
  await db.monthlyReportApprovalEvent.deleteMany({ where: { reportId: { in: ids } } });
  await db.monthlyReportApproval.deleteMany({ where: { reportId: { in: ids } } });
  await db.reportArtifact.deleteMany({ where: { reportId: { in: ids } } });
  await db.settlementInputSnapshot.deleteMany({ where: { reportId: { in: ids } } });
  await db.reportGenerationTask.deleteMany({ where: { artistId: artist.id } });
  await db.artistMonthlyReport.deleteMany({ where: { artistId: artist.id } });
  await db.artist.delete({ where: { id: artist.id } });
  await db.$disconnect();
  await rm(storagePath, { recursive: true, force: true });
}
