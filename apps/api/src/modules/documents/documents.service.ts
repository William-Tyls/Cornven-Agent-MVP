import { contextPolicy, evidenceTokenUpperBound } from './context-policy.js';
import { resolveTopicRelations } from './topic-relations.js';
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
} from './chunker.js';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  tokenizeForRetrieval,
  type EmbeddingProvider,
} from './embeddings.js';
import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { extractVerbatimExcerpt } from './excerpt.js';
import { loadDocumentSources, type SourceDocument } from './source-loader.js';
import { loadSynonyms, queryViews } from './retrieval-text.js';
import { rankCandidates } from './hybrid-retrieval.js';
import { indexIdentity } from './index-identity.js';
import { readIndexSnapshot } from './index-snapshot.js';
import { abortable, RagError } from './rag-errors.js';
export interface IndexedChunk {
  chunk: DocumentChunk;
  embedding: number[];
  tokens: Set<string>;
}

export interface DocumentIndexSnapshot {
  sources: SourceDocument[];
  chunks: IndexedChunk[];
  embeddingProvider: EmbeddingProvider;
  identity: string;
}

export interface DocumentSearchContext {
  permissionTags: DocumentPermissionTag[];
  originalQuestion?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface DocumentsServiceOptions {
  environment?: NodeJS.ProcessEnv;
  sourceLoader?: () => Promise<SourceDocument[]>;
  embeddingProvider?: EmbeddingProvider;
  chunking?: ChunkingOptions;
  minimumScore?: number;
  persistentIndex?: PersistentDocumentIndex;
  snapshotDirectory?: string;
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

export class DocumentsService {
  private readonly sourceLoader: () => Promise<SourceDocument[]>;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly chunking: ChunkingOptions;
  private readonly minimumScore: number | undefined;
  private readonly persistentIndex: PersistentDocumentIndex | undefined;
  private readonly snapshotDirectory: string | undefined;
  private readonly policy: ReturnType<typeof contextPolicy>;
  private indexPromise: Promise<DocumentIndexSnapshot> | undefined;
  private snapshot: DocumentIndexSnapshot | undefined;
  constructor(options: DocumentsServiceOptions = {}) {
    const env = options.environment ?? process.env;
    this.policy = contextPolicy(env);
    this.sourceLoader = options.sourceLoader ?? (() => loadDocumentSources());
    try {
      this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProvider(env);
    } catch {
      throw new RagError('RAG_CONFIG_INVALID');
    }
    this.chunking = options.chunking ?? defaultChunkingOptions;
    this.persistentIndex = options.persistentIndex;
    this.snapshotDirectory = options.snapshotDirectory;
    this.minimumScore =
      options.minimumScore ??
      (env.RAG_SEARCH_MIN_SCORE === undefined ? undefined : Number(env.RAG_SEARCH_MIN_SCORE));
    if (
      this.minimumScore !== undefined &&
      (!Number.isFinite(this.minimumScore) || this.minimumScore < -1 || this.minimumScore > 1)
    )
      throw new RagError('RAG_CONFIG_INVALID');
  }
  private async material() {
    let sources: SourceDocument[];
    try {
      sources = await this.sourceLoader();
    } catch {
      throw new RagError('RAG_EVIDENCE_INVALID');
    }
    if (!sources.length) throw new RagError('RAG_INDEX_UNAVAILABLE');
    const synonyms = loadSynonyms();
    const identity = indexIdentity(sources, this.embeddingProvider, this.chunking, synonyms);
    const chunks = sources.flatMap((s) => chunkMarkdownDocument(s, this.chunking));
    if (!chunks.length) throw new RagError('RAG_INDEX_UNAVAILABLE');
    try {
      resolveTopicRelations(sources, chunks);
    } catch {
      throw new RagError('RAG_EVIDENCE_INVALID');
    }
    if (chunks.length > 10000) throw new RagError('RAG_CAPACITY_EXCEEDED');
    return { sources, synonyms, identity, chunks };
  }
  private async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(10000);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    try {
      const vectors = await abortable(
        this.embeddingProvider.embed(texts, { signal: combined }),
        combined,
      );
      if (
        vectors.length !== texts.length ||
        vectors.some(
          (v) =>
            v.length !== this.embeddingProvider.dimensions ||
            v.some((x) => !Number.isFinite(x)) ||
            Math.abs(v.reduce((sum, x) => sum + x * x, 0) - 1) > 0.001,
        )
      )
        throw new RagError('RAG_PROVIDER_UNAVAILABLE');
      return vectors;
    } catch (error) {
      if (signal?.aborted) {
        if (signal.reason?.name === 'TimeoutError') throw new RagError('RAG_PROVIDER_TIMEOUT');
        signal.throwIfAborted();
      }
      if (error instanceof RagError) throw error;
      throw new RagError(timeout.aborted ? 'RAG_PROVIDER_TIMEOUT' : 'RAG_PROVIDER_UNAVAILABLE');
    }
  }
  async assertCurrentIdentity(identity: string): Promise<void> {
    if ((await this.material()).identity !== identity) throw new RagError('RAG_INDEX_UNAVAILABLE');
  }
  // Explicit builds may call a paid provider. Search never does this for semantic mode.
  async buildIndex(signal?: AbortSignal): Promise<DocumentIndexSnapshot> {
    const m = await this.material();
    const combined = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    const embeddings: number[][] = [];
    for (let i = 0; i < m.chunks.length; i += 16) {
      if (combined.aborted && combined.reason?.name === 'TimeoutError')
        throw new RagError('RAG_PROVIDER_TIMEOUT');
      combined.throwIfAborted();
      embeddings.push(
        ...(await this.embed(
          m.chunks.slice(i, i + 16).map((c) => c.content),
          combined,
        )),
      );
    }
    if (
      embeddings.length !== m.chunks.length ||
      embeddings.some(
        (v) => v.length !== this.embeddingProvider.dimensions || v.some((x) => !Number.isFinite(x)),
      )
    )
      throw new RagError('RAG_PROVIDER_UNAVAILABLE');
    if ((await this.material()).identity !== m.identity)
      throw new RagError('RAG_INDEX_UNAVAILABLE');
    return {
      sources: m.sources,
      identity: m.identity,
      embeddingProvider: this.embeddingProvider,
      chunks: m.chunks.map((chunk, i) => ({
        chunk,
        embedding: embeddings[i]!,
        tokens: new Set(tokenizeForRetrieval(chunk.content)),
      })),
    };
  }
  async getIndex(): Promise<DocumentIndexSnapshot> {
    const m = await this.material();
    if (this.snapshot) {
      if (this.snapshot.identity !== m.identity) throw new RagError('RAG_INDEX_UNAVAILABLE');
      return this.snapshot;
    }
    if (!this.indexPromise) {
      const build =
        this.embeddingProvider.mode === 'semantic'
          ? readIndexSnapshot(
              m.identity,
              m.chunks,
              this.embeddingProvider.dimensions,
              this.snapshotDirectory,
            ).then((embeddings) => ({
              sources: m.sources,
              identity: m.identity,
              embeddingProvider: this.embeddingProvider,
              chunks: m.chunks.map((chunk, i) => ({
                chunk,
                embedding: embeddings[i]!,
                tokens: new Set(tokenizeForRetrieval(chunk.content)),
              })),
            }))
          : this.buildIndex();
      this.indexPromise = build
        .then((index) => {
          // Freeze published data; callers cannot alter a snapshot used by other requests.
          for (const item of index.chunks) {
            Object.freeze(item.embedding);
            Object.freeze(item.chunk.headingPath);
            Object.freeze(item.chunk.permissionTags);
            Object.freeze(item.chunk);
            Object.freeze(item);
          }
          for (const source of index.sources) {
            Object.freeze(source.permissionTags);
            Object.freeze(source);
          }
          Object.freeze(index.chunks);
          Object.freeze(index.sources);
          Object.freeze(index);
          this.snapshot = index;
          return index;
        })
        .finally(() => {
          this.indexPromise = undefined;
        });
    }
    const index = await this.indexPromise;
    if (index.identity !== m.identity) throw new RagError('RAG_INDEX_UNAVAILABLE');
    return index;
  }
  async status(context?: DocumentSearchContext): Promise<DocumentModuleStatus> {
    try {
      if (this.persistentIndex) {
        const m = await this.material();
        const counts = await this.persistentIndex.status(m.identity, context?.permissionTags ?? []);
        const expected = m.chunks.filter((c) =>
          c.permissionTags.some((t) => context?.permissionTags.includes(t)),
        ).length;
        return {
          status:
            counts.indexedChunks > 0 && counts.indexedChunks === expected
              ? 'ready'
              : 'not_configured',
          ...counts,
          embeddingProvider: this.embeddingProvider.id,
          message:
            counts.indexedChunks === expected && expected > 0
              ? 'Authorised compatible index ready.'
              : 'RAG_INDEX_UNAVAILABLE: 请重建匹配的完整索引。',
        };
      }
      const index = await this.getIndex();
      const chunks = index.chunks.filter(
        ({ chunk }) =>
          !context || chunk.permissionTags.some((t) => context.permissionTags.includes(t)),
      );
      return {
        status: chunks.length ? 'ready' : 'not_configured',
        indexedDocuments: new Set(chunks.map((c) => c.chunk.documentId)).size,
        indexedChunks: chunks.length,
        embeddingProvider: this.embeddingProvider.id,
        message: chunks.length
          ? 'Authorised compatible memory index ready.'
          : 'No authorised sources available.',
      };
    } catch (error) {
      return {
        status: 'not_configured',
        indexedDocuments: 0,
        indexedChunks: 0,
        embeddingProvider: this.embeddingProvider.id,
        message:
          error instanceof RagError
            ? `${error.code}: ${error.message}`
            : 'RAG_INDEX_UNAVAILABLE: 知识索引暂时不可用。',
      };
    }
  }
  async search(
    input: DocumentSearchInput,
    context: DocumentSearchContext,
  ): Promise<DocumentSearchOutput> {
    const empty = () =>
      DocumentSearchOutputSchema.parse({
        query: input.query,
        evidenceSufficient: false,
        results: [],
      });
    context.signal?.throwIfAborted();
    if (!context.permissionTags.length) return empty();
    const m = await this.material();
    const visible = m.chunks.filter((c) =>
      c.permissionTags.some((t) => context.permissionTags.includes(t)),
    );
    if (!visible.length) return empty();
    // Do not spend a query embedding call until index availability has been checked.
    const index = this.persistentIndex
      ? undefined
      : await abortable(this.getIndex(), context.signal);
    if (this.persistentIndex) {
      const counts = await this.persistentIndex.status(m.identity, context.permissionTags);
      if (counts.indexedChunks !== visible.length) throw new RagError('RAG_INDEX_UNAVAILABLE');
    }
    const views = queryViews(context.originalQuestion ?? input.query, input.query, m.synonyms);
    const [vector] = await this.embed([context.originalQuestion ?? input.query], context.signal);
    if (!vector) throw new RagError('RAG_PROVIDER_UNAVAILABLE');
    const candidates = this.persistentIndex
      ? await this.persistentIndex.search({
          queryEmbedding: vector,
          embeddingModel: m.identity,
          permissionTags: context.permissionTags,
          minimumScore: -1,
          limit: 10000,
        })
      : index!.chunks
          .filter(({ chunk }) =>
            chunk.permissionTags.some((t) => context.permissionTags.includes(t)),
          )
          .map(({ chunk, embedding }) => ({
            documentId: chunk.documentId,
            documentVersion: chunk.documentVersion,
            chunkId: chunk.chunkId,
            title: chunk.title,
            locator: chunk.locator,
            content: chunk.content,
            score: cosineSimilarity(vector, embedding),
          }));
    context.signal?.throwIfAborted();
    if (candidates.length !== visible.length) throw new RagError('RAG_INDEX_UNAVAILABLE');
    const expectedIds = new Set(visible.map((c) => c.chunkId));
    if (
      new Set(candidates.map((c) => c.chunkId)).size !== visible.length ||
      candidates.some((c) => !expectedIds.has(c.chunkId))
    )
      throw new RagError('RAG_EVIDENCE_INVALID');
    // Cache exact model items so budget checks use the same excerpts/metadata as generation.
    const prepared = new Map<string, DocumentSearchResult>();
    const prepare = ({ score: _score, ...c }: PersistentDocumentSearchCandidate) => {
      if (!prepared.has(c.chunkId))
        prepared.set(c.chunkId, {
          ...c,
          excerpt: extractVerbatimExcerpt(c.content, context.originalQuestion ?? input.query),
        });
      return prepared.get(c.chunkId)!;
    };
    const results = rankCandidates(
      candidates,
      views,
      this.embeddingProvider.mode,
      input.limit,
      this.minimumScore,
      resolveTopicRelations(m.sources, visible, context.originalQuestion ?? input.query),
      new Set(visible.filter((c) => c.resourceIds?.length).map((c) => c.chunkId)),
      (selection) =>
        evidenceTokenUpperBound(
          buildAssistantEvidenceBundle({
            query: input.query,
            evidenceSufficient: selection.length > 0,
            results: selection.map(prepare),
          }).items,
        ) <= this.policy.tokenBudget,
    ).map(prepare);
    const result = DocumentSearchOutputSchema.parse({
      query: input.query,
      evidenceSufficient: results.length > 0,
      results,
    });
    try {
      buildAssistantEvidenceBundle(result);
    } catch {
      throw new RagError('RAG_EVIDENCE_INVALID');
    }
    return result;
  }
}
