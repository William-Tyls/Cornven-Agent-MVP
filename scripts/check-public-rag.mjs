import assert from 'node:assert/strict';
import { DocumentsService } from '../apps/api/dist/modules/documents/documents.service.js';
const service = new DocumentsService({ environment: {} });
const index = await service.getIndex();
assert.equal(index.sources.length, 1);
assert.equal(index.sources[0].sourceId, 'public-demo');
assert.ok(index.chunks.length > 0);
const result = await service.search(
  { query: 'CSV import', limit: 8 },
  { permissionTags: ['staff'] },
);
assert.ok(result.results.some((r) => r.locator.includes('CSV import')));
assert.ok(result.results.every((r) => r.documentId === 'public-demo'));
assert.equal(
  (await service.search({ query: 'CSV import', limit: 8 }, { permissionTags: [] })).results.length,
  0,
);
console.log(
  'Synthetic public RAG source, retrieval and permission checks passed. No model requests.',
);
