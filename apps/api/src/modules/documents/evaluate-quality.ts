import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DocumentPermissionTagSchema } from '@cornven/contracts';
import type { DocumentsService } from './documents.service.js';
const positive = z
  .object({
    id: z.string(),
    group: z.string(),
    pairId: z.string(),
    query: z.string(),
    permissionTags: z.array(DocumentPermissionTagSchema),
    expectedDocumentId: z.string(),
    expectedLocatorText: z.string(),
    expectedExcerptText: z.string(),
    maxRank: z.number(),
  })
  .strict();
export const QualitySuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    positive: z.array(positive),
    negative: z.array(
      z
        .object({
          id: z.string(),
          query: z.string(),
          permissionTags: z.array(DocumentPermissionTagSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type QualitySuite = z.infer<typeof QualitySuiteSchema>;
const directory = new URL('../../../../../fixtures/rag/', import.meta.url);
export async function loadQualitySuite(tuning: boolean | 'v2' = false): Promise<QualitySuite> {
  const manifest = JSON.parse(
    await readFile(new URL('evaluation-manifest.json', directory), 'utf8'),
  ) as { hashes: Record<string, string> };
  for (const [name, hash] of Object.entries(manifest.hashes)) {
    const bytes = await readFile(new URL(name, directory));
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new Error(`Frozen fixture changed: ${name}`);
  }
  if (tuning === 'v2') {
    const raw = await readFile(new URL('retrieval-calibration-v2.json', directory));
    const hash = (await readFile(new URL('calibration-v2.sha256', directory), 'utf8')).trim();
    if (createHash('sha256').update(raw).digest('hex') !== hash)
      throw new Error('Calibration changed');
    return QualitySuiteSchema.parse(JSON.parse(raw.toString()));
  }
  return QualitySuiteSchema.parse(
    JSON.parse(
      await readFile(
        new URL(tuning ? 'retrieval-tuning.json' : 'retrieval-quality.json', directory),
        'utf8',
      ),
    ),
  );
}
export function metrics(rows: { rank: number; excerpt: boolean; verbatim: boolean }[], limit = 5) {
  return {
    count: rows.length,
    recall: rows.filter((r) => r.rank > 0 && r.rank <= limit).length / rows.length,
    mrr:
      rows.reduce((s, r) => s + (r.rank > 0 && r.rank <= limit ? 1 / r.rank : 0), 0) / rows.length,
    excerpts: rows.filter((r) => r.excerpt).length,
    verbatim: rows.every((r) => r.verbatim),
  };
}
export async function evaluateQuality(
  service: Pick<DocumentsService, 'search'>,
  suite: QualitySuite,
  limit = 5,
) {
  const rows: {
    id: string;
    group: string;
    pairId: string;
    query: string;
    rank: number;
    excerpt: boolean;
    verbatim: boolean;
    returned: string[];
  }[] = [];
  for (const c of suite.positive) {
    const result = await service.search(
      { query: c.query, limit },
      { permissionTags: c.permissionTags },
    );
    const matches = result.results.filter(
      (r) => r.documentId === c.expectedDocumentId && r.locator.includes(c.expectedLocatorText),
    );
    const rank = matches.length ? result.results.indexOf(matches[0]!) + 1 : 0;
    rows.push({
      id: c.id,
      group: c.group,
      pairId: c.pairId,
      query: c.query,
      rank,
      excerpt: matches.some((r) => r.excerpt.includes(c.expectedExcerptText)),
      verbatim: result.results.every(
        (r) => r.content.includes(r.excerpt) && r.excerpt.length <= 480,
      ),
      returned: result.results.map((r) => r.locator),
    });
  }
  const negatives = [];
  for (const c of suite.negative) {
    const result = await service.search(
      { query: c.query, limit },
      { permissionTags: c.permissionTags },
    );
    negatives.push({
      id: c.id,
      query: c.query,
      falsePositive: result.evidenceSufficient || result.results.length > 0,
      returned: result.results.map((r) => r.locator),
    });
  }
  const groups = Object.fromEntries(
    [...new Set(rows.map((r) => r.group))].map((g) => [
      g,
      metrics(
        rows.filter((r) => r.group === g),
        limit,
      ),
    ]),
  );
  const original = rows.filter((r) => r.group === 'original');
  const pairs = original.map((r) => {
    const pair = rows.find((p) => p.pairId === r.pairId && p.group === 'script');
    return r.rank > 0 && r.rank <= 3 && pair !== undefined && pair.rank > 0 && pair.rank <= 3;
  });
  const summary = {
    ...metrics(rows, limit),
    groups,
    falsePositives: negatives.filter((n) => n.falsePositive).length,
    negativeCount: negatives.length,
    pairedTop3: pairs.length ? pairs.filter(Boolean).length / pairs.length : 1,
  };
  const failures = [
    ...rows.filter((r) => !r.rank || !r.excerpt || !r.verbatim),
    ...negatives.filter((n) => n.falsePositive),
  ];
  return { summary, rows, negatives, failures };
}
export function qualityPass(
  report: Awaited<ReturnType<typeof evaluateQuality>>,
  legacyMrr: number,
) {
  const s = report.summary;
  return (
    s.recall >= 0.95 &&
    s.mrr >= 0.75 &&
    s.mrr >= legacyMrr &&
    s.verbatim &&
    s.pairedTop3 >= 0.9 &&
    s.falsePositives / s.negativeCount <= 0.05 &&
    (s.groups.script?.recall ?? 0) >= 0.9 &&
    (s.groups.synonym?.recall ?? 0) >= 0.9 &&
    report.rows.filter((r) => r.group === 'original').every((r) => r.rank > 0 && r.excerpt) &&
    report.negatives.slice(0, 8).every((n) => !n.falsePositive)
  );
}
