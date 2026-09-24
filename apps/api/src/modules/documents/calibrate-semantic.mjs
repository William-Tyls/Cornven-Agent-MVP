import { readFile, writeFile } from 'node:fs/promises';
import { CachedSemanticProvider } from './embedding-cache.ts';
import { loadDocumentSources } from './source-loader.ts';
import { chunkMarkdownDocument } from './chunker.ts';
import { cosineSimilarity } from './embeddings.ts';
import { rankCandidates, RETRIEVAL_PROFILE } from './hybrid-retrieval.ts';
import { queryViews, loadSynonyms } from './retrieval-text.ts';
import { resolveTopicRelations } from './topic-relations.ts';
const sources = await loadDocumentSources();
const chunks = sources.flatMap((s) => chunkMarkdownDocument(s));
const provider = await CachedSemanticProvider.create(false);
const vectors = await provider.embed(chunks.map((c) => c.content));
const suite = JSON.parse(
  await readFile(
    new URL('../../../../../fixtures/rag/trilingual-tuning.json', import.meta.url),
    'utf8',
  ),
);
const calibration = JSON.parse(
  await readFile(
    new URL('../../../../../fixtures/rag/retrieval-calibration-v2.json', import.meta.url),
    'utf8',
  ),
);
const questions = [
  ...suite.cases,
  ...calibration.positive.map((c) => ({ query: c.query, requiredLocator: c.expectedLocatorText })),
  ...suite.negative.map((query) => ({ query, negative: true })),
  ...calibration.negative.map((c) => ({ query: c.query, negative: true })),
];
const prepared = [];
for (const c of questions) {
  const [v] = await provider.embed([c.query]);
  prepared.push({
    c,
    views: queryViews(c.query, undefined, loadSynonyms()),
    relations: resolveTopicRelations(sources, chunks, c.query),
    candidates: chunks.map((c, i) => ({
      documentId: c.documentId,
      documentVersion: c.documentVersion,
      chunkId: c.chunkId,
      title: c.title,
      locator: c.locator,
      content: c.content,
      score: cosineSimilarity(v, vectors[i]),
    })),
  });
}
const profiles = [];
for (const lexical of [0.05, 0.25, 0.5])
  for (const semanticMinimum of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55]) {
    RETRIEVAL_PROFILE.semanticLexicalWeight = lexical;
    RETRIEVAL_PROFILE.semanticVectorWeight = 1;
    const rows = prepared.map(({ c, views, relations, candidates }) => {
      const language = /\p{Script=Han}/u.test(c.query) ? 'chinese' : 'english';
      const result = rankCandidates(candidates, views, 'semantic', 5, semanticMinimum, relations);
      const rank = c.negative
        ? 0
        : result.findIndex((r) => r.locator.includes(c.requiredLocator)) + 1;
      return {
        language,
        query: c.query,
        negative: Boolean(c.negative),
        rank,
        passed: c.negative ? !result.length : rank > 0,
        returned: result.map((r) => ({ locator: r.locator, cosine: r.score })),
        expectedMax: c.negative
          ? undefined
          : Math.max(
              ...candidates
                .filter((r) => r.locator.includes(c.requiredLocator))
                .map((r) => r.score),
            ),
      };
    });
    profiles.push({
      lexical,
      vector: 1,
      semanticMinimum,
      hits: rows.filter((r) => !r.negative && r.passed).length,
      mrr:
        rows.filter((r) => !r.negative).reduce((n, r) => n + (r.rank ? 1 / r.rank : 0), 0) /
        questions.filter((c) => !c.negative).length,
      falsePositives: rows.filter((r) => r.negative && !r.passed).length,
      rows,
    });
  }
const byLanguage = {};
for (const language of ['chinese', 'english']) {
  byLanguage[language] = profiles
    .map((p) => {
      const rows = p.rows.filter((r) => r.language === language);
      return {
        ...p,
        rows,
        hits: rows.filter((r) => !r.negative && r.passed).length,
        mrr:
          rows.filter((r) => !r.negative).reduce((n, r) => n + (r.rank ? 1 / r.rank : 0), 0) /
          rows.filter((r) => !r.negative).length,
        falsePositives: rows.filter((r) => r.negative && !r.passed).length,
      };
    })
    .sort(
      (a, b) =>
        a.falsePositives - b.falsePositives ||
        b.hits - a.hits ||
        b.mrr - a.mrr ||
        b.semanticMinimum - a.semanticMinimum,
    );
}
await writeFile(
  new URL('../../../../../.local/evidence/rag-semantic-calibration.json', import.meta.url),
  JSON.stringify(
    {
      source:
        'frozen trilingual-tuning.json plus frozen retrieval-calibration-v2.json; no acceptance fixtures',
      byLanguage,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(byLanguage).map(([k, v]) => [
        k,
        v.map(({ rows, ...s }) => ({ ...s, count: rows.length })),
      ]),
    ),
    null,
    2,
  ),
);
