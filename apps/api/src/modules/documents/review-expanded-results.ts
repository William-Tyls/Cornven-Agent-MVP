// Offline replay and review preparation; never calls external models.
import { readFile, writeFile } from 'node:fs/promises';
import { AssistantService, type AssistantTools } from '../assistant/assistant.service.js';
import type { AssistantAnswer, DocumentSearchOutput } from '@cornven/contracts';
import type { KnowledgeAnswer } from '../assistant/assistant-model.js';
interface Row {
  id: string;
  profile: string;
  question: string;
  expectedOutcome: string;
  requiredFacts: string[];
  forbiddenClaims: string[];
  retrieved: DocumentSearchOutput;
  response: KnowledgeAnswer & Partial<AssistantAnswer>;
  error?: string;
}
interface Run {
  calls: number;
  sourceIdentity: string;
  usage: { input_tokens?: number; output_tokens?: number }[];
  rows: Row[];
}
const root = new URL('../../../../../.local/evidence/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8')) as Run;
const fixed = await read('rag-live-fixed-evidence-html-v1.json');
const e2e = await read('rag-live-end-to-end-html-v1.json');
const forbidden = async () => {
  throw new Error('No external or business calls during replay');
};
const finalized: (Row & {
  finalized: AssistantAnswer;
  actualEvidence: DocumentSearchOutput;
  expectedOutcomeMatches: boolean;
})[] = [];
for (const row of fixed.rows) {
  const tools: AssistantTools = {
    resolveArtists: forbidden,
    searchSales: forbidden,
    preview: forbidden,
    getReport: forbidden,
    searchDocuments: async () => row.retrieved,
  };
  const answer = await new AssistantService({
    configured: true,
    classify: async () => ({
      intent: 'documents.search',
      slots: {
        artistQuery: null,
        settlementMonth: null,
        knowledgeQuery: row.question,
        metric: null,
      },
      clarification: null,
    }),
    answerKnowledge: async () => row.response,
  }).answer({ message: row.question }, 'offline-' + row.id, tools);
  finalized.push({
    ...row,
    finalized: answer,
    actualEvidence: row.retrieved,
    expectedOutcomeMatches: answer.outcome === row.expectedOutcome,
  });
}
const actualEndToEnd = e2e.rows.map((row) => {
  const retrievalAttempted =
    row.response?.toolCalls?.some((call) => call.tool === 'documents.search') ?? false;
  // Original recorder initialized its evidence field from the gold bundle even if routing refused.
  // Do not misrepresent this fixture fallback as evidence retrieved by the runtime.
  return {
    ...row,
    actualEvidence: retrievalAttempted
      ? row.retrieved
      : { query: row.question, evidenceSufficient: false, results: [] },
    retrievalAttempted,
    expectedOutcomeMatches: row.response?.outcome === row.expectedOutcome,
  };
});
const matches = (rows: { expectedOutcomeMatches: boolean }[]) =>
  rows.filter((r) => r.expectedOutcomeMatches).length;
