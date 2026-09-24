import { type AssistantAnswer, type DocumentResource } from '@cornven/contracts';
import { loadDocumentSources, type SourceDocument } from './source-loader.js';
import { chunkMarkdownDocument } from './chunker.js';
import { RagError } from './rag-errors.js';
export async function enrichDocumentCitations(
  citations: AssistantAnswer['citations'],
  load = loadDocumentSources,
) {
  const sources = await load();
  const resources = new Map<string, DocumentResource>();
  const enriched = citations.map((citation) => {
    const source = sources.find((s) => s.sourceId === citation.documentId);
    // Isolated synthetic evaluation sources have no production resource registry.
    if (!source?.structure) return citation;
    if (source.sourceVersion !== citation.documentVersion)
      throw new RagError('RAG_EVIDENCE_INVALID');
    const chunk = chunkMarkdownDocument(source).find((c) => c.chunkId === citation.chunkId);
    if (!chunk || chunk.locator !== citation.locator || !chunk.content.includes(citation.excerpt))
      throw new RagError('RAG_EVIDENCE_INVALID');
    for (const id of new Set(chunk.resourceIds ?? [])) {
      const matches = source.structure.resources.filter(
        (r) => r.resourceId === id && chunk.blockIds?.includes(r.blockId),
      );
      if (!matches.length) throw new RagError('RAG_EVIDENCE_INVALID');
      const r = matches[0]!;
      const old = resources.get(id);
      if (old) {
        if (!old.citationChunkIds.includes(chunk.chunkId)) old.citationChunkIds.push(chunk.chunkId);
        continue;
      }
      const actions: DocumentResource['actions'] =
        r.availability === 'local'
          ? [
              {
                kind: 'view',
                label: r.kind === 'pdf' ? '查看 PDF' : '查看原图',
                url: `/api/v1/documents/assets/${r.assetId}?action=view`,
              },
              {
                kind: 'download',
                label: r.kind === 'pdf' ? '下载 PDF' : '下载图片',
                url: `/api/v1/documents/assets/${r.assetId}?action=download`,
              },
            ]
          : r.originalUrl
            ? [
                {
                  kind: 'visit',
                  label: r.originalUrl.includes('docs.google.com/spreadsheets')
                    ? '打开表格'
                    : '访问页面',
                  url: r.originalUrl,
                },
              ]
            : [{ kind: 'visit', label: '查看来源', url: r.sourcePageUrl }];
      resources.set(id, {
        resourceId: id,
        label: r.label,
        kind: r.kind,
        citationChunkIds: [chunk.chunkId],
        contentIndexed: r.contentIndexed,
        availability: r.availability,
        actions,
      });
    }
    const block = source.structure.blocks.find((b) => chunk.blockIds?.includes(b.blockId));
    return { ...citation, sourceUrl: block?.sourceUrl ?? source.sourceUrl };
  });
  return { citations: enriched, resources: [...resources.values()] };
}
export function findRegisteredAsset(sources: SourceDocument[], id: string, permissions: string[]) {
  for (const s of sources) {
    if (!s.permissionTags.some((t) => permissions.includes(t))) continue;
    const resource = s.structure?.resources.find(
      (r) => r.assetId === id && r.availability === 'local',
    );
    if (resource) return resource;
  }
  return undefined;
}
