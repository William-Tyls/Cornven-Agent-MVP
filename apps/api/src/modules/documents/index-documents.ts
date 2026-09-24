import './cli-environment.js';
import { database, replaceRagDocumentIndex, getRagPublishedRevision } from '@cornven/database';

import { DocumentsService } from './documents.service.js';

const service = new DocumentsService();

try {
  const expectedRevision = await getRagPublishedRevision(database);
  const index = await service.buildIndex();
  await service.assertCurrentIdentity(index.identity);
  await replaceRagDocumentIndex(
    database,
    index.sources.map((source) => ({
      sourceId: source.sourceId,
      title: source.title,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      sourceVersion: source.sourceVersion,
      contentStatus: source.contentStatus,
      audience: source.audience,
      checksum: source.checksum,
      permissionTags: source.permissionTags,
      chunks: index.chunks
        .filter(({ chunk }) => chunk.documentId === source.sourceId)
        .map(({ chunk, embedding }) => ({
          ordinal: chunk.ordinal,
          headingPath: chunk.headingPath,
          content: chunk.content,
          locator: chunk.locator,
          checksum: chunk.checksum,
          embeddingModel: index.identity,
          embedding,
        })),
    })),
    { expectedRevision },
  );
  console.log(
    `RAG index stored: ${index.sources.length} documents and ${index.chunks.length} chunks.`,
  );
} finally {
  await database.$disconnect();
}
