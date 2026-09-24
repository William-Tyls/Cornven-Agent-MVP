import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { OpenAiAssistantModel } from '../assistant/assistant-model.js';
import { AssistantService, type AssistantTools } from '../assistant/assistant.service.js';
import {
  KNOWLEDGE_PROMPT_VERSION,
  KNOWLEDGE_SYSTEM_PROMPT,
} from '../assistant/knowledge-prompt.js';
import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { DocumentsService } from './documents.service.js';
import { CachedSemanticProvider } from './embedding-cache.js';
import { extractVerbatimExcerpt } from './excerpt.js';
import { liveOptions, ModelCallBudget } from './live-evaluation.js';
import { loadQualitySuite } from './evaluate-quality.js';
import type { DocumentSearchOutput, DocumentPermissionTag } from '@cornven/contracts';
const options = liveOptions(process.argv.slice(2)); // Reject before reading credentials or constructing models.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
await loadQualitySuite(); // Includes frozen answer fixture verification.
if (resolve(root, options.suite) !== resolve(root, 'fixtures/rag/answer-quality.json'))
  throw new Error('Only the reviewed frozen answer suite is accepted.');
try {
  loadEnvFile(resolve(root, '.env'));
} catch {
  /* shell-provided key is also supported */
}
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is not configured.');
const expanded = process.argv.includes('--expanded-html');
const dryRun = process.argv.includes('--dry-run');
const runTag = expanded
  ? '-html-v1'
  : process.argv.includes('--case-id')
    ? '-conflict-regression-v3'
    : '';
const runPath = resolve(root, `.local/evidence/rag-live-${options.mode}${runTag}.json`);
const usage: unknown[] = [];
if (expanded) {
  const acceptance = JSON.parse(
    await readFile(resolve(root, '.local/evidence/rag-semantic-acceptance.json'), 'utf8'),
  );
  if (!acceptance.passed) throw new Error('Retrieval acceptance must pass before generation.');
  await mkdir(resolve(root, '.local/evidence'), { recursive: true });
  if (!dryRun)
    await writeFile(runPath, JSON.stringify({ status: 'started', maximum: options.maxCalls }), {
      flag: 'wx',
      mode: 0o600,
    });
}
const budget = new ModelCallBudget(options.maxCalls, async (input, init) => {
  if (expanded)
    await writeFile(
      runPath + '.ledger.json',
      JSON.stringify({ attempts: budget.calls, maximum: options.maxCalls, usage }),
      { mode: 0o600 },
    );
  const response = await fetch(input, init);
  try {
    const body = (await response.clone().json()) as { usage?: unknown };
    if (body.usage) usage.push(body.usage);
  } catch {
    /* An upstream error may not be JSON; it is still counted. */
  }
  return response;
});
const legacy = await readFile(resolve(root, 'fixtures/rag/knowledge-prompt-legacy.txt'), 'utf8');
const data = JSON.parse(await readFile(resolve(root, options.suite), 'utf8')) as {
  cases: {
    id: string;
    question: string;
    category: string;
    permissionTags: DocumentPermissionTag[];
    expectedOutcome: string;
    requiredFacts: string[];
    forbiddenClaims: string[];
    evidence: DocumentSearchOutput;
  }[];
};
const rows: unknown[] = [];
const requestedIds = process.argv.flatMap((arg, i) =>
  arg === '--case-id' ? [process.argv[i + 1]!] : [],
);
if (requestedIds.some((id) => !data.cases.some((c) => c.id === id)))
  throw new Error('Unknown reviewed case ID');
const cases = requestedIds.length
  ? data.cases.filter((c) => requestedIds.includes(c.id))
  : data.cases;

console.log(
  JSON.stringify({
    mode: options.mode,
    model: 'gpt-5.4-nano',
    maxCalls: options.maxCalls,
    caseCount: cases.length,
    scope: 'Questions and at most 5 SOP passages per answer; no transaction data',
    promptVersion: KNOWLEDGE_PROMPT_VERSION,
  }),
);
const normal = new DocumentsService({
  environment: {},
  ...(expanded
    ? {
        embeddingProvider: await CachedSemanticProvider.create(false),
        snapshotDirectory: resolve(root, '.local/rag-semantic-v1/index'),
      }
    : {}),
});
const index = expanded ? await normal.getIndex() : undefined;
if (expanded)
  for (const c of cases) {
    if (['conflict', 'injection'].includes(c.category)) continue;
    const selected = c.evidence.results.flatMap((target) => {
      const path = target.locator.split(' > ');
      const candidates = index!.chunks
        .map((c) => c.chunk)
        .filter(
          (chunk) =>
            chunk.documentId === target.documentId && chunk.headingPath.at(-1) === path.at(-1),
        );
      const shared = (heading: string[]) => heading.filter((h) => path.includes(h)).length;
      const best = Math.max(...candidates.map((c) => shared(c.headingPath)));
      return candidates.filter((c) => shared(c.headingPath) === best);
    });
    if (c.id === 'answer-2') {
      const upload = index!.chunks
        .map((c) => c.chunk)
        .find((c) => c.headingPath.at(-1) === '六、產品圖片（上傳）')!;
      selected.push(upload);
      c.requiredFacts = [
        ...c.requiredFacts,
        '至少提供 1 張清晰圖片',
        '1:1',
        'Insert image over cell',
      ];
    }
    if (!selected.length || selected.length > 5)
      throw new Error('Review fixed evidence mapping: ' + c.id);
    c.evidence = {
      query: c.question,
      evidenceSufficient: true,
      results: selected.map((chunk) => ({
        documentId: chunk.documentId,
        documentVersion: chunk.documentVersion,
        chunkId: chunk.chunkId,
        title: chunk.title,
        locator: chunk.locator,
        content: chunk.content,
        excerpt: extractVerbatimExcerpt(chunk.content, c.question),
      })),
    };
  }