const regression = JSON.parse(
  await readFile(new URL('rag-live-regression-html-completed.json', root), 'utf8'),
) as {
  regressionCalls: number;
  total: number;
  rows: {
    id: string;
    question: string;
    scope: string;
    passed: boolean;
    response?: AssistantAnswer;
    retrieved?: DocumentSearchOutput;
  }[];
  traces: { usage?: { input_tokens?: number; output_tokens?: number } }[];
};
const regressionUsage = regression.traces.map((t) => t.usage ?? {});
const summary = {
  calls: fixed.calls + e2e.calls + regression.regressionCalls,
  regressionCalls: regression.regressionCalls,
  regressionRows: regression.rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    passed: r.passed,
    outcome: r.response?.outcome,
  })),
  compositeOutcomeMatches: actualEndToEnd.filter(
    (r) =>
      (regression.rows.find((p) => p.id === r.id)?.response?.outcome ?? r.response?.outcome) ===
      r.expectedOutcome,
  ).length,
  compositeIsNotFullRerun: true,
  fixedCalls: fixed.calls,
  endToEndCalls: e2e.calls,
  remainingBudget: 80 - fixed.calls - e2e.calls - regression.regressionCalls,
  sourceIdentity: e2e.sourceIdentity,
  inputTokens: [...fixed.usage, ...e2e.usage, ...regressionUsage].reduce(
    (n, u) => n + (u.input_tokens ?? 0),
    0,
  ),
  outputTokens: [...fixed.usage, ...e2e.usage, ...regressionUsage].reduce(
    (n, u) => n + (u.output_tokens ?? 0),
    0,
  ),
  fixedOutcomeMatches: Object.fromEntries(
    ['legacy', 'enhanced'].map((profile) => [
      profile,
      matches(finalized.filter((r) => r.profile === profile)),
    ]),
  ),
  endToEndOutcomeMatches: matches(actualEndToEnd),
  endToEndFailures: actualEndToEnd
    .filter((r) => !r.expectedOutcomeMatches)
    .map((r) => ({ id: r.id, outcome: r.response?.outcome })),
  humanFactReview: 'pending; outcome matching is not factual correctness',
  replayModelCalls: 0,
};
const groups = [...new Set(fixed.rows.map((r) => r.id))].map((id) => ({
  id,
  question: fixed.rows.find((r) => r.id === id)!.question,
  variants: [
    ...finalized.filter((r) => r.id === id).map((row) => ({ label: row.profile, ...row })),
    ...actualEndToEnd
      .filter((r) => r.id === id)
      .map((row) => ({ label: 'end-to-end', ...row, finalized: row.response })),
  ].map((row) => ({
    ...row,
    scores: {
      evidenceComplete: null,
      answerCorrect: null,
      conditionsPreserved: null,
      citationsSupported: null,
      directness: null,
      language: null,
      criticalFailure: null,
      reviewer: null,
      notes: '',
    },
  })),
}));
await writeFile(
  new URL('rag-answer-review-html-v1.json', root),
  JSON.stringify({ summary, groups, regression }, null, 2) + '\n',
  { mode: 0o600 },
);
const lines = [
  '# 本轮 RAG 回答核对表（展开 HTML + 真实语义检索）',
  '',
  '状态：待人工评分，尚未发布。20 个问题分组，每组对比固定证据旧/新 prompt 与真实端到端回答。',
  `本轮模型调用 ${summary.calls}/80：固定证据 ${fixed.calls}、端到端 ${e2e.calls}、定向修复 ${regression.regressionCalls}。本表生成与生产校验回放调用 0 次。`,
  '',
  `自动 outcome 匹配：固定旧 ${summary.fixedOutcomeMatches.legacy}/20、固定新 ${summary.fixedOutcomeMatches.enhanced}/20、端到端 ${summary.endToEndOutcomeMatches}/20。这不是答案正确性评分。`,
  '',
  '评分依据：原文必需依据是否齐全，以及答案事实、条件、建议/必须、引用支持、直接性、语言是否正确。每项填通过/不通过/不适用；严重错误单独标注。门槛为至少18/20通过、严重错误为0、新prompt不劣于旧prompt。',
  '原冻结题目与历史报告未改写；answer-2 本轮固定证据补入上传章节及其必要事实。没有调用检索工具的端到端轮次显示“未检索”，不会把固定证据冒充实际召回。',
  '',
];
for (const group of groups) {
  lines.push(`## ${group.id}：${group.question}`, '');
  for (const row of group.variants) {
    lines.push(
      `### ${row.label}`,
      '',
      `预期 outcome：${row.expectedOutcome}；实际：${row.finalized.outcome ?? 'error'}`,
      '',
      '必需事实：' + row.requiredFacts.join('；'),
      '',
      '禁止声称：' + (row.forbiddenClaims.join('；') || '无额外条目'),
      '',
      '**返回答案（生产校验后）**',
      '',
      row.finalized.answer ?? '没有有效答案',
      '',
      '**本轮实际证据**',
      '',
    );
    if (!row.actualEvidence.results.length) lines.push('未检索到资料，或此轮未执行检索。', '');
    for (const [i, item] of row.actualEvidence.results.entries())
      lines.push(`${i + 1}. ${item.locator}`, '', '```text', item.content, '```', '');
    lines.push(
      '评分：证据完整性 [ ]；答案正确性 [ ]；条件/建议强度 [ ]；引用支持 [ ]；直接性 [ ]；语言 [ ]；严重错误 [ ]',
      '复核人及备注：',
      '',
    );
  }
}
lines.push(
  '## 定向修复复测（最新补充，非全量重跑）',
  '',
  '本节使用剩余4次请求；修复后组合outcome为20/20，但只有3项做了定向验证，不能称为全新20题通过。旧/新固定prompt对比仍是v2，最新引用schema与v3提示仅对本节有真实验证。人工事实评分仍待完成。',
  '',
);
for (const row of regression.rows) {
  lines.push(
    `### ${row.id}：${row.question}`,
    '',
    `验证范围：${row.scope}；outcome：${row.response?.outcome ?? 'not_generated'}`,
    '',
    row.response?.answer ?? '未生成新回答',
    '',
  );
  for (const citation of row.response?.citations ?? [])
    lines.push(`来源：${citation.locator}`, '', citation.excerpt, '');
  lines.push('人工核对：事实 [ ]；条件/建议强度 [ ]；引用支持 [ ]；备注：', '');
}
lines.push(
  '复核提醒：answer-2初轮端到端将“圖片建議”列在总体“要求”中，需检查是否混淆建议与必要条件；v3已强调继承标题中的建议强度，但本轮预算内没有对该题重新生成。',
  '',
);
await writeFile(new URL('rag-answer-review-html-v1.md', root), lines.join('\n'), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
