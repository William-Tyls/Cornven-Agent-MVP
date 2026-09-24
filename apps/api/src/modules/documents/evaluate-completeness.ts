import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DocumentPermissionTagSchema } from '@cornven/contracts';
import { DocumentsService } from './documents.service.js';
import { loadDocumentSources } from './source-loader.js';
import { SourceStructureSchema, readRegisteredAsset } from './source-structure.js';
import { enrichDocumentCitations } from './document-resources.js';
import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { resolveTopicRelations, relationHash } from './topic-relations.js';
import { chunkMarkdownDocument } from './chunker.js';
import { rankCandidates } from './hybrid-retrieval.js';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const Case = z
  .object({
    id: z.string(),
    query: z.string().optional(),
    permissionTags: z.array(DocumentPermissionTagSchema).optional(),
    requiredLocators: z.array(z.string()).optional(),
    requiredFacts: z.array(z.string()).optional(),
    forbiddenLocators: z.array(z.string()).optional(),
    requiredResource: z.string().optional(),
    expectEmpty: z.boolean().optional(),
    fault: z.enum(['unreviewed-image', 'missing-asset', 'evidence-budget']).optional(),
  })
  .strict();
export async function verifyExpandedFixtures() {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'fixtures/rag/expanded-evaluation-manifest.json'), 'utf8'),
  ) as { files: Record<string, string> };
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (
      createHash('sha256')
        .update(await readFile(resolve(root, 'fixtures/rag', name)))
        .digest('hex') !== expected
    )
      throw new Error('Frozen fixture changed: ' + name);
  }
}
export async function evaluateCompleteness(
  service: Pick<DocumentsService, 'search'>,
  suitePath = resolve(root, 'fixtures/rag/source-completeness.json'),
  limit = 5,
) {
  await verifyExpandedFixtures();
  const suite = z
    .object({ schemaVersion: z.literal(1), basis: z.string(), cases: z.array(Case) })
    .strict()
    .parse(JSON.parse(await readFile(suitePath, 'utf8')));
  const sources = await loadDocumentSources();
  const chunks = sources.flatMap((s) => chunkMarkdownDocument(s));
  const rows = [];
  for (const c of suite.cases) {
    if (c.fault) {
      let passed = false;
      if (c.fault === 'unreviewed-image')
        passed = !SourceStructureSchema.safeParse({
          ...sources[0]!.structure,
          reviewStatus: 'unreviewed',
        }).success;
      if (c.fault === 'missing-asset') {
        const temp = await mkdtemp(join(tmpdir(), 'rag-missing-'));
        try {
          await readRegisteredAsset(
            sources.flatMap((s) => s.structure?.resources ?? []).find((r) => r.kind === 'pdf')!,
            temp,
          );
        } catch {
          passed = true;
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      if (c.fault === 'evidence-budget') {
        const relations = resolveTopicRelations(sources, chunks, '商品图片要求');
        const candidates = chunks
          .filter((c) => relations.has(c.chunkId))
          .map((c) => ({
            documentId: c.documentId,
            documentVersion: c.documentVersion,
            chunkId: c.chunkId,
            title: c.title,
            locator: c.locator,
            content: c.content,
            score: 1,
          }));
        passed =
          rankCandidates(candidates, ['商品图片要求'], 'lexical_hash', 1, undefined, relations)
            .length === 0;
      }
      rows.push({ id: c.id, passed, kind: c.fault });
      continue;
    }
    const result = await service.search(
      { query: c.query!, limit },
      { permissionTags: c.permissionTags ?? [] },
    );
    const bundle = buildAssistantEvidenceBundle(result);
    const enriched = await enrichDocumentCitations(
      bundle.items.map((i) => i.citation),
      async () => sources,
    );
    const text = result.results
      .map((r) => r.content)
      .join('\n')
      .normalize('NFKC');
    const missingLocators = (c.requiredLocators ?? []).filter(
      (l) => !result.results.some((r) => r.locator.includes(l)),
    );
    const missingFacts = (c.requiredFacts ?? []).filter((f) => !text.includes(f.normalize('NFKC')));
    const forbidden = (c.forbiddenLocators ?? []).filter((l) =>
      result.results.some((r) => r.locator.includes(l)),
    );
    const resourceFound =
      !c.requiredResource ||
      enriched.resources.some((r) => JSON.stringify(r).includes(c.requiredResource!));
    const passed =
      !missingLocators.length &&
      !missingFacts.length &&
      !forbidden.length &&
      resourceFound &&
      (!c.expectEmpty || !result.results.length) &&
      result.results.length <= limit;
    rows.push({
      id: c.id,
      passed,
      missingLocators,
      missingFacts,
      forbidden,
      resourceFound,
      returned: result.results.map((r) => ({ chunkId: r.chunkId, locator: r.locator })),
      resources: enriched.resources.map((r) => r.resourceId),
    });
  }
  return {
    schemaVersion: 1,
    passed: rows.every((r) => r.passed),
    passedCount: rows.filter((r) => r.passed).length,
    total: rows.length,
    relations: relationHash(),
    rows,
    realGeneration: 'not_evaluated_by_retrieval_suite',
  };
}
export async function runCompletenessCli() {
  const args = process.argv.slice(2).filter((x) => x !== '--');
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const report = await evaluateCompleteness(
    new DocumentsService({ environment: {} }),
    resolve(root, value('--suite') ?? 'fixtures/rag/source-completeness.json'),
  );
  const output = resolve(root, value('--output') ?? '.local/evidence/rag-completeness.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        count: report.passedCount,
        total: report.total,
        failures: report.rows.filter((r) => !r.passed),
        output,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}
