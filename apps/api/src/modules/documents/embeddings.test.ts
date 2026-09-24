import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPENAI_EMBEDDING_MODEL, RAG_EMBEDDING_DIMENSIONS } from '@cornven/contracts';

import { createEmbeddingProvider, OpenAiEmbeddingProvider } from './embeddings.js';

const dimensions = RAG_EMBEDDING_DIMENSIONS;

function vector(...values: Array<[number, number]>): number[] {
  const result = Array.from<number>({ length: dimensions }).fill(0);
  for (const [index, value] of values) {
    result[index] = value;
  }
  return result;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAI embedding provider boundary', () => {
  it('sends the configured request and restores provider results to input order', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) =>
      jsonResponse({
        data: [
          { index: 1, embedding: vector([1, 3], [2, 4]) },
          { index: 0, embedding: vector([0, 2]) },
        ],
      }),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: ' test-secret ',
      model: 'test-model',
      dimensions,
      endpoint: 'https://embeddings.example.test/v1/embed',
      fetcher,
    });

    const result = await provider.embed(['first', 'second']);

    expect(result[0]?.[0]).toBe(1);
    expect(result[1]?.[1]).toBeCloseTo(0.6);
    expect(result[1]?.[2]).toBeCloseTo(0.8);
    expect(fetcher).toHaveBeenCalledOnce();

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://embeddings.example.test/v1/embed');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'test-model',
      input: ['first', 'second'],
      dimensions,
      encoding_format: 'float',
    });
  });

  it('returns an empty result without making a provider request', async () => {
    const fetcher = vi.fn();
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test-secret',
      fetcher: fetcher as typeof fetch,
    });

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects duplicate or missing response indices instead of misaligning source chunks', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: vector([0, 1]) },
          { index: 0, embedding: vector([1, 1]) },
        ],
      }),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test-secret',
      dimensions,
      fetcher: fetcher as typeof fetch,
    });

    await expect(provider.embed(['first', 'second'])).rejects.toMatchObject({
      code: 'RAG_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects an unexpected dimension and an unusable zero vector', async () => {
    const wrongDimensionProvider = new OpenAiEmbeddingProvider({
      apiKey: 'test-secret',
      dimensions,
      fetcher: vi.fn(async () =>
        jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
      ) as typeof fetch,
    });
    const zeroVectorProvider = new OpenAiEmbeddingProvider({
      apiKey: 'test-secret',
      dimensions,
      fetcher: vi.fn(async () =>
        jsonResponse({ data: [{ index: 0, embedding: vector() }] }),
      ) as typeof fetch,
    });

    await expect(wrongDimensionProvider.embed(['source'])).rejects.toMatchObject({
      code: 'RAG_PROVIDER_UNAVAILABLE',
    });
    await expect(zeroVectorProvider.embed(['source'])).rejects.toMatchObject({
      code: 'RAG_PROVIDER_UNAVAILABLE',
    });
  });

  it('reports provider failures without exposing the API key or response body', async () => {
    const apiKey = 'private-test-secret';
    const provider = new OpenAiEmbeddingProvider({
      apiKey,
      fetcher: vi.fn(async () => jsonResponse({ error: { message: apiKey } }, 401)) as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['source']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ code: 'RAG_PROVIDER_UNAVAILABLE', status: 503 });
    expect(String(caught)).not.toContain(apiKey);
  });

  it('sanitises network errors before they leave the provider boundary', async () => {
    const apiKey = 'private-network-secret';
    const provider = new OpenAiEmbeddingProvider({
      apiKey,
      fetcher: vi.fn(async () => {
        throw new Error(`transport included ${apiKey}`);
      }) as typeof fetch,
    });

    let caught: unknown;
    try {
      await provider.embed(['source']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'RAG_PROVIDER_UNAVAILABLE', status: 503 });
    expect(String(caught)).not.toContain(apiKey);
  });

  it('rejects invalid model, dimension, endpoint, and missing-key configuration', () => {
    expect(() => new OpenAiEmbeddingProvider({ apiKey: ' ' })).toThrow(/API_KEY/);
    expect(() => new OpenAiEmbeddingProvider({ apiKey: 'key', model: ' ' })).toThrow(/MODEL/);
    expect(() => new OpenAiEmbeddingProvider({ apiKey: 'key', dimensions: 0 })).toThrow(
      /positive integer/,
    );
    expect(
      () => new OpenAiEmbeddingProvider({ apiKey: 'key', endpoint: 'file:///tmp/embed' }),
    ).toThrow(/HTTP or HTTPS/);
  });

  it('keeps the database vector dimension fixed when configured through the environment', () => {
    expect(() =>
      createEmbeddingProvider({
        RAG_EMBEDDING_PROVIDER: 'openai',
        RAG_EMBEDDING_API_KEY: 'key',
        RAG_EMBEDDING_DIMENSIONS: '256',
      }),
    ).toThrow(/must be 1024/);
  });

  it('defaults the approved OpenAI provider to the Large model and 1024 dimensions', () => {
    const provider = createEmbeddingProvider({
      RAG_EMBEDDING_PROVIDER: 'openai',
      RAG_EMBEDDING_API_KEY: 'key',
    });

    expect(provider.id).toBe(`openai:${DEFAULT_OPENAI_EMBEDDING_MODEL}:${dimensions}`);
    expect(provider.dimensions).toBe(dimensions);
  });
  it('falls back to the shared server key and prefers a nonblank dedicated key', () => {
    expect(
      createEmbeddingProvider({ RAG_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: ' shared ' }),
    ).toMatchObject({ apiKey: 'shared' });
    expect(
      createEmbeddingProvider({
        RAG_EMBEDDING_PROVIDER: 'openai',
        RAG_EMBEDDING_API_KEY: ' ',
        OPENAI_API_KEY: ' shared ',
      }),
    ).toMatchObject({ apiKey: 'shared' });
    expect(
      createEmbeddingProvider({
        RAG_EMBEDDING_PROVIDER: 'openai',
        RAG_EMBEDDING_API_KEY: ' dedicated ',
        OPENAI_API_KEY: 'shared',
      }),
    ).toMatchObject({ apiKey: 'dedicated' });
    expect(() =>
      createEmbeddingProvider({ RAG_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: ' ' }),
    ).toThrow();
  });
});
