import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { OpenAiAssistantModel } from '../assistant/assistant-model.js';
import { INTENT_PROMPT_VERSION } from '../assistant/intent-prompt.js';
import { KNOWLEDGE_PROMPT_VERSION } from '../assistant/knowledge-prompt.js';
import { AssistantService, type AssistantTools } from '../assistant/assistant.service.js';
import { CachedSemanticProvider } from './embedding-cache.js';
import { DocumentsService } from './documents.service.js';
import { ModelCallBudget } from './live-evaluation.js';
if (!process.argv.includes('--allow-external'))
  throw new Error('Explicit external permission required');
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const files = ['rag-live-fixed-evidence-html-v1.json', 'rag-live-end-to-end-html-v1.json'];
let previous = 0;
for (const file of files)
  previous += JSON.parse(await readFile(resolve(root, '.local/evidence', file), 'utf8')).calls;
if (previous !== 76)
  throw new Error('Expected exactly 76 prior calls; review the remaining authorization');
loadEnvFile(resolve(root, '.env'));
const path = resolve(root, '.local/evidence/rag-live-regression-html-v1.json');
await writeFile(path, JSON.stringify({ status: 'started', previous, maximum: 4 }), {
  flag: 'wx',
  mode: 0o600,
});
const traces: unknown[] = [];
const budget = new ModelCallBudget(4, async (input, init) => {
  await writeFile(
    path + '.ledger.json',
    JSON.stringify({ previous, attempts: budget.calls, total: previous + budget.calls }),
    { mode: 0o600 },
  );
  const response = await fetch(input, init);
  const raw = await response.clone().json();
  traces.push(raw);
  return response;
});
const model = new OpenAiAssistantModel(process.env, budget.fetch);
const documents = new DocumentsService({
  environment: {},
  embeddingProvider: await CachedSemanticProvider.create(false),
  snapshotDirectory: resolve(root, '.local/rag-semantic-v1/index'),
});
const rows: unknown[] = [];
const forbidden = async () => {
  throw new Error('No business data allowed in SOP regression');
};
const tools: AssistantTools = {
  resolveArtists: forbidden,
  searchSales: forbidden,
  preview: forbidden,
  getReport: forbidden,
  searchDocuments: (query, options) =>
    documents.search({ query, limit: 5 }, { permissionTags: ['staff'], ...options }),
};
try {
  const question = '补货预约时间有什么要求？';
  const response = await new AssistantService(model).answer(
    { message: question },
    'regression-answer-4',
    tools,
  );
  rows.push({
    id: 'answer-4',
    scope: 'end-to-end',
    question,
    response,
    passed: response.outcome === 'answered' && response.citations.length > 0,
    humanReview: 'pending',
  });
  for (const [id, question] of [
    ['insufficient-3', '改价申请最快几分钟可以批复？'],
    ['insufficient-4', '创作者Google Drive容量上限是多少GB？'],
  ]) {
    const interpretation = await model.classify({ message: question! }, '2026-09-24');
    const retrieved =
      interpretation.intent === 'documents.search'
        ? await documents.search(
            { query: interpretation.slots.knowledgeQuery ?? question!, limit: 5 },
            { permissionTags: ['staff'], originalQuestion: question! },
          )
        : undefined;
    // If retrieval is empty, production completes without another answer-model call.
    const noEvidenceResponse =
      retrieved && !retrieved.evidenceSufficient
        ? await new AssistantService({
            configured: true,
            classify: async () => interpretation,
            answerKnowledge: forbidden,
          }).answer({ message: question! }, 'regression-' + id, {
            ...tools,
            searchDocuments: async () => retrieved,
          })
        : undefined;
    rows.push({
      id,
      question,
      scope: noEvidenceResponse
        ? 'real classification and retrieval; deterministic no-evidence finalization'
        : 'classification-and-retrieval only; final answer not re-generated',
      interpretation,
      retrieved,
      response: noEvidenceResponse,
      passed: interpretation.intent === 'documents.search',
      humanReview: 'pending',
    });
  }
} finally {
  await writeFile(
    path,
    JSON.stringify(
      {
        previous,
        calls: budget.calls,
        total: previous + budget.calls,
        maximum: 80,
        intentPrompt: INTENT_PROMPT_VERSION,
        knowledgePrompt: KNOWLEDGE_PROMPT_VERSION,
        fullTwentyCaseRerun: false,
        rows,
        traces,
        humanReview: 'pending',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      previous,
      calls: budget.calls,
      total: previous + budget.calls,
      rows: rows.length,
      path,
      fullTwentyCaseRerun: false,
    }),
  );
}
