import { writeFile } from 'node:fs/promises';
import { loadDocumentSources } from './source-loader.ts';
import { chunkMarkdownDocument } from './chunker.ts';
const old = await loadDocumentSources(
  new URL('../../../../../.local/rag-source-backups/pre-html-v1/rag/sources.json', import.meta.url),
);
const current = await loadDocumentSources();
const chunks = current.flatMap((s) => chunkMarkdownDocument(s));
const norm = (x) =>
  x
    .replace(/^\d+\.\s+/gm, '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '');
const rows = old
  .flatMap((s) => chunkMarkdownDocument(s))
  .map((c) => {
    const oldBody = norm(c.content.split('\n\n').slice(1).join('\n\n'));
    const terms = oldBody.match(/.{1,32}/gu) ?? [];
    const matches = chunks
      .filter((n) => n.documentId === c.documentId)
      .map((n) => {
        const body = norm(n.content);
        return {
          chunkId: n.chunkId,
          locator: n.locator,
          matchedUnits: terms.filter((t) => body.includes(t)).length,
          exactBody: body.includes(oldBody),
        };
      })
      .filter((m) => m.exactBody || m.matchedUnits >= Math.max(1, Math.ceil(terms.length * 0.2)))
      .sort((a, b) => b.matchedUnits - a.matchedUnits);
    return {
      oldChunkId: c.chunkId,
      oldLocator: c.locator,
      documentId: c.documentId,
      status: matches.some((m) => m.exactBody)
        ? 'preserved-body-new-hierarchy'
        : matches.length
          ? 'restructured-overlap'
          : 'requires-review',
      newChunks: matches,
    };
  });
await writeFile(
  new URL('../../../../../.local/evidence/rag-locator-mapping.json', import.meta.url),
  JSON.stringify(
    {
      oldSources: old.map((s) => ({ id: s.sourceId, version: s.sourceVersion, hash: s.checksum })),
      newSources: current.map((s) => ({
        id: s.sourceId,
        version: s.sourceVersion,
        hash: s.checksum,
        structureHash: s.structureChecksum,
      })),
      note: 'Mapping by original body containment and 32-character text units, List marker numbering removed for comparison after manual review of four changed list sections; source order and factual numbers retained. Not proof of semantic equivalence. HTML source audit and position-image review remain separate.',
      rows,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    oldChunks: rows.length,
    newChunks: chunks.length,
    needsReview: rows
      .filter((r) => r.status === 'requires-review')
      .map((r) => ({ id: r.documentId, locator: r.oldLocator })),
  }),
);
