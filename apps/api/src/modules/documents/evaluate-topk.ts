import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DocumentPermissionTag, DocumentSearchOutput } from '@cornven/contracts';
import { DocumentsService } from './documents.service.js';
import { DocumentsService as LegacyService } from './legacy/documents.service.js';
import { CachedSemanticProvider } from './embedding-cache.js';
import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { contextPolicy, evidenceTokenUpperBound } from './context-policy.js';
import {
  loadQualitySuite,
  QualitySuiteSchema,
  evaluateQuality,
  qualityPass,
} from './evaluate-quality.js';
import { evaluateCompleteness, verifyExpandedFixtures } from './evaluate-completeness.js';
import { RETRIEVAL_PROFILE } from './hybrid-retrieval.js';
import {
  KNOWLEDGE_PROMPT_VERSION,
  KNOWLEDGE_SYSTEM_PROMPT,
} from '../assistant/knowledge-prompt.js';

export const TOP_K_VALUES = [5, 8, 10, 15] as const;
export const topKRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export const topKDirectory = resolve(topKRoot, '.local/evidence/topk-v1');
export interface AnswerCase {
  id: string;
  category: string;
  question: string;
  permissionTags: DocumentPermissionTag[];
  expectedOutcome: string;
  requiredFacts: string[];
  forbiddenClaims: string[];
  evidence: DocumentSearchOutput;
}
export function contextStats(output: DocumentSearchOutput) {
  return {
    passages: output.results.length,
    contentCharacters: output.results.reduce((n, r) => n + r.content.length, 0),
    referenceTokenUpperBound: evidenceTokenUpperBound(buildAssistantEvidenceBundle(output).items),
  };
}
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
}
export function isolatedService(c: AnswerCase) {
  return new DocumentsService({
    environment: {},
    sourceLoader: async () =>
      c.evidence.results.map((r, i) => ({
        sourceId: r.documentId,
        title: r.title,
        sourceVersion: r.documentVersion,
        sourceType: 'notion_docx_export' as const,
        sourceUrl: 'https://example.test/isolated/' + i,
        audience: 'staff_internal' as const,
        contentStatus: 'test-only',
        permissionTags: c.permissionTags,
        markdown: r.content,
        checksum: createHash('sha256').update(r.content).digest('hex'),
      })),
  });
}
export async function experimentInputs() {
  const original = await loadQualitySuite();
  await verifyExpandedFixtures();
  const english = QualitySuiteSchema.parse(
    JSON.parse(await readFile(resolve(topKRoot, 'fixtures/rag/retrieval-english.json'), 'utf8')),
  );
  const data = JSON.parse(
    await readFile(resolve(topKRoot, 'fixtures/rag/answer-quality.json'), 'utf8'),
  ) as { cases: AnswerCase[] };
  const cases = data.cases.map((c) =>
    c.id === 'answer-2'
      ? {
          ...c,
          requiredFacts: [
            ...c.requiredFacts,
            '至少提供 1 張清晰圖片',
            '1:1',
            'Insert image over cell',
          ],
          forbiddenClaims: [...c.forbiddenClaims, '将图片建议中的背景、光线等表述为强制要求'],
        }
      : c,
  );
  const provider = await CachedSemanticProvider.create(false);
  const service = new DocumentsService({
    environment: {},
    embeddingProvider: provider,
    snapshotDirectory: resolve(topKRoot, '.local/rag-semantic-v1/index'),
  });
  const index = await service.getIndex();
  const files = [
    'fixtures/rag/retrieval-quality.json',
    'fixtures/rag/retrieval-english.json',
    'fixtures/rag/source-completeness.json',
    'fixtures/rag/answer-quality.json',
    'apps/api/src/modules/documents/hybrid-retrieval.ts',
    'apps/api/src/modules/documents/context-policy.ts',
    'apps/api/src/modules/documents/documents.service.ts',
    'apps/api/src/modules/assistant/assistant-model.ts',
  ];
  const hashes: Record<string, string> = {};
  for (const file of files)
    hashes[file] = createHash('sha256')
      .update(await readFile(resolve(topKRoot, file)))
      .digest('hex');
  return {
    service,
    cases,
    suite: {
      schemaVersion: 1 as const,
      positive: [...original.positive, ...english.positive],
      negative: [...original.negative, ...english.negative],
    },
    metadata: {
      sourceIdentity: index.identity,
      chunks: index.chunks.length,
      hashes,
      policy: contextPolicy({}),
      ranking: RETRIEVAL_PROFILE,
      embedding: provider.id,
      model: 'gpt-5.4-nano',
      promptVersion: KNOWLEDGE_PROMPT_VERSION,
      promptHash: createHash('sha256').update(KNOWLEDGE_SYSTEM_PROMPT).digest('hex'),
    },
  };
}
export async function evaluateTopK() {
  const { service, cases, suite, metadata } = await experimentInputs();
  // Warm-up excluded from timing. Reuses approved cached query, zero network.
  await service.search(
    { query: suite.positive[0]!.query, limit: 5 },
    { permissionTags: suite.positive[0]!.permissionTags },
  );
  const legacy = await evaluateQuality(new LegacyService({ environment: {} }), suite);
  const arms = [];
  for (const k of TOP_K_VALUES) {
    const timing: number[] = [],
      stats: ReturnType<typeof contextStats>[] = [];
    const measured: Pick<DocumentsService, 'search'> = {
      search: async (input, context) => {
        const start = performance.now();
        const result = await service.search(input, context);
        timing.push(performance.now() - start);
        stats.push(contextStats(result));
        return result;
      },
    };
    const retrieval = await evaluateQuality(measured, suite, k);
    const completeness = await evaluateCompleteness(measured, undefined, k);
    const answerInputs = [];
    for (const c of cases) {
      const synthetic = ['conflict', 'injection'].includes(c.category);
      const retrieved = await (synthetic ? isolatedService(c) : service).search(
        { query: c.question, limit: k },
        { permissionTags: c.permissionTags, originalQuestion: c.question },
      );
      answerInputs.push({ ...c, evidence: undefined, retrieved, stats: contextStats(retrieved) });
    }
    const trilingualPairs = retrieval.rows
      .filter((r) => r.group === 'original')
      .filter((r) =>
        ['original', 'script', 'english'].every((group) =>
          retrieval.rows.some(
            (x) => x.pairId === r.pairId && x.group === group && x.rank > 0 && x.rank <= k,
          ),
        ),
      ).length;
    const gates =
      qualityPass(retrieval, legacy.summary.mrr) &&
      (retrieval.summary.groups.english?.recall ?? 0) >= 0.9 &&
      trilingualPairs >= 29 &&
      completeness.passed;
    const arm = {
      k,
      gates,
      retrieval,
      completeness,
      trilingualPairs,
      contexts: {
        sampleCount: stats.length,
        passages: distribution(stats.map((x) => x.passages)),
        characters: distribution(stats.map((x) => x.contentCharacters)),
        tokenUpperBound: distribution(stats.map((x) => x.referenceTokenUpperBound)),
        warmRetrievalMs: distribution(timing),
      },
      answerInputs,
    };
    arms.push(arm);
    console.log(
      JSON.stringify({
        k,
        recall: retrieval.summary.recall,
        completeness: completeness.passedCount,
        gates,
      }),
    );
  }
  const eligible = arms
    .filter((a) => a.gates)
    .sort(
      (a, b) =>
        b.completeness.passedCount - a.completeness.passedCount ||
        b.retrieval.summary.recall - a.retrieval.summary.recall ||
        a.k - b.k,
    );
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    metadata,
    arms,
    legacySummary: legacy.summary,
    offlineCandidate: eligible[0]?.k ?? null,
    baselinePassed: arms[0]!.gates,
    finalSelection: null,
    humanReview: 'pending',
    generation: 'not_run',
    note: 'Offline candidate is not a proven answer-quality winner. Additional passages lack exhaustive relevance labels and are not a measured noise rate.',
  };
}
export type TopKReport = Awaited<ReturnType<typeof evaluateTopK>>;
export function topKMarkdown(report: TopKReport) {
  return (
    `# Top-k 离线对比\n\n相同来源/embedding/排序/prompt；仅改变k。原始题集未改。token列为references JSON UTF-8保守上界，不是账单tokens；耗时不含LLM/联网embedding。\n\n| k | 章节命中 /128 | MRR | 完整性 /25 | 反例误召回 /32 | 平均段数 | 平均token上界 | 热检索p95 ms |\n|---|---|---|---|---|---|---|---|\n` +
    report.arms
      .map(
        (a) =>
          `| ${a.k} | ${Math.round(a.retrieval.summary.recall * 128)} | ${a.retrieval.summary.mrr.toFixed(4)} | ${a.completeness.passedCount} | ${a.retrieval.summary.falsePositives} | ${a.contexts.passages.mean.toFixed(1)} | ${a.contexts.tokenUpperBound.mean.toFixed(0)} | ${a.contexts.warmRetrievalMs.p95.toFixed(1)} |`,
      )
      .join('\n') +
    `\n\n离线候选：${report.offlineCandidate ?? '无合格组'}。真实回答和人工事实评分尚未完成；默认k保留5。额外片段未逐条标注相关性，不能据此报告噪声率。\n`
  );
}
