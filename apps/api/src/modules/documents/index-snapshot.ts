import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RagError } from './rag-errors.js';
import type { DocumentIndexSnapshot } from './documents.service.js';
import type { DocumentChunk } from './chunker.js';
const defaultDirectory = fileURLToPath(
  new URL('../../../../../.local/rag-index/', import.meta.url),
);
export function snapshotPath(identity: string, directory = defaultDirectory): string {
  return resolve(directory, createHash('sha256').update(identity).digest('hex') + '.json');
}
export async function writeIndexSnapshot(
  snapshot: DocumentIndexSnapshot,
  directory?: string,
): Promise<void> {
  if (
    snapshot.chunks.some(
      ({ embedding }) =>
        embedding.length !== snapshot.embeddingProvider.dimensions ||
        embedding.some((v) => !Number.isFinite(v)) ||
        Math.abs(embedding.reduce((s, x) => s + x * x, 0) - 1) > 0.001,
    )
  )
    throw new RagError('RAG_EVIDENCE_INVALID');
  const path = snapshotPath(snapshot.identity, directory);
  const temp = path + '.' + randomUUID() + '.tmp';
  const payload = {
    identity: snapshot.identity,
    vectors: snapshot.chunks.map(({ chunk, embedding }) => ({ chunkId: chunk.chunkId, embedding })),
  };
  const body = JSON.stringify({
    ...payload,
    checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  });
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function readIndexSnapshot(
  identity: string,
  chunks: DocumentChunk[],
  dimensions: number,
  directory?: string,
): Promise<number[][]> {
  try {
    const value = z
      .object({
        identity: z.literal(identity),
        checksum: z.string(),
        vectors: z.array(
          z
            .object({
              chunkId: z.string(),
              embedding: z.array(z.number().finite()).length(dimensions),
            })
            .strict(),
        ),
      })
      .strict()
      .parse(JSON.parse(await readFile(snapshotPath(identity, directory), 'utf8')));
    if (
      value.checksum !==
      createHash('sha256')
        .update(JSON.stringify({ identity: value.identity, vectors: value.vectors }))
        .digest('hex')
    )
      throw new Error('Checksum mismatch');
    if (value.vectors.length !== chunks.length) throw new Error('Count mismatch');
    return value.vectors.map((v, i) => {
      if (
        v.chunkId !== chunks[i]!.chunkId ||
        Math.abs(v.embedding.reduce((n, x) => n + x * x, 0) - 1) > 0.001
      )
        throw new Error('Invalid vector');
      return v.embedding;
    });
  } catch {
    throw new RagError('RAG_INDEX_UNAVAILABLE');
  }
}
