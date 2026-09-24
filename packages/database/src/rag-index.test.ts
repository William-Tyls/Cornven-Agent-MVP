import { describe, expect, it, vi } from 'vitest';

import { RAG_EMBEDDING_DIMENSIONS } from '@cornven/contracts';

import {
  getRagDocumentIndexStatus,
  readRagDocumentCorpus,
  replaceRagDocumentIndex,
  searchRagDocumentIndex,
  toPgVectorLiteral,
} from './rag-index.js';

describe('RAG vector persistence boundary', () => {
  it('serializes exactly 1024 finite dimensions for pgvector', () => {
    const literal = toPgVectorLiteral(
      Array.from(
        { length: RAG_EMBEDDING_DIMENSIONS },
        (_, index) => index / RAG_EMBEDDING_DIMENSIONS,
      ),
    );

    expect(literal.startsWith('[0,')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
  });

  it('rejects the wrong dimension and non-finite values', () => {
    expect(() => toPgVectorLiteral([1, 2, 3])).toThrow(/1024/);
    expect(() =>
      toPgVectorLiteral([...new Array<number>(RAG_EMBEDDING_DIMENSIONS - 1).fill(0), Number.NaN]),
    ).toThrow(/finite/);
  });

  it('builds a parameterized permission-filtered cosine query', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        documentId: 'creator-onboarding',
        documentVersion: 'v1',
        chunkId: 'a'.repeat(64),
        title: 'Creator onboarding',
        locator: 'Creator onboarding > Payment',
        content: 'Payment instructions',
        score: '0.75',
      },
    ]);
    const client = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof searchRagDocumentIndex
    >[0];

    const results = await searchRagDocumentIndex(
      client,
      new Array<number>(RAG_EMBEDDING_DIMENSIONS).fill(0),
      {
        embeddingModel: 'deterministic-hash:1024',
        permissionTags: ['staff'],
        minimumScore: 0.2,
        limit: 5,
      },
    );

    expect(results[0]?.score).toBe(0.75);
    expect(queryRaw).toHaveBeenCalledOnce();
    const statement = queryRaw.mock.calls[0]?.[0] as {
      strings: string[];
      values: unknown[];
    };
    expect(statement.strings.join(' ')).toContain('document."permissionTags" && ARRAY[');
    expect(statement.strings.join(' ')).toContain('chunk."embeddingModel" =');
    expect(statement.values).toContain('staff');
    expect(statement.values).toContain('deterministic-hash:1024');
    expect(statement.values).toContain(5);
  });

  it('does not query the database without server-approved permissions', async () => {
    const queryRaw = vi.fn();
    const client = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof searchRagDocumentIndex
    >[0];

    const results = await searchRagDocumentIndex(
      client,
      new Array<number>(RAG_EMBEDDING_DIMENSIONS).fill(0),
      {
        embeddingModel: 'deterministic-hash:1024',
        permissionTags: [],
        minimumScore: 0.2,
        limit: 5,
      },
    );
    const status = await getRagDocumentIndexStatus(client, 'deterministic-hash:1024', []);

    expect(results).toEqual([]);
    expect(status).toEqual({ indexedDocuments: 0, indexedChunks: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('disables managed documents that are no longer in the active source set', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      document: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({ id: 'document-1' }),
      },
      documentChunk: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(),
      },
      $executeRaw: vi.fn(),
    };
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<void>) =>
        callback(transaction),
      ),
    } as unknown as Parameters<typeof replaceRagDocumentIndex>[0];

    await replaceRagDocumentIndex(client, [
      {
        sourceId: 'active-source',
        title: 'Active source',
        sourceType: 'notion_docx_export',
        sourceUrl: 'https://example.test/active-source',
        sourceVersion: 'v1',
        contentStatus: 'approved',
        audience: 'staff_internal',
        checksum: 'a'.repeat(64),
        permissionTags: ['staff'],
        chunks: [],
      },
    ]);

    expect(transaction.document.updateMany).toHaveBeenCalledWith({
      where: {
        sourceType: { in: ['notion_docx_export', 'notion_html_snapshot'] },
        sourceId: { notIn: ['active-source'] },
      },
      data: { retrievalStatus: 'disabled' },
    });
    expect(transaction.document.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceId: 'active-source' },
        update: expect.objectContaining({ retrievalStatus: 'active' }),
      }),
    );
  });

  it('rejects unsafe database search bounds before executing SQL', async () => {
    const queryRaw = vi.fn();
    const client = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof searchRagDocumentIndex
    >[0];
    const vector = new Array<number>(RAG_EMBEDDING_DIMENSIONS).fill(0);

    await expect(
      searchRagDocumentIndex(client, vector, {
        embeddingModel: 'deterministic-hash:1024',
        permissionTags: ['staff'],
        minimumScore: 2,
        limit: 5,
      }),
    ).rejects.toThrow(/between -1 and 1/);
    await expect(
      searchRagDocumentIndex(client, vector, {
        embeddingModel: 'deterministic-hash:1024',
        permissionTags: ['staff'],
        minimumScore: 0.2,
        limit: 201,
      }),
    ).rejects.toThrow(/between 1 and 200/);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

it('fails explicitly when the authorized database snapshot exceeds 10000 chunks', async () => {
  const client = {
    $queryRaw: vi.fn().mockResolvedValue(Array.from({ length: 10001 }, () => ({ score: 0.5 }))),
  } as unknown as Parameters<typeof readRagDocumentCorpus>[0];
  await expect(
    readRagDocumentCorpus(client, [1, ...new Array<number>(1023).fill(0)], {
      embeddingModel: 'test',
      permissionTags: ['staff'],
      minimumScore: -1,
      limit: 10000,
    }),
  ).rejects.toThrow('RAG_CAPACITY_EXCEEDED');
});
