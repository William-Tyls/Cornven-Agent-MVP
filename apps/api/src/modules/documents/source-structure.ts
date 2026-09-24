import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SourceResourceSchema = z
  .object({
    resourceId: z.string().min(1),
    blockId: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['web', 'pdf', 'image']),
    sourcePageUrl: z.string().url().startsWith('https://'),
    originalUrl: z.string().url().startsWith('https://').optional(),
    availability: z.enum(['external', 'local', 'missing']),
    contentIndexed: z.boolean(),
    assetId: z
      .string()
      .regex(/^asset-[a-f0-9]{24}$/)
      .optional(),
    assetHash: hash.optional(),
    assetFile: z
      .string()
      .regex(/^[a-f0-9]{64}\.(pdf|webp)$/)
      .optional(),
    filename: z
      .string()
      .min(1)
      .refine((x) => !x.includes('/') && !/[\\\r\n]/.test(x))
      .optional(),
    mimeType: z.enum(['application/pdf', 'image/webp']).optional(),
  })
  .strict();
export const SourceStructureSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: z.string(),
    sourceVersion: z.string(),
    markdownHash: hash,
    extractorVersion: z.string(),
    cacheKey: hash,
    snapshotHash: hash,
    snapshotFile: z.string(),
    reviewStatus: z.literal('reviewed'),
    blocks: z.array(
      z
        .object({
          blockId: z.string(),
          parentBlockId: z.string().nullable(),
          headingPath: z.array(z.string()),
          contentKind: z.string(),
          text: z.string(),
          renderedText: z.string(),
          sourceUrl: z.string().url().startsWith('https://'),
          reviewStatus: z.enum(['reviewed', 'retained_legacy']),
          resourceIds: z.array(z.string()),
          assetHash: hash.optional(),
        })
        .passthrough(),
    ),
    sections: z.array(
      z
        .object({
          headingPath: z.array(z.string()).min(1),
          body: z.string().min(1),
          blockIds: z.array(z.string()).min(1),
          contentKind: z.enum(['text', 'table', 'image-transcription']),
          resourceIds: z.array(z.string()),
        })
        .strict(),
    ),
    resources: z.array(SourceResourceSchema),
    images: z.array(
      z.object({
        blockId: z.string(),
        reference: z.string(),
        status: z.enum(['reviewed_transcription', 'excluded_by_user_review', 'decorative']),
        reason: z.string(),
      }),
    ),
    tables: z.array(z.unknown()),
    toggles: z.array(z.unknown()),
    links: z.array(z.unknown()),
    legacyOnlyTables: z.array(z.string()),
    coverageBoundary: z.string(),
  })
  .strict();
export type SourceStructure = z.infer<typeof SourceStructureSchema>;
export type SourceResource = z.infer<typeof SourceResourceSchema>;
export const assetRoot = fileURLToPath(
  new URL('../../../../../.local/rag-assets/', import.meta.url),
);
export const contentHash = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');
export async function readRegisteredAsset(
  resource: SourceResource,
  root = assetRoot,
): Promise<Buffer> {
  if (
    resource.availability !== 'local' ||
    !resource.assetId ||
    !resource.assetHash ||
    !resource.assetFile ||
    !resource.filename ||
    !resource.mimeType
  )
    throw new Error('Incomplete asset registration');
  if (
    resource.assetId !== 'asset-' + resource.assetHash.slice(0, 24) ||
    resource.assetFile !== resource.assetHash + (resource.kind === 'pdf' ? '.pdf' : '.webp')
  )
    throw new Error('Asset identity mismatch');
  const path = await realpath(resolve(root, resource.assetFile));
  if (!path.startsWith((await realpath(root)) + sep))
    throw new Error('Asset outside allowed directory');
  const data = await readFile(path);
  if (contentHash(data) !== resource.assetHash) throw new Error('Asset checksum mismatch');
  if (
    resource.kind === 'pdf'
      ? data.subarray(0, 5).toString() !== '%PDF-'
      : data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WEBP'
  )
    throw new Error('Invalid asset type');
  return data;
}
export async function validateStructure(meta: SourceStructure, markdown: string): Promise<void> {
  const blocks = new Map(meta.blocks.map((b) => [b.blockId, b]));
  if (blocks.size !== meta.blocks.length || contentHash(markdown) !== meta.markdownHash)
    throw new Error('Invalid source structure');
  const ids = new Set(meta.resources.map((x) => x.resourceId));
  for (const b of meta.blocks) {
    if (b.parentBlockId && !blocks.has(b.parentBlockId)) throw new Error('Missing parent block');
    if (
      b.text &&
      !markdown.includes(b.text) &&
      !b.text.split('\n').every((t) => markdown.includes(t))
    ) {
      // Lists and table cells have explicit serialization; the offline audit checks normalized coverage.
      if (
        ![
          'numbered_list',
          'bulleted_list',
          'table',
          'collection_view',
          'column',
          'column_list',
        ].includes(b.contentKind)
      )
        throw new Error('Missing reviewed block text');
    }
    if (
      b.contentKind === 'image-transcription' &&
      (!b.assetHash ||
        !meta.resources.some(
          (x) => x.blockId === b.blockId && x.assetHash === b.assetHash && x.contentIndexed,
        ))
    )
      throw new Error('Unverified transcription');
  }
  for (const section of meta.sections) {
    if (
      !markdown.includes(section.body) ||
      section.blockIds.some((id) => !blocks.has(id)) ||
      section.resourceIds.some((id) => !ids.has(id))
    )
      throw new Error('Invalid semantic section');
  }
  for (const resource of meta.resources) {
    if (!blocks.has(resource.blockId)) throw new Error('Unbound resource');
    if (resource.availability === 'external' && !resource.originalUrl)
      throw new Error('Missing external URL');
    if (resource.availability === 'local') await readRegisteredAsset(resource);
  }
}
