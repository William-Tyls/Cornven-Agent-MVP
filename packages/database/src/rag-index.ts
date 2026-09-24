import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { RAG_EMBEDDING_DIMENSIONS } from '@cornven/contracts';

export interface RagIndexChunk {
  ordinal: number;
  headingPath: string[];
  content: string;
  locator: string;
  checksum: string;
  embeddingModel: string;
  embedding: number[];
}

export interface RagIndexDocument {
  sourceId: string;
  title: string;
  sourceType: string;
  sourceUrl: string;
  sourceVersion: string;
  contentStatus: string;
  audience: string;
  checksum: string;
  permissionTags: string[];
  chunks: RagIndexChunk[];
}

export interface RagIndexStatus {
  indexedDocuments: number;
  indexedChunks: number;
}

export interface RagSearchOptions {
  embeddingModel: string;
  permissionTags: string[];
  minimumScore: number;
  limit: number;
}

export interface RagSearchResult {
  documentId: string;
  documentVersion: string;
  chunkId: string;
  title: string;
  locator: string;
  content: string;
  score: number;
}

export function toPgVectorLiteral(
  vector: number[],
  expectedDimensions = RAG_EMBEDDING_DIMENSIONS,
): string {
  if (vector.length !== expectedDimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding must contain ${expectedDimensions} finite numbers.`);
  }
  return `[${vector.join(',')}]`;
}

function validateSearchOptions(options: RagSearchOptions): void {
  if (!options.embeddingModel.trim()) {
    throw new Error('Embedding model must not be empty.');
  }
  if (
    !Number.isFinite(options.minimumScore) ||
    options.minimumScore < -1 ||
    options.minimumScore > 1
  ) {
    throw new Error('Minimum score must be a number between -1 and 1.');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new Error('RAG database candidate limit must be an integer between 1 and 200.');
  }
}

export async function getRagDocumentIndexStatus(
  client: PrismaClient,
  embeddingModel: string,
  permissionTags: string[],
): Promise<RagIndexStatus> {
  if (!embeddingModel.trim() || permissionTags.length === 0) {
    return { indexedDocuments: 0, indexedChunks: 0 };
  }

  const permissionList = Prisma.join(permissionTags.map((tag) => Prisma.sql`${tag}`));
  const [status] = await client.$queryRaw<Array<RagIndexStatus>>(Prisma.sql`
    SELECT
      COUNT(DISTINCT document."id")::integer AS "indexedDocuments",
      COUNT(chunk."id")::integer AS "indexedChunks"
    FROM "public"."Document" AS document
    INNER JOIN "public"."DocumentChunk" AS chunk
      ON chunk."documentId" = document."id"
      AND chunk."embedding" IS NOT NULL
      AND chunk."embeddingModel" = ${embeddingModel}
    WHERE document."retrievalStatus" = 'active'
      AND document."permissionTags" && ARRAY[${permissionList}]::text[]
  `);

  return {
    indexedDocuments: Number(status?.indexedDocuments ?? 0),
    indexedChunks: Number(status?.indexedChunks ?? 0),
  };
}

export async function searchRagDocumentIndex(
  client: PrismaClient,
  queryEmbedding: number[],
  options: RagSearchOptions,
): Promise<RagSearchResult[]> {
  validateSearchOptions(options);
  if (options.permissionTags.length === 0) {
    return [];
  }

  const vectorLiteral = toPgVectorLiteral(queryEmbedding);
  const permissionList = Prisma.join(options.permissionTags.map((tag) => Prisma.sql`${tag}`));
  const rows = await client.$queryRaw<Array<RagSearchResult>>(Prisma.sql`
    SELECT
      document."sourceId" AS "documentId",
      document."businessVersion" AS "documentVersion",
      chunk."checksum" AS "chunkId",
      document."title",
      chunk."locator",
      chunk."content",
      (1 - (chunk."embedding" <=> ${vectorLiteral}::vector(1024)))::double precision AS "score"
    FROM "public"."DocumentChunk" AS chunk
    INNER JOIN "public"."Document" AS document ON document."id" = chunk."documentId"
    WHERE document."retrievalStatus" = 'active'
      AND document."businessVersion" IS NOT NULL
      AND length(btrim(document."businessVersion")) > 0
      AND document."permissionTags" && ARRAY[${permissionList}]::text[]
      AND chunk."embedding" IS NOT NULL
      AND chunk."embeddingModel" = ${options.embeddingModel}
      AND (1 - (chunk."embedding" <=> ${vectorLiteral}::vector(1024))) >= ${options.minimumScore}
    ORDER BY chunk."embedding" <=> ${vectorLiteral}::vector(1024), chunk."id"
    LIMIT ${options.limit}
  `);

  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

export async function replaceRagDocumentIndex(
  client: PrismaClient,
  documents: RagIndexDocument[],
  options?: { expectedRevision: string },
): Promise<void> {
  // All validation and expensive embedding happen before acquiring the publication lock.
  for (const document of documents)
    for (const chunk of document.chunks) {
      toPgVectorLiteral(chunk.embedding);
      if (Math.abs(chunk.embedding.reduce((sum, x) => sum + x * x, 0) - 1) > 0.001)
        throw new Error('Index requires unit vectors.');
    }
  const revision = options?.expectedRevision ?? (await getRagPublishedRevision(client));
  await client.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(5703, 6001)`;
      if ((await getRagPublishedRevision(transaction)) !== revision)
        throw new Error('RAG_INDEX_STALE_BUILD');
      const activeSourceIds = documents.map((document) => document.sourceId);
      await transaction.document.updateMany({
        where: {
          sourceType: { in: ['notion_docx_export', 'notion_html_snapshot'] },
          ...(activeSourceIds.length > 0 ? { sourceId: { notIn: activeSourceIds } } : {}),
        },
        data: { retrievalStatus: 'disabled' },
      });

      for (const source of documents) {
        const document = await transaction.document.upsert({
          where: { sourceId: source.sourceId },
          create: {
            sourceId: source.sourceId,
            title: source.title,
            sourceType: source.sourceType,
            sourceUrl: source.sourceUrl,
            businessVersion: source.sourceVersion,
            contentStatus: source.contentStatus,
            audience: source.audience,
            retrievalStatus: 'active',
            checksum: source.checksum,
            permissionTags: source.permissionTags,
            indexedAt: new Date(),
          },
          update: {
            title: source.title,
            sourceType: source.sourceType,
            sourceUrl: source.sourceUrl,
            businessVersion: source.sourceVersion,
            contentStatus: source.contentStatus,
            audience: source.audience,
            retrievalStatus: 'active',
            checksum: source.checksum,
            permissionTags: source.permissionTags,
            indexedAt: new Date(),
          },
        });

        await transaction.documentChunk.deleteMany({ where: { documentId: document.id } });
        for (const chunk of source.chunks) {
          const vectorLiteral = toPgVectorLiteral(chunk.embedding);
          const created = await transaction.documentChunk.create({
            data: {
              documentId: document.id,
              ordinal: chunk.ordinal,
              headingPath: chunk.headingPath,
              content: chunk.content,
              locator: chunk.locator,
              checksum: chunk.checksum,
              embeddingModel: chunk.embeddingModel,
              embeddingDimensions: chunk.embedding.length,
            },
            select: { id: true },
          });
          await transaction.$executeRaw(
            Prisma.sql`UPDATE "public"."DocumentChunk"
                     SET "embedding" = ${vectorLiteral}::vector
                     WHERE "id" = ${created.id}`,
          );
        }
      }
    },
    { timeout: 30000 },
  );
}

