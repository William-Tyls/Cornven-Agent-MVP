import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import {
  SourceStructureSchema,
  validateStructure,
  type SourceStructure,
} from './source-structure.js';

import { DocumentPermissionTagSchema, type DocumentPermissionTag } from '@cornven/contracts';

const ManifestEntrySchema = z.object({
  sourceId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  file: z.string().trim().min(1),
  sourceType: z.enum(['notion_docx_export', 'notion_html_snapshot']),
  structureFile: z.string().optional(),
  structureChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sourceUrl: z.string().url(),
  sourceVersion: z.string().trim().min(1),
  retrievalStatus: z.enum(['active', 'disabled']),
  contentStatus: z.string().trim().min(1),
  audience: z.enum(['staff_internal', 'creator_facing']),
  permissionTags: z.array(DocumentPermissionTagSchema).min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

const SourceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sourceFile: z.string().trim().min(1),
  documents: z.array(ManifestEntrySchema).min(1),
});

export interface SourceDocument {
  sourceId: string;
  title: string;
  sourceType: 'notion_docx_export' | 'notion_html_snapshot';
  structure?: SourceStructure;
  structureChecksum?: string;
  sourceUrl: string;
  sourceVersion: string;
  contentStatus: string;
  audience: 'staff_internal' | 'creator_facing';
  permissionTags: DocumentPermissionTag[];
  checksum: string;
  markdown: string;
}

export const defaultSourceManifestUrl = new URL(
  '../../../../../data/rag/sources.json',
  import.meta.url,
);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function loadDocumentSources(
  manifestUrl = defaultSourceManifestUrl,
): Promise<SourceDocument[]> {
  const manifestRootUrl = new URL('./', manifestUrl);
  const manifest = SourceManifestSchema.parse(JSON.parse(await readFile(manifestUrl, 'utf8')));
  const activeEntries = manifest.documents.filter((entry) => entry.retrievalStatus === 'active');

  return Promise.all(
    activeEntries.map(async (entry) => {
      const sourceUrl = new URL(entry.file, manifestRootUrl);
      if (!sourceUrl.href.startsWith(manifestRootUrl.href)) {
        throw new Error(`RAG source must stay inside data/rag: ${entry.file}`);
      }

      const markdown = await readFile(sourceUrl, 'utf8');
      const actualChecksum = sha256(markdown);
      if (actualChecksum !== entry.checksum) {
        throw new Error(
          `RAG source checksum mismatch for ${entry.sourceId}. Update the manifest after reviewing the content change.`,
        );
      }

      let structure: SourceStructure | undefined;
      if (entry.structureFile) {
        const location = new URL(entry.structureFile, manifestRootUrl);
        if (!location.href.startsWith(manifestRootUrl.href))
          throw new Error('Invalid structure path');
        const raw = await readFile(location, 'utf8');
        if (sha256(raw) !== entry.structureChecksum) throw new Error('Structure checksum mismatch');
        structure = SourceStructureSchema.parse(JSON.parse(raw));
        if (
          structure.sourceId !== entry.sourceId ||
          structure.sourceVersion !== entry.sourceVersion
        )
          throw new Error('Structure version mismatch');
        await validateStructure(structure, markdown);
      } else if (entry.sourceType === 'notion_html_snapshot')
        throw new Error('Missing HTML structure');
      return {
        ...(structure ? { structure, structureChecksum: entry.structureChecksum! } : {}),
        sourceId: entry.sourceId,
        title: entry.title,
        sourceType: entry.sourceType,
        sourceUrl: entry.sourceUrl,
        sourceVersion: entry.sourceVersion,
        contentStatus: entry.contentStatus,
        audience: entry.audience,
        permissionTags: entry.permissionTags,
        checksum: entry.checksum,
        markdown,
      };
    }),
  );
}
