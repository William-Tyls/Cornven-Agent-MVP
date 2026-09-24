// Replays recorded model outputs through the production finalization path. ZERO API calls.
import { readFile, writeFile } from 'node:fs/promises';
import { AssistantService, type AssistantTools } from '../assistant/assistant.service.js';
import type { AssistantModel, KnowledgeAnswer } from '../assistant/assistant-model.js';
import type { AssistantAnswer, DocumentSearchOutput } from '@cornven/contracts';
interface Row {
  id: string;
  profile: string;
  question: string;
  expectedOutcome: string;
  requiredFacts: string[];
  forbiddenClaims: string[];
  retrieved: DocumentSearchOutput;
  response?: KnowledgeAnswer & Partial<AssistantAnswer>;
  error?: string;
}
const root = new URL('../../../../../', import.meta.url);
const read = async (name: string) =>
  JSON.parse(await readFile(new URL('.local/evidence/' + name, root), 'utf8')) as {
    calls: number;
    rows: Row[];
  };
const fixed = await read('rag-live-fixed-evidence.json');
const e2e = await read('rag-live-end-to-end.json');
const regression = await read('rag-live-end-to-end-conflict-regression-v3.json');
const forbidden = async () => {
  throw new Error('No external or business call permitted during replay');
};
const finalized: (Row & {
  finalized: AssistantAnswer | undefined;
  expectedOutcomeMatches: boolean;
  rawInsufficientCitationDeviation: boolean;
  humanReview: string;
})[] = [];
for (const row of fixed.rows) {
  let result: AssistantAnswer | undefined;
  if (row.response) {
    const model: AssistantModel = {
      configured: true,
      classify: async () => ({
        intent: 'documents.search',
        slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: row.retrieved.query },
        clarification: null,
      }),
      answerKnowledge: async () => row.response!,
    };
    const tools: AssistantTools = {
      resolveArtists: forbidden,
      searchSales: forbidden,
      preview: forbidden,
      getReport: forbidden,
      searchDocuments: async () => row.retrieved,
    };
    result = await new AssistantService(model).answer(
      { message: row.question },
      'replay-' + row.id,
      tools,
    );
  }
  const rawInsufficientCitationDeviation = Boolean(
    row.response &&
      !row.response.evidenceSufficient &&
      (row.response.citationIds.length || /\[\d+\]/u.test(row.response.answer)),
  );
  finalized.push({
    ...row,
    finalized: result,
    expectedOutcomeMatches: result?.outcome === row.expectedOutcome,
    rawInsufficientCitationDeviation,
    humanReview: 'pending',
  });
}
const latest = e2e.rows.map((row) => regression.rows.find((r) => r.id === row.id) ?? row);
const matches = (rows: Row[]) =>
  rows.filter((r) => r.response?.outcome === r.expectedOutcome).length;
const summary = {
  modelCalls: fixed.calls + e2e.calls + regression.calls,
  fixedFinalizedOutcomeMatches: Object.fromEntries(
    ['legacy', 'enhanced'].map((profile) => [
      profile,
      finalized.filter((r) => r.profile === profile && r.expectedOutcomeMatches).length,
    ]),
  ),
  initialEndToEndOutcomeMatches: matches(e2e.rows),
  postFixCompositeOutcomeMatches: matches(latest),
  postFixCompositeIsNotFullRerun: true,
  rawInsufficientCitationDeviations: finalized
    .filter((r) => r.rawInsufficientCitationDeviation)
    .map((r) => ({ id: r.id, profile: r.profile })),
  humanFactReview: 'pending; outcome and structure checks are not factual quality scores',
};
await writeFile(
  new URL('.local/evidence/rag-live-structure-summary.json', root),
  JSON.stringify(summary, null, 2) + '\n',
);
await writeFile(
  new URL('.local/evidence/rag-live-fixed-finalized.json', root),
  JSON.stringify(
    { calls: 0, source: 'recorded fixed-evidence responses', summary, rows: finalized },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
const lines = [
  '# RAG 回答人工核对表',
  '',
  '状态：待人工评分。模型总调用 ' + summary.modelCalls + '/80；本评分表生成及输出回放不调用模型。',
  '',
  '自动检查仅验证 outcome 和引用结构，不能替代事实、条件、直接性和语言核对。旧/新固定证据使用相同输入；同时列出模型原始输出与经过生产接口校验后的结果，不隐藏不足回答中的引用格式偏差。',
  '',
  '原始端到端按预期 outcome 返回 ' +
    matches(e2e.rows) +
    '/20；修复后的2个冲突用例单独通过。将修复结果替换原2题后为 ' +
    matches(latest) +
    '/20，这是分轮组合统计，不是全量重新跑20题，也不是人工质量通过率。',
  '',
  '已知待核对项：answer-7端到端引用校验失败，安全返回tool_error；answer-3固定证据新版可能遗漏创作者编号组成；answer-1端到端的建议/必要措辞需与依据逐项比较。原conflict-1漏检已修复，原失败记录保留。',
  '',
  '验收要求：至少18/20整体通过，严重事实/权限/引用错误为0，新prompt不劣于同证据旧prompt。请在每题填写通过/失败和原因。',
  '',
];
for (const row of latest) {
  const old = finalized.find((x) => x.id === row.id && x.profile === 'legacy');
  const current = finalized.find((x) => x.id === row.id && x.profile === 'enhanced');
  lines.push(
    '## ' + row.id + '：' + row.question,
    '',
    '预期：' + row.expectedOutcome,
    '',
    '必要事实：' + (row.requiredFacts?.join('；') || '不得补造或猜测主要答案'),
    '',
    '### 旧 prompt（固定证据）',
    '',
    old?.finalized?.answer ?? '执行失败',
    '',
    '### 新 prompt（固定证据）',
    '',
    current?.finalized?.answer ?? '执行失败',
    '',
    '### 新 prompt（端到端）',
    '',
    row.response?.answer ?? '执行失败',
    '',
    '结果：' +
      row.response?.outcome +
      '；原始结果：' +
      e2e.rows.find((x) => x.id === row.id)?.response?.outcome,
    '',
    '### 固定证据原始输出与偏差',
    '',
    '```json',
    JSON.stringify(
      {
        legacy: old?.response,
        enhanced: current?.response,
        legacyInsufficientCitationDeviation: old?.rawInsufficientCitationDeviation,
        enhancedInsufficientCitationDeviation: current?.rawInsufficientCitationDeviation,
      },
      null,
      2,
    ),
    '```',
    '',
    '### 端到端证据',
  );
  for (const [i, evidence] of row.retrieved.results.entries())
    lines.push(
      '',
      String(i + 1) + '. ' + evidence.title + ' / ' + evidence.locator,
      '',
      '```text',
      evidence.content,
      '```',
    );
  lines.push(
    '',
    '- [ ] 已核对事实与必要条件',
    '- [ ] 已核对每条引用支持及权限',
    '- [ ] 已核对必要/建议、否定、金额和日期',
    '- [ ] 已核对直接性与语言',
    '- 旧固定证据评分：待填',
    '- 新固定证据评分：待填',
    '- 端到端评分：待填',
    '- 严重错误：待填',
    '- 审阅人、原因：待填',
    '',
  );
}
await writeFile(new URL('.local/evidence/rag-answer-review.md', root), lines.join('\n'), {
  mode: 0o600,
});
console.log(JSON.stringify(summary, null, 2));
