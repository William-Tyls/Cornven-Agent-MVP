import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { defaultChunkingOptions } from './chunker.js';
import { DocumentsService } from './documents.service.js';
import { extractVerbatimExcerpt } from './excerpt.js';
import { evaluateRetrieval, loadRetrievalEvaluationSuite } from './retrieval-evaluation.js';

const service = new DocumentsService({ environment: {} });
const index = await service.getIndex();

if (index.sources.length !== 4) {
  throw new Error(`Expected 4 active SOP sources, found ${index.sources.length}.`);
}
if (index.chunks.length === 0) {
  throw new Error('RAG source validation produced no chunks.');
}

const locators = new Set<string>();
const multipartSections = new Set<string>();
const multipartSeries = new Map<string, { total: number; parts: Set<number> }>();
const chunksByDocumentOrdinal = new Map(
  index.chunks.map(({ chunk }) => [`${chunk.documentId}:${chunk.ordinal}`, chunk]),
);
let verifiedMultipartBoundaries = 0;
let minimumVerifiedOverlap = Number.POSITIVE_INFINITY;
let maximumVerifiedOverlap = 0;

function contentBody(content: string): string {
  const separator = content.indexOf('\n\n');
  return separator === -1 ? content : content.slice(separator + 2);
}

function partDetails(locator: string): { part: number; total: number } | undefined {
  const match = /part (\d+)\/(\d+)/.exec(locator);
  if (!match) {
    return undefined;
  }
  return { part: Number(match[1]), total: Number(match[2]) };
}

function suffixPrefixOverlap(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function endsAtNaturalBoundary(content: string): boolean {
  return /[。！？.!?；;，,：:）)\]】>|]$/u.test(content.trimEnd());
}

for (const { chunk, embedding } of index.chunks) {
  const key = `${chunk.documentId}:${chunk.locator}`;
  if (locators.has(key)) {
    throw new Error(`Duplicate RAG locator: ${key}`);
  }
  locators.add(key);
  if (chunk.headingPath.length === 0 || !chunk.content.trim()) {
    throw new Error(`RAG chunk is missing a heading path or content: ${key}`);
  }
  if (chunk.chunkId !== chunk.checksum || !chunk.documentVersion.trim()) {
    throw new Error(`RAG chunk is not compatible with the Assistant citation contract: ${key}`);
  }
  if (chunk.content.length > defaultChunkingOptions.maxChars) {
    throw new Error(`RAG chunk exceeds the configured maximum length: ${key}`);
  }
  if (embedding.length !== index.embeddingProvider.dimensions) {
    throw new Error(`RAG chunk has an invalid embedding dimension: ${key}`);
  }

  const parts = partDetails(chunk.locator);
  if (parts) {
    const occurrence = /occurrence \d+\/\d+/.exec(chunk.locator)?.[0] ?? 'occurrence 1/1';
    const seriesKey = `${chunk.documentId}:${chunk.headingPath.join(' > ')}:${occurrence}`;
    multipartSections.add(seriesKey);
    const series = multipartSeries.get(seriesKey) ?? { total: parts.total, parts: new Set() };
    if (series.total !== parts.total || series.parts.has(parts.part)) {
      throw new Error(`RAG multipart locator is inconsistent or duplicated: ${key}`);
    }
    series.parts.add(parts.part);
    multipartSeries.set(seriesKey, series);
    if (parts.part < 1 || parts.part > parts.total) {
      throw new Error(`RAG chunk has an invalid multipart locator: ${key}`);
    }
    if (parts.part > 1) {
      const previous = chunksByDocumentOrdinal.get(`${chunk.documentId}:${chunk.ordinal - 1}`);
      const previousParts = previous ? partDetails(previous.locator) : undefined;
      if (
        !previous ||
        previous.documentId !== chunk.documentId ||
        previous.headingPath.join('\n') !== chunk.headingPath.join('\n') ||
        !previousParts ||
        previousParts.part !== parts.part - 1 ||
        previousParts.total !== parts.total
      ) {
        throw new Error(`RAG multipart sequence is broken before: ${key}`);
      }

      const overlap = suffixPrefixOverlap(
        contentBody(previous.content),
        contentBody(chunk.content),
      );
      const minimumExpectedOverlap = Math.floor(defaultChunkingOptions.overlapChars * 0.8);
      if (overlap < minimumExpectedOverlap) {
        throw new Error(
          `RAG multipart boundary lost context (${overlap} characters) before: ${key}`,
        );
      }
      if (
        !endsAtNaturalBoundary(contentBody(previous.content)) &&
        !index.sources
          .find((s) => s.sourceId === chunk.documentId)
          ?.structure?.sections.some((s) => s.body.includes(contentBody(previous.content) + '\n'))
      ) {
        throw new Error(`RAG multipart text ends inside a sentence before: ${key}`);
      }
      minimumVerifiedOverlap = Math.min(minimumVerifiedOverlap, overlap);
      maximumVerifiedOverlap = Math.max(maximumVerifiedOverlap, overlap);
      verifiedMultipartBoundaries += 1;
    }
  }
}

for (const [seriesKey, series] of multipartSeries) {
  if (series.parts.size !== series.total) {
    throw new Error(
      `RAG multipart section is incomplete (${series.parts.size}/${series.total}): ${seriesKey}`,
    );
  }
}

const evidenceBundle = buildAssistantEvidenceBundle({
  query: 'RAG integrity check',
  evidenceSufficient: true,
  results: index.chunks.map(({ chunk }) => ({
    documentId: chunk.documentId,
    documentVersion: chunk.documentVersion,
    chunkId: chunk.chunkId,
    title: chunk.title,
    locator: chunk.locator,
    excerpt: extractVerbatimExcerpt(chunk.content, 'RAG integrity check'),
    content: chunk.content,
  })),
});
if (evidenceBundle.items.length !== index.chunks.length) {
  throw new Error('RAG evidence bundle omitted one or more verified chunks.');
}

const evaluation = await evaluateRetrieval(service, await loadRetrievalEvaluationSuite());
const activeDocumentIds = index.sources.map((source) => source.sourceId).sort();
if (evaluation.coveredDocumentIds.join('\n') !== activeDocumentIds.join('\n')) {
  throw new Error('RAG positive evaluation cases must cover every active source document.');
}

const overlapRange =
  verifiedMultipartBoundaries > 0
    ? `${minimumVerifiedOverlap}-${maximumVerifiedOverlap}`
    : 'not applicable';
console.log(
  `RAG sources valid: ${index.sources.length} documents, ${index.chunks.length} chapter-aware chunks and evidence items, ${multipartSections.size} multipart sections and ${verifiedMultipartBoundaries} continuous boundaries (${overlapRange} overlap characters), ${evaluation.positiveCases} positive and ${evaluation.negativeCases} negative retrieval cases covering all sources (maximum expected-source rank ${evaluation.maximumObservedRank}), provider ${index.embeddingProvider.id}.`,
);
