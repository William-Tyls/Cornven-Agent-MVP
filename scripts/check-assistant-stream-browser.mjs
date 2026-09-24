// Real browser + HTTP streaming + local SOP retrieval. Injected model, no paid API or emails.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.env.LOCAL_DEVELOPMENT_IDENTITY = 'true';
process.env.RAG_STORAGE_BACKEND = 'memory';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));
const { createApp } = await import('../apps/api/dist/app.js');
const calls = [];
let release;
let aborted = 0;
const model = {
  configured: true,
  async classify(input) {
    calls.push(input);
    return {
      intent: 'documents.search',
      slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: '商品標籤' },
      clarification: null,
    };
  },
  async answerKnowledge(question, evidence, options) {
    const answer = evidence.items[0].verbatimContent.slice(0, 80) + ' [1]';
    options.onTextDelta(answer.slice(0, 10));
    await new Promise((resolve, reject) => {
      const cancel = () => {
        aborted++;
        reject(options.signal.reason);
      };
      options.signal.addEventListener('abort', cancel, { once: true });
      release = () => {
        options.signal.removeEventListener('abort', cancel);
        resolve();
      };
    });
    options.onTextDelta(answer.slice(10));
    return {
      answer,
      evidenceSufficient: !question.includes('依据不足'),
      citationIds: [question.includes('失效') ? 'invented' : evidence.items[0].citation.chunkId],
    };
  },
};
const runtime = {
  repository: { db: {} },
  resolveActor: () => ({ id: 'stream-browser', artistIds: '*' }),
};
const server = createApp(runtime, model).listen(0, '127.0.0.1');
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
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch('http://127.0.0.1:5202')).ok) break;
    } catch {
      /* Startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1080 });
  await page.goto('http://127.0.0.1:5202/assistant', { waitUntil: 'networkidle0' });
  async function button(label) {
    await page.evaluate((text) => {
      const el = [...document.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === text,
      );
      if (!el || el.disabled) throw new Error(`Button unavailable: ${text}`);
      el.click();
    }, label);
  }
  async function ask(text) {
    await page.type('#chat-question', text);
    await page.click('button[type="submit"]');
    await page.waitForFunction(
      () => document.querySelector('[aria-busy="true"] .chat-answer-text')?.textContent.length > 0,
    );
    assert.equal(
      await page.$('[aria-busy="true"] .badge--success'),
      null,
      'must not claim success before final',
    );
  }
  await ask('商品標籤需要哪些資訊？');
  await mkdir('.local/evidence', { recursive: true });
  await page.screenshot({ path: '.local/evidence/assistant-stream-pending.png' });
  release();
  await page.waitForSelector('.badge--success');
  assert.ok(await page.$('.chat-bubble__details li'), 'validated sources visible');
  assert.equal(await page.$('[aria-busy="true"]'), null);
  await page.screenshot({ path: '.local/evidence/assistant-stream-final.png' });
  await ask('再说一次标签规则');
  await button('停止生成');
  await page.waitForFunction(() => !document.querySelector('#chat-question').disabled);
  assert.equal(await page.$('[aria-busy="true"]'), null);
  await ask('重新开始标签问题');
  assert.equal(calls.at(-1).history.length, 2, 'cancelled turn excluded from history');
  assert.ok(!JSON.stringify(calls.at(-1).history).includes('再说一次'));
  await button('New conversation');
  await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length === 0);
  await ask('失效引用标签问题');
  assert.equal(calls.at(-1).history.length, 0);
  release();
  await page.waitForSelector('.badge--danger');
  assert.equal(await page.$('.chat-bubble__details li'), null);
  assert.equal(await page.$('[aria-busy="true"]'), null);
  assert.ok(!(await page.$eval('.chat-answer-text', (el) => el.textContent)).includes('[1]'));
  await ask('依据不足标签问题');
  assert.equal(calls.at(-1).history.length, 0, 'failed citation turn excluded from history');
  release();
  await page.waitForSelector('.badge--neutral');
  assert.ok(
    !(await page.$eval('.chat-answer-text:last-of-type', (el) => el.textContent)).includes('[1]'),
  );
  await button('New conversation');
  await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length === 0);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/assistant/stream'))
      void request.respond({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
        body: 'event: text_delta\ndata: {"type":"text_delta","delta":"断流草稿"}\n\n',
      });
    else void request.continue();
  });
  await page.type('#chat-question', '模拟断流');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () =>
      !document.querySelector('#chat-question').disabled &&
      document.body.textContent.includes('未完成'),
  );
  assert.equal(await page.$('[aria-busy="true"]'), null);
  assert.equal(await page.$('.chat-bubble'), null, 'broken stream cannot become history');
  assert.ok(!(await page.$eval('body', (el) => el.textContent)).includes('断流草稿'));
  assert.equal(aborted, 2);
  assert.deepEqual(errors, []);
  const summary = {
    streamingBeforeFinal: true,
    validatedSources: true,
    stopAndNewConversationAbort: aborted,
    cancelledHistoryExcluded: true,
    invalidCitationDraftRetracted: true,
    insufficientEvidenceDraftRetracted: true,
    truncatedStreamDraftRetracted: true,
    failedFinalHistoryExcluded: true,
    browserErrors: errors,
  };
  await writeFile(
    '.local/evidence/assistant-stream-browser.json',
    JSON.stringify(summary, null, 2) + '\n',
  );
  console.log(JSON.stringify(summary));
} finally {
  await browser?.close();
  try {
    process.kill(-web.pid, 'SIGTERM');
  } catch {
    /* Already stopped */
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
