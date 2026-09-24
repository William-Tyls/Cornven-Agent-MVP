import { z } from 'zod';
import { RagError, abortable } from './rag-errors.js';
import { normalizeRetrievalText } from './retrieval-text.js';

import { DEFAULT_OPENAI_EMBEDDING_MODEL, RAG_EMBEDDING_DIMENSIONS } from '@cornven/contracts';

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly mode: 'lexical_hash' | 'semantic';
  embed(texts: string[], options?: { signal?: AbortSignal | undefined }): Promise<number[][]>;
}

const OpenAiEmbeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()),
    }),
  ),
});

const hanRunPattern = /^\p{Script=Han}+$/u;
const mixedTokenPattern = /\p{Script=Han}+|[a-z0-9]+/gu;

function normalizeText(value: string): string {
  return normalizeRetrievalText(value);
}

export function tokenizeForRetrieval(value: string): string[] {
  const normalized = normalizeText(value);
  const tokens: string[] = [];

  for (const match of normalized.matchAll(mixedTokenPattern)) {
    const token = match[0];
    if (hanRunPattern.test(token)) {
      hanRunPattern.lastIndex = 0;
      const characters = [...token];
      if (characters.length === 1) {
        tokens.push(token);
      }
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.push(characters.slice(index, index + 2).join(''));
      }
      for (let index = 0; index < characters.length - 2; index += 1) {
        tokens.push(characters.slice(index, index + 3).join(''));
      }
    } else if (token.length > 1) {
      tokens.push(token);
    }
  }

  return tokens;
}

function hash(value: string, seed: number): number {
  let result = (2_166_136_261 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619) >>> 0;
  }
  return result;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly mode = 'lexical_hash' as const;

  constructor(readonly dimensions = RAG_EMBEDDING_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 64) {
      throw new Error('Deterministic embedding dimensions must be an integer of at least 64.');
    }
    this.id = `deterministic-hash:${dimensions}`;
  }

  async embed(
    texts: string[],
    options?: { signal?: AbortSignal | undefined },
  ): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    return texts.map((text) => {
      const vector = Array.from<number>({ length: this.dimensions }).fill(0);
      for (const token of tokenizeForRetrieval(text)) {
        const index = hash(token, 0) % this.dimensions;
        const sign = hash(token, 17) % 2 === 0 ? 1 : -1;
        vector[index] = (vector[index] ?? 0) + sign;
      }
      return normalizeVector(vector);
    });
  }
}

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  endpoint?: string;
  fetcher?: typeof fetch;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly mode = 'semantic' as const;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiEmbeddingProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error('RAG_EMBEDDING_API_KEY is required for the OpenAI embedding provider.');
    }

    const model = (options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL).trim();
    if (!model) {
      throw new Error('RAG_EMBEDDING_MODEL must not be blank.');
    }

    const dimensions = options.dimensions ?? RAG_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('Embedding dimensions must be a positive integer.');
    }

    const endpointValue = options.endpoint ?? 'https://api.openai.com/v1/embeddings';
    let endpoint: URL;
    try {
      endpoint = new URL(endpointValue);
    } catch {
      throw new Error('RAG_EMBEDDING_ENDPOINT must be a valid HTTP or HTTPS URL.');
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('RAG_EMBEDDING_ENDPOINT must be a valid HTTP or HTTPS URL.');
    }

    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.endpoint = endpoint.toString();
    this.fetcher = options.fetcher ?? fetch;
    this.id = `openai:${this.model}:${this.dimensions}`;
  }

  async embed(
    texts: string[],
    options?: { signal?: AbortSignal | undefined },
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    options?.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(10000);
    const signal = AbortSignal.any([timeout, ...(options?.signal ? [options.signal] : [])]);
    let response: Response;
    try {
      response = await abortable(
        this.fetcher(this.endpoint, {
          signal,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            dimensions: this.dimensions,
            encoding_format: 'float',
          }),
        }),
        signal,
      );
    } catch {
      options?.signal?.throwIfAborted();
      throw new RagError(timeout.aborted ? 'RAG_PROVIDER_TIMEOUT' : 'RAG_PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) {
      throw new RagError('RAG_PROVIDER_UNAVAILABLE');
    }

    let parsed: z.infer<typeof OpenAiEmbeddingResponseSchema>;
    try {
      parsed = OpenAiEmbeddingResponseSchema.parse(await abortable(response.json(), signal));
    } catch {
      options?.signal?.throwIfAborted();
      throw new RagError(timeout.aborted ? 'RAG_PROVIDER_TIMEOUT' : 'RAG_PROVIDER_UNAVAILABLE');
    }
    const entries = [...parsed.data].sort((left, right) => left.index - right.index);
    if (entries.length !== texts.length) {
      throw new RagError('RAG_PROVIDER_UNAVAILABLE');
    }

    return entries.map((item, expectedIndex) => {
      if (item.index !== expectedIndex || item.embedding.length !== this.dimensions) {
        throw new RagError('RAG_PROVIDER_UNAVAILABLE');
      }
      if (item.embedding.every((value) => value === 0)) {
        throw new RagError('RAG_PROVIDER_UNAVAILABLE');
      }
      return normalizeVector(item.embedding);
    });
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('RAG_EMBEDDING_DIMENSIONS must be a positive integer.');
  }
  return parsed;
}

export function createEmbeddingProvider(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const provider = environment.RAG_EMBEDDING_PROVIDER ?? 'deterministic';
  const dimensions = positiveInteger(
    environment.RAG_EMBEDDING_DIMENSIONS,
    RAG_EMBEDDING_DIMENSIONS,
  );
  if (dimensions !== RAG_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `RAG_EMBEDDING_DIMENSIONS must be ${RAG_EMBEDDING_DIMENSIONS} to match the pgvector schema.`,
    );
  }

  if (provider === 'deterministic') {
    return new DeterministicEmbeddingProvider(dimensions);
  }
  if (provider === 'openai') {
    return new OpenAiEmbeddingProvider({
      apiKey: environment.RAG_EMBEDDING_API_KEY?.trim() || environment.OPENAI_API_KEY?.trim() || '',
      dimensions,
      ...(environment.RAG_EMBEDDING_MODEL ? { model: environment.RAG_EMBEDDING_MODEL } : {}),
      ...(environment.RAG_EMBEDDING_ENDPOINT
        ? { endpoint: environment.RAG_EMBEDDING_ENDPOINT }
        : {}),
    });
  }
  throw new Error(`Unsupported RAG_EMBEDDING_PROVIDER: ${provider}`);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error('Cannot compare embeddings with different dimensions.');
  }
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
