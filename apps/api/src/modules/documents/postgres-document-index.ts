import { database, getRagDocumentIndexStatus, readRagDocumentCorpus } from '@cornven/database';

import { RagError } from './rag-errors.js';
import type {
  PersistentDocumentIndex,
  PersistentDocumentSearchInput,
} from './documents.service.js';

export class PostgresDocumentIndex implements PersistentDocumentIndex {
  async status(
    embeddingModel: string,
    permissionTags: PersistentDocumentSearchInput['permissionTags'],
  ) {
    try {
      return await getRagDocumentIndexStatus(database, embeddingModel, permissionTags);
    } catch {
      throw new RagError('RAG_INDEX_UNAVAILABLE');
    }
  }

  async search(input: PersistentDocumentSearchInput) {
    try {
      return await readRagDocumentCorpus(database, input.queryEmbedding, {
        embeddingModel: input.embeddingModel,
        permissionTags: input.permissionTags,
        minimumScore: input.minimumScore,
        limit: input.limit,
      });
    } catch (error) {
      throw new RagError(
        error instanceof Error && error.message === 'RAG_CAPACITY_EXCEEDED'
          ? 'RAG_CAPACITY_EXCEEDED'
          : 'RAG_INDEX_UNAVAILABLE',
      );
    }
  }
}
