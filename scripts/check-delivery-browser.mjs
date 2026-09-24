// Real SMTP to loopback Mailpit, real browser/API/DB/PDF; never external email or OpenAI.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
const { createReportMailer } = await import('../apps/api/dist/modules/delivery/mail-transport.js');
const storagePath = await mkdtemp(join(tmpdir(), 'cornven-delivery-browser-'));
const tag = randomUUID();
const artists = await Promise.all(
  ['Manual', 'Automatic', 'Pending'].map((name) =>
    db.artist.create({
      data: { name: `Delivery ${name} Test ${tag.slice(0, 8)}`, externalRef: `${tag}-${name}` },
    }),
  ),
);
let now = new Date('2091-02-01T01:00:00Z');
const actor = { id: 'local-demo-staff', artistIds: '*' };
const runtime = createReportRuntime({
  db,
  storagePath,
  now: () => now,
  mailer: createReportMailer({ DELIVERY_MODE: 'local' }),
  resolveActor: () => actor,
});
async function generate(a, approved) {
  const key = randomUUID();
  const { task } = await runtime.repository.getOrCreate(
    { artistId: a.id, settlementMonth: '2091-01', asOf: '2091-01-31T16:00:00Z', trigger: 'manual' },
    actor.id,
    key,
    key,
    now,
  );
  const report = await runtime.service.runTask(task.id);
  if (approved) {
    await runtime.approvals.act(report.id, { action: 'submit', requestId: randomUUID() }, actor);
    await runtime.approvals.act(report.id, { action: 'approve', requestId: randomUUID() }, actor);
  }
  return report.id;
}
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
    '5202',
    '--strictPort',
  ],
  { cwd: root, env: { ...process.env, VITE_API_BASE_URL: api }, stdio: 'ignore', detached: true },
);
let browser;
try {
  const manualId = await generate(artists[0], true),
    automaticId = await generate(artists[1], true);
  await generate(artists[2], false);
  await runtime.delivery.saveProfile(
    artists[1].id,
    { recipientEmail: `auto-${tag}@cornven.test`, automaticEnabled: true },
    actor,
  );
  await runtime.delivery.saveProfile(
    artists[2].id,
    { recipientEmail: `pending-${tag}@cornven.test`, automaticEnabled: true },
    actor,
  );
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch('http://127.0.0.1:5202')).ok) break;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto('http://127.0.0.1:5202/deliveries', { waitUntil: 'networkidle0' });
  await page.waitForSelector('form input:not([disabled])');
  await page.type('form input', tag.slice(0, 8));
  await page.waitForSelector('form button:not([disabled])');
  await page.click('form button');
  await page.waitForSelector(
    `select[aria-label="Delivery artist"]:not([disabled]) option[value="${artists[0].id}"]`,
  );
  await page.select('select[aria-label="Delivery artist"]', artists[0].id);
  await page.waitForFunction(
    (id) =>
      document.querySelector('select[aria-label="Delivery artist"]')?.value === id &&
      !document.querySelector('input[aria-label="Recipient email"]')?.disabled,
    {},
    artists[0].id,
  );
  await page.waitForSelector('input[aria-label="Recipient email"]:not([disabled])');
  await page.type('input[aria-label="Recipient email"]', `manual-${tag}@cornven.test`);
  await page.click('input[aria-label="Enable automatic delivery"]');
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/profiles/'),
  );
  await page.click('[data-testid="save-delivery-profile"]');
  assert.equal((await saved).status(), 200);
  await page.waitForSelector(`[data-testid="send-report-${manualId}"]:not([disabled])`);
  const sending = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url() === api + '/api/v1/deliveries',
  );
  await page.click(`[data-testid="send-report-${manualId}"]`);
  const sent = await sending;
  assert.equal(sent.status(), 200);
  const record = await sent.json();
  assert.equal(record.status, 'sent');
  await page.waitForSelector(`[data-testid="delivery-${record.id}"]`);
  assert.equal(
    await page.$eval(`[data-testid="send-report-${manualId}"]`, (e) => e.disabled),
    true,
  );
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('form input:not([disabled])');
  await page.type('form input', tag.slice(0, 8));
  await page.waitForSelector('form button:not([disabled])');
  await page.click('form button');
  await page.waitForSelector(
    `select[aria-label="Delivery artist"]:not([disabled]) option[value="${artists[0].id}"]`,
  );
  await page.select('select[aria-label="Delivery artist"]', artists[0].id);
  await page.waitForSelector(`[data-testid="delivery-${record.id}"]`);
  await mkdir('.local/evidence', { recursive: true });
  await page.screenshot({ path: '.local/evidence/delivery-manual.png', fullPage: true });
  now = new Date('2091-02-01T01:59:59.999Z');
  await runtime.delivery.tick();
  assert.equal((await runtime.delivery.list({ artistId: artists[1].id }, actor)).items.length, 0);
  now = new Date('2091-02-01T02:00:00Z');
  await runtime.delivery.tick();
  await runtime.delivery.tick();
  const automatic = (await runtime.delivery.list({ artistId: artists[1].id }, actor)).items;
  assert.equal(automatic.length, 1);
  assert.equal(automatic[0].status, 'sent');
  assert.equal(automatic[0].reportId, automaticId);
  assert.equal((await runtime.delivery.list({ artistId: artists[0].id }, actor)).items.length, 1);
  assert.equal(
    (await runtime.delivery.list({ artistId: artists[2].id }, actor)).items[0].status,
    'skipped',
  );
  const search = await (
    await fetch('http://127.0.0.1:58025/api/v1/search?query=' + encodeURIComponent(tag))
  ).json();
  assert.equal(search.messages.length, 2);
  const evidence = [];
  for (const m of search.messages) {
    const full = await (await fetch(`http://127.0.0.1:58025/api/v1/message/${m.ID}`)).json();
    assert.equal(full.Attachments.length, 1);
    assert.equal(full.Attachments[0].ContentType, 'application/pdf');
    const pdf = new Uint8Array(
      await (
        await fetch(
          `http://127.0.0.1:58025/api/v1/message/${m.ID}/part/${full.Attachments[0].PartID}`,
        )
      ).arrayBuffer(),
    );
    const reportId = full.To[0].Address.startsWith('manual-') ? manualId : automaticId;
    const savedPdf = await runtime.service.download(reportId, actor);
    assert.deepEqual(pdf, savedPdf.bytes);
    evidence.push({
      recipient: full.To[0].Address,
      subject: full.Subject,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      bytes: pdf.length,
    });
  }
  await page.select('select[aria-label="Delivery artist"]', artists[1].id);
  await page.waitForSelector(`[data-testid="delivery-${automatic[0].id}"]`);
  await page.screenshot({ path: '.local/evidence/delivery-automatic.png', fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    '.local/evidence/delivery-browser.json',
    JSON.stringify(
      {
        passed: true,
        mode: 'local',
        smtpMessages: evidence,
        checked: [
          'manual UI send',
          'recipient persistence',
          'reload history',
          'deduplication',
          'Taipei 10:00 boundary',
          'automatic approved PDF',
          'unapproved skipped',
          'exact attachment bytes',
        ],
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('Delivery browser + real local SMTP passed: 2 PDF attachments, exact saved bytes.');
} catch (error) {
  if (browser) {
    const page = (await browser.pages()).at(-1);
    await mkdir('.local/evidence', { recursive: true });
    await page.screenshot({ path: '.local/evidence/delivery-failure.png', fullPage: true });
    console.log(await page.$eval('body', (el) => el.innerText));
  }
  throw error;
} finally {
  await browser?.close();
  try {
    process.kill(-web.pid, 'SIGTERM');
  } catch {
    /* stopped */
  }
  await new Promise((r) => server.close(r));
  const artistIds = artists.map((a) => a.id);
  const ids = (
    await db.artistMonthlyReport.findMany({
      where: { artistId: { in: artistIds } },
      select: { id: true },
    })
  ).map((r) => r.id);
  await db.monthlyReportDelivery.deleteMany({ where: { artistId: { in: artistIds } } });
  await db.artistDeliveryProfile.deleteMany({ where: { artistId: { in: artistIds } } });
  await db.monthlyDeliveryBatch.deleteMany({ where: { month: '2091-02' } });
  await db.monthlyReportApprovalEvent.deleteMany({ where: { reportId: { in: ids } } });
  await db.monthlyReportApproval.deleteMany({ where: { reportId: { in: ids } } });
  await db.reportArtifact.deleteMany({ where: { reportId: { in: ids } } });
  await db.settlementInputSnapshot.deleteMany({ where: { reportId: { in: ids } } });
  await db.reportGenerationTask.deleteMany({ where: { artistId: { in: artistIds } } });
  await db.artistMonthlyReport.deleteMany({ where: { artistId: { in: artistIds } } });
  await db.artist.deleteMany({ where: { id: { in: artistIds } } });
  await db.$disconnect();
  await rm(storagePath, { recursive: true, force: true });
}
