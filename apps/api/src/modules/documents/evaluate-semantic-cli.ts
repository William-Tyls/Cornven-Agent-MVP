import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CachedSemanticProvider } from './embedding-cache.js';
import { DocumentsService } from './documents.service.js';
import { DocumentsService as LegacyService } from './legacy/documents.service.js';
import { writeIndexSnapshot } from './index-snapshot.js';
import {
  loadQualitySuite,
  QualitySuiteSchema,
  evaluateQuality,
  qualityPass,
} from './evaluate-quality.js';
import { evaluateCompleteness, verifyExpandedFixtures } from './evaluate-completeness.js';
import { RETRIEVAL_PROFILE } from './hybrid-retrieval.js';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
await verifyExpandedFixtures();
const old = await loadQualitySuite();
const english = QualitySuiteSchema.parse(
  JSON.parse(await readFile(resolve(root, 'fixtures/rag/retrieval-english.json'), 'utf8')),
);
const suite = {
  schemaVersion: 1 as const,
  positive: [...old.positive, ...english.positive],
  negative: [...old.negative, ...english.negative],
};
const provider = await CachedSemanticProvider.create(false);
const directory = resolve(root, '.local/rag-semantic-v1/index');
await mkdir(directory, { recursive: true });
const service = new DocumentsService({
  embeddingProvider: provider,
  environment: {},
  snapshotDirectory: directory,
});
const index = await service.buildIndex();
await writeIndexSnapshot(index, directory);
const report = await evaluateQuality(service, suite);
const legacy = await evaluateQuality(new LegacyService({ environment: {} }), suite);
const complete = await evaluateCompleteness(service);
const paired = old.positive
  .filter((c) => c.group === 'original')
  .map((c) => {
    const rows = ['original', 'script', 'english'].map(
      (group) => report.rows.find((r) => r.pairId === c.pairId && r.group === group)!,
    );
    return {
      pairId: c.pairId,
      passed: rows.every((r) => r.rank > 0 && r.rank <= 5),
      ranks: rows.map((r) => r.rank),
    };
  });
const passed =
  qualityPass(report, legacy.summary.mrr) &&
  (report.summary.groups.english?.recall ?? 0) >= 0.9 &&
  paired.filter((p) => p.passed).length >= 29 &&
  complete.passed;
const output = resolve(root, '.local/evidence/rag-semantic-acceptance.json');
await writeFile(
  output,
  JSON.stringify(
    {
      passed,
      identity: index.identity,
      chunks: index.chunks.length,
      profile: RETRIEVAL_PROFILE,
      provider: provider.summary(),
      ...report,
      legacySummary: legacy.summary,
      trilingualPairs: paired,
      completeness: complete,
      realGeneration: 'not_yet_evaluated',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      passed,
      summary: report.summary,
      trilingualPairs: paired.filter((p) => p.passed).length,
      complete: `${complete.passedCount}/${complete.total}`,
      failures: report.failures,
      completenessFailures: complete.rows.filter((r) => !r.passed),
      output,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