/** Revision includes publication timestamps, so concurrent rebuilds of one identity also conflict. */
export async function getRagPublishedRevision(
  client: Pick<PrismaClient, '$queryRaw'>,
): Promise<string> {
  const rows =
    await client.$queryRaw`SELECT d."sourceId", d."checksum", d."retrievalStatus", d."indexedAt", c."embeddingModel", count(c.id)::integer AS n FROM "Document" d LEFT JOIN "DocumentChunk" c ON c."documentId"=d.id WHERE d."sourceType" IN ('notion_docx_export','notion_html_snapshot') GROUP BY d.id,c."embeddingModel" ORDER BY d."sourceId",c."embeddingModel"`;
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
/** One MVCC statement supplies BOTH lexical text and precise vector scores. No ANN/top-k truncation. */
export async function readRagDocumentCorpus(
  client: PrismaClient,
  queryEmbedding: number[],
  options: RagSearchOptions,
): Promise<RagSearchResult[]> {
  if (!options.embeddingModel.trim()) throw new Error('Missing index identity');
  if (!options.permissionTags.length) return [];
  const vector = toPgVectorLiteral(queryEmbedding);
  const permissions = Prisma.join(options.permissionTags.map((t) => Prisma.sql`${t}`));
  const rows = await client.$queryRaw<RagSearchResult[]>(Prisma.sql`
    SELECT d."sourceId" AS "documentId", d."businessVersion" AS "documentVersion", c."checksum" AS "chunkId",
      d.title, c.locator, c.content, (1-(c.embedding <=> ${vector}::vector(1024)))::double precision AS score
    FROM "Document" d JOIN "DocumentChunk" c ON c."documentId"=d.id
    WHERE d."retrievalStatus"='active' AND d."businessVersion" IS NOT NULL AND length(btrim(d."businessVersion"))>0
      AND d."permissionTags" && ARRAY[${permissions}]::text[] AND c.embedding IS NOT NULL AND c."embeddingModel"=${options.embeddingModel}
    ORDER BY d."sourceId",c.ordinal LIMIT 10001`);
  if (rows.length > 10000) throw new Error('RAG_CAPACITY_EXCEEDED');
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}
