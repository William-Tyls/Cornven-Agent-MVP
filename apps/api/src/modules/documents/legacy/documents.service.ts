// Frozen pre-change implementation for offline evaluation only.
import {
  DocumentSearchOutputSchema,
  type DocumentModuleStatus,
  type DocumentPermissionTag,
  type DocumentSearchInput,
  type DocumentSearchOutput,
  type DocumentSearchResult,
} from '@cornven/contracts';

import {
  chunkMarkdownDocument,
  defaultChunkingOptions,
  type ChunkingOptions,
  type DocumentChunk,
} from '../chunker.js';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  tokenizeForRetrieval,
  type EmbeddingProvider,
} from './embeddings.js';
import { extractVerbatimExcerpt } from './excerpt.js';
import { loadDocumentSources, type SourceDocument } from '../source-loader.js';

export interface IndexedChunk {
  chunk: DocumentChunk;
  embedding: number[];
  tokens: Set<string>;
}

export interface DocumentIndexSnapshot {
  sources: SourceDocument[];
  chunks: IndexedChunk[];
  embeddingProvider: EmbeddingProvider;
}

export interface DocumentSearchContext {
  permissionTags: DocumentPermissionTag[];
}

export interface DocumentsServiceOptions {
  environment?: NodeJS.ProcessEnv;
  sourceLoader?: () => Promise<SourceDocument[]>;
  embeddingProvider?: EmbeddingProvider;
  chunking?: ChunkingOptions;
  minimumScore?: number;
  persistentIndex?: PersistentDocumentIndex;
}

export interface PersistentDocumentSearchInput {
  queryEmbedding: number[];
  embeddingModel: string;
  permissionTags: DocumentPermissionTag[];
  minimumScore: number;
  limit: number;
}

export interface PersistentDocumentSearchCandidate extends Omit<DocumentSearchResult, 'excerpt'> {
  score: number;
}

export interface PersistentDocumentIndex {
  status(
    embeddingModel: string,
    permissionTags: DocumentPermissionTag[],
  ): Promise<{ indexedDocuments: number; indexedChunks: number }>;
  search(input: PersistentDocumentSearchInput): Promise<PersistentDocumentSearchCandidate[]>;
}

function parseMinimumScore(value: string | undefined, fallback: number): number {
  const score = Number(value ?? fallback);
  if (!Number.isFinite(score) || score < -1 || score > 1) {
    throw new Error('RAG_SEARCH_MIN_SCORE must be a number between -1 and 1.');
  }
  return score;
}

function lexicalCoverage(queryTokens: Set<string>, documentTokens: Set<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.size;
}

function hasPermission(chunk: DocumentChunk, allowedTags: DocumentPermissionTag[]): boolean {
  return chunk.permissionTags.some((tag) => allowedTags.includes(tag));
}

export class DocumentsService {
  private readonly sourceLoader: () => Promise<SourceDocument[]>;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly chunking: ChunkingOptions;
  private readonly minimumScore: number;
  private readonly persistentIndex: PersistentDocumentIndex | undefined;
  private indexPromise: Promise<DocumentIndexSnapshot> | undefined;

  constructor(options: DocumentsServiceOptions = {}) {
    const environment = options.environment ?? process.env;
    this.sourceLoader = options.sourceLoader ?? (() => loadDocumentSources());
    this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProvider(environment);
    this.chunking = options.chunking ?? defaultChunkingOptions;
    this.persistentIndex = options.persistentIndex;
    this.minimumScore =
      options.minimumScore ??
      parseMinimumScore(
        environment.RAG_SEARCH_MIN_SCORE,
        this.embeddingProvider.mode === 'semantic' ? 0.5 : 0.2,
      );
  }

  async buildIndex(): Promise<DocumentIndexSnapshot> {
    const sources = await this.sourceLoader();
    const chunks = sources.flatMap((source) => chunkMarkdownDocument(source, this.chunking));
    const embeddings = await this.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
    if (embeddings.length !== chunks.length) {
      throw new Error('The embedding provider did not return one vector per document chunk.');
    }

    return {
      sources,
      chunks: chunks.map((chunk, index) => ({
        chunk,
        embedding: embeddings[index] ?? [],
        tokens: new Set(tokenizeForRetrieval(chunk.content)),
      })),
      embeddingProvider: this.embeddingProvider,
    };
  }

  async getIndex(): Promise<DocumentIndexSnapshot> {
    this.indexPromise ??= this.buildIndex();
    return this.indexPromise;
  }