if (expanded)
  await writeFile(
    runPath + '.inputs.json',
    JSON.stringify(
      {
        sourceIdentity: index!.identity,
        note: 'Same frozen questions; current source counterparts for fixed evidence. answer-2 explicitly includes both complementary chapters and supplemental required facts.',
        cases,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
if (dryRun) {
  console.log(
    JSON.stringify({
      dryRun: true,
      cases: cases.length,
      evidenceCounts: cases.map((c) => ({ id: c.id, count: c.evidence.results.length })),
      sourceIdentity: index?.identity,
    }),
  );
  process.exit(0);
}
try {
  evaluation: for (const c of cases)
    for (const profile of options.mode === 'fixed-evidence'
      ? ['legacy', 'enhanced']
      : ['enhanced']) {
      if (budget.calls >= budget.limit) throw new Error('MODEL_CALL_BUDGET_EXHAUSTED');
      const model = new OpenAiAssistantModel(
        process.env,
        budget.fetch,
        profile === 'legacy' ? legacy : KNOWLEDGE_SYSTEM_PROMPT,
      );
      const started = performance.now();
      let retrieved: DocumentSearchOutput =
        options.mode === 'fixed-evidence'
          ? c.evidence
          : { query: c.question, evidenceSufficient: false, results: [] };
      let retrievalCompleted = options.mode === 'fixed-evidence';
      try {
        let response: unknown;
        if (options.mode === 'fixed-evidence')
          response = await model.answerKnowledge(
            c.question,
            buildAssistantEvidenceBundle(c.evidence),
          );
        else {
          const synthetic = ['conflict', 'injection'].includes(c.category);
          const service = synthetic
            ? new DocumentsService({
                environment: {},
                sourceLoader: async () =>
                  c.evidence.results.map((result, i) => {
                    const markdown = result.content;
                    return {
                      sourceId: result.documentId,
                      title: result.title,
                      sourceType: 'notion_docx_export' as const,
                      sourceUrl: 'https://example.test/isolated/' + i,
                      sourceVersion: result.documentVersion,
                      contentStatus: 'test-only',
                      audience: 'staff_internal' as const,
                      permissionTags: c.permissionTags,
                      checksum: createHash('sha256').update(markdown).digest('hex'),
                      markdown,
                    };
                  }),
              })
            : normal;
          const forbidden = async () => {
            throw new Error('Business data unavailable in SOP evaluation');
          };
          const tools: AssistantTools = {
            resolveArtists: forbidden,
            searchSales: forbidden,
            preview: forbidden,
            getReport: forbidden,
            searchDocuments: async (query, searchOptions) => {
              retrieved = await service.search(
                { query, limit: 5 },
                { permissionTags: c.permissionTags, ...searchOptions },
              );
              retrievalCompleted = true;
              return retrieved;
            },
          };
          response = await new AssistantService(model).answer(
            { message: c.question },
            'rag-eval-' + c.id,
            tools,
          );
        }
        rows.push({
          id: c.id,
          category: c.category,
          profile,
          expectedOutcome: c.expectedOutcome,
          requiredFacts: c.requiredFacts,
          forbiddenClaims: c.forbiddenClaims,
          question: c.question,
          retrieved,
          retrievalCompleted,
          response,
          elapsedMs: performance.now() - started,
          humanReview: 'pending',
        });
      } catch {
        rows.push({
          id: c.id,
          profile,
          error: 'EVALUATION_CALL_FAILED',
          elapsedMs: performance.now() - started,
          humanReview: 'pending',
        });
        if (expanded) break evaluation;
      }
    }
} finally {
  const directory = resolve(root, '.local/evidence');
  await mkdir(directory, { recursive: true });
  const path = runPath;
  await writeFile(
    path,
    JSON.stringify(
      {
        mode: options.mode,
        model: 'gpt-5.4-nano',
        promptVersion: KNOWLEDGE_PROMPT_VERSION,
        promptHash: createHash('sha256').update(KNOWLEDGE_SYSTEM_PROMPT).digest('hex'),
        calls: budget.calls,
        usage,
        sourceIdentity: index?.identity,
        maximum: budget.limit,
        humanReview: 'pending; automated execution is not a quality pass',
        rows,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      calls: budget.calls,
      rows: rows.length,
      report: path,
      humanReview: 'pending',
    }),
  );
}
