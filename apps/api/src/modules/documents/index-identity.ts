import { relationHash } from './topic-relations.js';
import { createHash } from 'node:crypto';
import type { SourceDocument } from './source-loader.js';
import type { ChunkingOptions } from './chunker.js';
import { NORMALIZER_VERSION, synonymHash, type SynonymConfig } from './retrieval-text.js';
import { RETRIEVAL_PROFILE } from './hybrid-retrieval.js';
export function indexIdentity(
  sources: SourceDocument[],
  provider: { id: string; dimensions: number },
  chunking: ChunkingOptions,
  synonyms: SynonymConfig,
): string {
  const data = {
    sources: sources
      .map((s) => ({
        id: s.sourceId,
        version: s.sourceVersion,
        checksum: s.checksum,
        structureChecksum: s.structureChecksum,
        tags: [...s.permissionTags].sort(),
        title: s.title,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    provider: provider.id,
    relations: relationHash(),
    dimensions: provider.dimensions,
    chunking,
    chunkerVersion: 'structured-v1',
    normalizer: NORMALIZER_VERSION,
    synonyms: synonymHash(synonyms),
    profile: RETRIEVAL_PROFILE,
  };
  return `${provider.id}:rag-v2:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
}