  async status(context?: DocumentSearchContext): Promise<DocumentModuleStatus> {
    if (this.persistentIndex) {
      const counts = await this.persistentIndex.status(
        this.embeddingProvider.id,
        context?.permissionTags ?? [],
      );
      const ready = counts.indexedDocuments > 0 && counts.indexedChunks > 0;
      return {
        status: ready ? 'ready' : 'not_configured',
        ...counts,
        embeddingProvider: this.embeddingProvider.id,
        message: ready
          ? 'Authorised PostgreSQL/pgvector sources are indexed and ready for retrieval.'
          : 'No authorised PostgreSQL/pgvector chunks match the configured embedding provider.',
      };
    }

    const index = await this.getIndex();
    const permittedSourceIds = new Set(
      index.sources
        .filter(
          (source) =>
            !context || source.permissionTags.some((tag) => context.permissionTags.includes(tag)),
        )
        .map((source) => source.sourceId),
    );
    const indexedChunks = index.chunks.filter(({ chunk }) =>
      permittedSourceIds.has(chunk.documentId),
    ).length;
    const ready = permittedSourceIds.size > 0 && indexedChunks > 0;
    return {
      status: ready ? 'ready' : 'not_configured',
      indexedDocuments: permittedSourceIds.size,
      indexedChunks,
      embeddingProvider: index.embeddingProvider.id,
      message: ready
        ? 'Configured local sources are indexed and available for permission-filtered retrieval.'
        : 'No active RAG sources are configured.',
    };
  }

  async search(
    input: DocumentSearchInput,
    context: DocumentSearchContext,
  ): Promise<DocumentSearchOutput> {
    if (context.permissionTags.length === 0) {
      return DocumentSearchOutputSchema.parse({
        query: input.query,
        evidenceSufficient: false,
        results: [],
      });
    }

    const [queryEmbedding] = await this.embeddingProvider.embed([input.query]);
    if (!queryEmbedding) {
      throw new Error('The embedding provider did not return a query vector.');
    }
    const queryTokens = new Set(tokenizeForRetrieval(input.query));

    if (this.persistentIndex) {
      const candidateLimit =
        this.embeddingProvider.mode === 'semantic' ? input.limit : Math.min(input.limit * 20, 200);
      const candidates = await this.persistentIndex.search({
        queryEmbedding,
        embeddingModel: this.embeddingProvider.id,
        permissionTags: context.permissionTags,
        minimumScore: this.embeddingProvider.mode === 'semantic' ? this.minimumScore : -1,
        limit: candidateLimit,
      });
      const ranked = candidates
        .map((candidate) => {
          const lexicalScore = lexicalCoverage(
            queryTokens,
            new Set(tokenizeForRetrieval(candidate.content)),
          );
          const score =
            this.embeddingProvider.mode === 'semantic'
              ? candidate.score
              : candidate.score * 0.65 + lexicalScore * 0.35;
          return { candidate, score, lexicalScore };
        })
        .filter(
          ({ score, lexicalScore }) =>
            score >= this.minimumScore &&
            (this.embeddingProvider.mode === 'semantic' || lexicalScore > 0),
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit)
        .map(({ candidate: { score: _score, ...result } }) => ({
          ...result,
          excerpt: extractVerbatimExcerpt(result.content, input.query),
        }));

      return DocumentSearchOutputSchema.parse({
        query: input.query,
        evidenceSufficient: ranked.length > 0,
        results: ranked,
      });
    }

    const index = await this.getIndex();

    const ranked = index.chunks
      .filter(({ chunk }) => hasPermission(chunk, context.permissionTags))
      .map((candidate) => {
        const semanticScore = cosineSimilarity(queryEmbedding, candidate.embedding);
        const lexicalScore = lexicalCoverage(queryTokens, candidate.tokens);
        const score =
          index.embeddingProvider.mode === 'semantic'
            ? semanticScore
            : semanticScore * 0.65 + lexicalScore * 0.35;
        return { candidate, score, lexicalScore };
      })
      .filter(
        ({ score, lexicalScore }) =>
          score >= this.minimumScore &&
          (index.embeddingProvider.mode === 'semantic' || lexicalScore > 0),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);

    const results = ranked.map(({ candidate }) => ({
      documentId: candidate.chunk.documentId,
      documentVersion: candidate.chunk.documentVersion,
      chunkId: candidate.chunk.chunkId,
      title: candidate.chunk.title,
      locator: candidate.chunk.locator,
      excerpt: extractVerbatimExcerpt(candidate.chunk.content, input.query),
      content: candidate.chunk.content,
    }));
    return DocumentSearchOutputSchema.parse({
      query: input.query,
      evidenceSufficient: results.length > 0,
      results,
    });
  }
}
