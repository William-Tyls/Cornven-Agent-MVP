// Complete the one unattempted call after a local recorder error, never retry a model call.
import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AssistantInterpretationSchema, type AssistantInterpretation } from '@cornven/contracts';
import { OpenAiAssistantModel } from '../assistant/assistant-model.js';
import { AssistantService } from '../assistant/assistant.service.js';
import { CachedSemanticProvider } from './embedding-cache.js';
import { DocumentsService } from './documents.service.js';
import { ModelCallBudget } from './live-evaluation.js';
if (!process.argv.includes('--allow-external')) throw new Error('Explicit consent required');
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const base = resolve(root, '.local/evidence/rag-live-regression-html-v1.json');
const previous = JSON.parse(await readFile(base, 'utf8'));
if (previous.total !== 79 || previous.calls !== 3 || previous.traces.length !== 3)
  throw new Error('Unexpected prior ledger; stop');
const output = resolve(root, '.local/evidence/rag-live-regression-html-completed.json');
await writeFile(
  output,
  JSON.stringify({ status: 'started', previous: 79, maximumRemainingCalls: 1 }),
  { flag: 'wx', mode: 0o600 },
);
loadEnvFile(resolve(root, '.env'));
const extraTraces: unknown[] = [];
const budget = new ModelCallBudget(1, async (input, init) => {
  await writeFile(
    output + '.ledger.json',
    JSON.stringify({ previous: 79, attempts: budget.calls, total: 79 + budget.calls }),
    { mode: 0o600 },
  );
  const response = await fetch(input, init);
  extraTraces.push(await response.clone().json());
  return response;
});
const model = new OpenAiAssistantModel(process.env, budget.fetch);
const documents = new DocumentsService({
  environment: {},
  embeddingProvider: await CachedSemanticProvider.create(false),
  snapshotDirectory: resolve(root, '.local/rag-semantic-v1/index'),
});
const rows = [...previous.rows];
const forbidden = async () => {
  throw new Error('No additional generation or business calls authorized');
};
async function record(id: string, question: string, interpretation: AssistantInterpretation) {
  const retrieved =
    interpretation.intent === 'documents.search'
      ? await documents.search(
          { query: interpretation.slots.knowledgeQuery ?? question, limit: 5 },
          { permissionTags: ['staff'], originalQuestion: question },
        )
      : undefined;
  const response =
    retrieved && !retrieved.evidenceSufficient
      ? await new AssistantService({
          configured: true,
          classify: async () => interpretation,
          answerKnowledge: forbidden,
        }).answer({ message: question }, 'recorded-' + id, {
          resolveArtists: forbidden,
          preview: forbidden,
          getReport: forbidden,
          searchSales: forbidden,
          searchDocuments: async () => retrieved,
        })
      : undefined;
  rows.push({
    id,
    question,
    interpretation,
    retrieved,
    response,
    scope: response
      ? 'real classification and retrieval; zero-generation finalization'
      : 'classification and retrieval only; answer generation not rerun',
    passed: interpretation.intent === 'documents.search',
    humanReview: 'pending',
  });
}
try {
  const text = previous.traces[2].output
    .filter((x: { type: string }) => x.type === 'message')
    .flatMap((x: { content: { type: string; text?: string }[] }) => x.content)
    .filter((x: { type: string }) => x.type === 'output_text')
    .map((x: { text: string }) => x.text)
    .join('');
  await record(
    'insufficient-3',
    '改价申请最快几分钟可以批复？',
    AssistantInterpretationSchema.parse(JSON.parse(text)),
  );
  const question = '创作者Google Drive容量上限是多少GB？';
  await record(
    'insufficient-4',
    question,
    await model.classify({ message: question }, '2026-09-24'),
  );
} finally {
  await writeFile(
    output,
    JSON.stringify(
      {
        previous: 76,
        regressionCalls: 3 + budget.calls,
        total: 79 + budget.calls,
        maximum: 80,
        fullTwentyCaseRerun: false,
        initialRecorderFailure:
          'nullable keyword caused local recorder error after 79 total calls; saved classification reused without retry; original report retained',
        rows,
        traces: [...previous.traces, ...extraTraces],
        humanReview: 'pending',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      calls: budget.calls,
      total: 79 + budget.calls,
      rows: rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        passed: r.passed,
        outcome: r.response?.outcome,
      })),
      output,
    }),
  );
}
