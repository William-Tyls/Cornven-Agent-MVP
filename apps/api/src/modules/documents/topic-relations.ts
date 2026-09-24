import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SourceDocument } from './source-loader.js';
import type { DocumentChunk } from './chunker.js';
import {
  canonicalView,
  normalizeRetrievalText,
  loadSynonyms,
  retrievalTokens,
} from './retrieval-text.js';
const Schema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    relations: z.array(
      z
        .object({
          topicId: z.string(),
          kind: z.literal('complements'),
          sourceId: z.string(),
          sourceVersion: z.string(),
          blockIds: z.array(z.string()).min(2).max(3),
          queryConcepts: z.array(z.string()).min(2),
          excludeConcepts: z.array(z.string()),
          reviewStatus: z.literal('reviewed'),
          scope: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export function loadTopicRelations() {
  return Schema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../../data/rag/topic-relations.json', import.meta.url),
        'utf8',
      ),
    ),
  );
}
export function relationHash() {
  return createHash('sha256').update(JSON.stringify(loadTopicRelations())).digest('hex');
}
export function resolveTopicRelations(
  sources: SourceDocument[],
  chunks: DocumentChunk[],
  question?: string,
) {
  const query = canonicalView(normalizeRetrievalText(question ?? ''), loadSynonyms());
  const result = new Map<string, string[]>();
  for (const relation of loadTopicRelations().relations) {
    const source = sources.find((s) => s.sourceId === relation.sourceId);
    if (!source?.structure) continue;
    if (source.sourceVersion !== relation.sourceVersion)
      throw new Error('Relation snapshot mismatch');
    const groups = relation.blockIds.map((id) => {
      const block = source.structure!.blocks.find((b) => b.blockId === id);
      if (!block) throw new Error('Relation references missing block');
      const sections = source.structure!.sections.filter(
        (s) => JSON.stringify(s.headingPath) === JSON.stringify(block.headingPath),
      );
      const blockIds = new Set(sections.flatMap((s) => s.blockIds));
      const group = chunks
        .filter((c) => c.documentId === source.sourceId && c.blockIds?.some((b) => blockIds.has(b)))
        .map((c) => c.chunkId);
      if (!group.length) throw new Error('Relation has no current chunks');
      return group;
    });
    if (
      !question ||
      !relation.queryConcepts.every((t) => query.includes(normalizeRetrievalText(t))) ||
      relation.excludeConcepts.some((t) => query.includes(normalizeRetrievalText(t)))
    )
      continue;
    const primary = groups.flat();
    const paths = relation.blockIds.map(
      (id) => source.structure!.blocks.find((b) => b.blockId === id)!.headingPath,
    );
    for (const c of chunks.filter((c) => c.documentId === source.sourceId)) {
      if (paths.some((path) => path.every((h, i) => c.headingPath[i] === h))) {
        result.set(
          c.chunkId,
          primary.filter((id) => id !== c.chunkId),
        );
      }
    }
  }
  // Multipart continuations of one reviewed semantic section share a stable source scope.
  // Only a broad request explicitly matching that section can form a whole-section bundle.
  if (question && /步骤|步驟|流程|全部|完整|所有|\bsteps\b|\ball\b/i.test(question)) {
    const terms = new Set(retrievalTokens(question));
    const groups = new Map<string, DocumentChunk[]>();
    for (const c of chunks) {
      const own = retrievalTokens(c.headingPath.at(-1) ?? '');
      const matched = own.filter((t) => terms.has(t)).length;
      if (matched < 2 || matched / Math.max(own.length, 1) < 0.6) continue;
      const key = c.documentId + '\n' + c.documentVersion + '\n' + c.headingPath.join(' > ');
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const group of groups.values()) {
      if (group.length < 2 || group.length > 3) continue;
      for (const c of group)
        result.set(
          c.chunkId,
          group.filter((p) => p.chunkId !== c.chunkId).map((p) => p.chunkId),
        );
    }
  }
  return result;
}
