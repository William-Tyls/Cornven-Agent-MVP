import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { OpenAiAssistantModel } from '../assistant/assistant-model.js';
import { ModelCallBudget } from './live-evaluation.js';
import { topKLiveOptions, answerWithSelectedEvidence } from './evaluate-topk-live.js';
import {
  experimentInputs,
  topKRoot,
  topKDirectory,
  TOP_K_VALUES,
  type TopKReport,
} from './evaluate-topk.js';

const options = topKLiveOptions(process.argv.slice(2)); // Guard before loading credentials.
const offline = JSON.parse(
  await readFile(resolve(topKDirectory, 'offline.json'), 'utf8'),
) as TopKReport;
const current = await experimentInputs();
if (
  JSON.stringify(current.metadata) !== JSON.stringify(offline.metadata) ||
  !offline.baselinePassed
)
  throw new Error('Run current offline comparison with a passing baseline first.');
try {
  loadEnvFile(resolve(topKRoot, '.env'));
} catch {
  /* Shell credentials supported. */
}
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('Missing OPENAI_API_KEY.');
await mkdir(topKDirectory, { recursive: true });
const path = resolve(topKDirectory, 'live.json');
await writeFile(path, JSON.stringify({ status: 'started', maximum: options.maximum }), {
  flag: 'wx',
  mode: 0o600,
});
const rows: {
  id: string;
  k: number;
  expectedOutcome: string;
  retrieved: unknown;
  raw: unknown;
  response: unknown;
  outcomeMatches: boolean;
  elapsedMs: number;
  humanReview: string;
}[] = [];
const usage: unknown[] = [];
let transportFailed = false;
const budget = new ModelCallBudget(options.maximum, async (input, init) => {
  await writeFile(
    path + '.ledger.json',
    JSON.stringify({ attempts: budget.calls, maximum: options.maximum, usage }),
    { mode: 0o600 },
  );
  try {
    const response = await fetch(input, init);
    if (!response.ok) transportFailed = true;
    const data = (await response.clone().json()) as { usage?: unknown };
    if (data.usage) usage.push(data.usage);
    return response;
  } catch (error) {
    transportFailed = true;
    throw error;
  }
});
// Exact experiment policy overrides unrelated runtime RAG settings; credentials stay server-only.
const model = new OpenAiAssistantModel(
  {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RAG_CONTEXT_TOKEN_BUDGET: String(offline.metadata.policy.tokenBudget),
  },
  budget.fetch,
);
let status = 'running';
const save = async () => {
  await writeFile(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        status,
        metadata: offline.metadata,
        maximum: budget.limit,
        calls: budget.calls,
        usage,
        rows,
        humanReview: 'pending; matching outcomes are not factual-quality scores',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    path + '.ledger.json',
    JSON.stringify({ attempts: budget.calls, maximum: options.maximum, usage }),
    { mode: 0o600 },
  );
};
try {
  for (let i = 0; i < current.cases.length; i++) {
    const c = current.cases[i]!;
    const order = [...TOP_K_VALUES.slice(i % 4), ...TOP_K_VALUES.slice(0, i % 4)];
    for (const k of order) {
      const data = offline.arms.find((a) => a.k === k)!.answerInputs.find((a) => a.id === c.id)!;
      const start = performance.now();
      const result = await answerWithSelectedEvidence(c.question, data.retrieved, model);
      rows.push({
        id: c.id,
        k,
        expectedOutcome: c.expectedOutcome,
        retrieved: data.retrieved,
        raw: result.raw ?? null,
        response: result.response,
        outcomeMatches: result.response.outcome === c.expectedOutcome,
        elapsedMs: performance.now() - start,
        humanReview: 'pending',
      });
      await save();
      console.log(
        JSON.stringify({ id: c.id, k, outcome: result.response.outcome, calls: budget.calls }),
      );
      if (transportFailed)
        throw new Error(
          'External provider failed; no retry. Inspect the private report before continuing.',
        );
    }
  }
  status = 'completed';
} catch (error) {
  status = 'stopped';
  throw error;
} finally {
  await save();
  const parts = [
    '# Top-k 回答人工评分表',
    '',
    '逐题核对实际证据与回答；outcome相同不代表事实正确。填写事实/必要条件/直接性/引用支持及严重错误；至少18/20通过、严重错误0。未覆盖所有来源事实的gold不等于无关证据。',
    '',
  ];
  for (const c of current.cases) {
    parts.push(
      `## ${c.id}：${c.question}`,
      '',
      `必要事实：${c.requiredFacts.join('；')}`,
      `禁止推论：${c.forbiddenClaims.join('；')}`,
      '',
    );
    for (const k of TOP_K_VALUES) {
      const row = rows.find((r) => r.id === c.id && r.k === k);
      parts.push(
        `### k=${k}`,
        '',
        row ? '```json\n' + JSON.stringify(row, null, 2) + '\n```' : '尚未执行',
        '',
        '评分者：____；事实正确：____；条件完整：____；引用支持：____；严重错误：____；整体通过：____',
        '',
      );
    }
  }
  await writeFile(resolve(topKDirectory, 'answer-review.md'), parts.join('\n'), { mode: 0o600 });
  await writeFile(
    resolve(topKDirectory, 'scores.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        status: 'pending',
        rows: rows.map((r) => ({
          id: r.id,
          k: r.k,
          reviewer: null,
          passed: null,
          severeError: null,
          notes: '',
        })),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status,
      calls: budget.calls,
      rows: rows.length,
      output: path,
      humanReview: 'pending',
    }),
  );
}
