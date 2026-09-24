import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CachedSemanticProvider } from './embedding-cache.js';
import { loadDocumentSources } from './source-loader.js';
import { chunkMarkdownDocument } from './chunker.js';
import { verifyExpandedFixtures } from './evaluate-completeness.js';
import { loadQualitySuite } from './evaluate-quality.js';
if (!process.argv.includes('--allow-external')) throw new Error('Pass --allow-external explicitly');
await import('./cli-environment.js');
await verifyExpandedFixtures();
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const load = async (name: string) =>
  JSON.parse(await readFile(resolve(root, 'fixtures/rag', name), 'utf8'));
const sources = await loadDocumentSources();
const chunks = sources.flatMap((s) => chunkMarkdownDocument(s));
const original = await loadQualitySuite();
const calibration = await loadQualitySuite('v2');
const english = await load('retrieval-english.json');
const tuning = await load('trilingual-tuning.json');
const completeness = await load('source-completeness.json');
const answers = await load('answer-quality.json');
const texts = [
  ...new Set<string>([
    ...chunks.map((c) => c.content),
    ...original.positive.map((c) => c.query),
    ...calibration.positive.map((c) => c.query),
    ...calibration.negative.map((c) => c.query),
    ...original.negative.map((c) => c.query),
    ...english.positive.map((c: { query: string }) => c.query),
    ...english.negative.map((c: { query: string }) => c.query),
    ...tuning.cases.map((c: { query: string }) => c.query),
    ...tuning.negative,
    ...completeness.cases.flatMap((c: { query?: string }) => (c.query ? [c.query] : [])),
    ...answers.cases.map((c: { question: string }) => c.question),
  ]),
];
console.log(
  JSON.stringify({
    provider: 'text-embedding-3-large',
    dimensions: 1024,
    chunks: chunks.length,
    uniqueTexts: texts.length,
    inputTokenConservativeUpperBound: texts.reduce((n, t) => n + Buffer.byteLength(t), 0),
    limits: { uniqueInputs: 1000, inputTokens: 1000000, requests: 100 },
    scope:
      'Reviewed SOP chunks and frozen test questions only; no PDF clauses or financial transactions',
  }),
);
const provider = await CachedSemanticProvider.create(true, process.env);
try {
  await provider.embed(texts);
} finally {
  console.log(JSON.stringify(provider.summary()));
}
