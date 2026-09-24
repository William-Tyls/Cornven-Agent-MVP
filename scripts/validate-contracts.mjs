import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const openApiText = await readFile(
  new URL('../docs/architecture/openapi.yaml', import.meta.url),
  'utf8',
);
const openApi = parse(openApiText);

const composeText = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const migrationText = await readFile(
  new URL(
    '../packages/database/prisma/migrations/20260904000000_initial_pos_alignment/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const ragMigrationText = await readFile(
  new URL(
    '../packages/database/prisma/migrations/20260907000000_rag_document_index/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const ragEmbeddingMigrationText = await readFile(
  new URL(
    '../packages/database/prisma/migrations/20260912000000_rag_embedding_1024/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const prismaSchemaText = await readFile(
  new URL('../packages/database/prisma/schema.prisma', import.meta.url),
  'utf8',
);
const documentContractText = await readFile(
  new URL('../packages/contracts/src/documents.ts', import.meta.url),
  'utf8',
);

if (openApi.openapi !== '3.0.3') {
  throw new Error('OpenAPI contract must use version 3.0.3.');
}

if (!composeText.includes('pgvector/pgvector:pg15')) {
  throw new Error('Local database image must stay aligned with client PostgreSQL 15.');
}

for (const requiredConstraint of [
  'RawPosRecord_shape_check',
  'Rental_commission_range_check',
  'Sale_positive_quantity_check',
  'Sale_amounts_check',
  'SettlementRuleVersion_rate_range_check',
  'SettlementRun_amounts_check',
]) {
  if (!migrationText.includes(requiredConstraint)) {
    throw new Error(`Database migration is missing required constraint: ${requiredConstraint}`);
  }
}

for (const requiredMigrationFragment of [
  'CREATE EXTENSION IF NOT EXISTS vector',
  '"unitPriceCents" BIGINT',
  '"grossSalesCents" BIGINT',
  '"amountPayableCents" BIGINT',
  '"businessTimezone" TEXT',
]) {
  if (!migrationText.includes(requiredMigrationFragment)) {
    throw new Error(`Database migration is missing: ${requiredMigrationFragment}`);
  }
}

for (const requiredRagMigrationFragment of [
  'vector(256)',
  'Document_sourceId_key',
  'Document_permissionTags_gin_idx',
  'DocumentChunk_embedding_hnsw_idx',
  'DocumentChunk_embedding_dimensions_check',
]) {
  if (!ragMigrationText.includes(requiredRagMigrationFragment)) {
    throw new Error(`RAG database migration is missing: ${requiredRagMigrationFragment}`);
  }
}

for (const requiredEmbeddingMigrationFragment of [
  'vector(1024)',
  "'pending_reindex'",
  'DocumentChunk_embedding_hnsw_idx',
  'DocumentChunk_embedding_dimensions_check',
]) {
  if (!ragEmbeddingMigrationText.includes(requiredEmbeddingMigrationFragment)) {
    throw new Error(
      `RAG 1024-dimension migration is missing: ${requiredEmbeddingMigrationFragment}`,
    );
  }
}

if (!prismaSchemaText.includes('Unsupported("vector(1024)")')) {
  throw new Error('Prisma schema must use the selected 1024-dimension RAG vector.');
}

for (const requiredEmbeddingContractFragment of [
  'RAG_EMBEDDING_DIMENSIONS = 1_024',
  "DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large'",
]) {
  if (!documentContractText.includes(requiredEmbeddingContractFragment)) {
    throw new Error(`RAG embedding contract is missing: ${requiredEmbeddingContractFragment}`);
  }
}

const requiredPaths = [
  '/api/v1/health',
  '/api/v1/artists',
  '/api/v1/reports',
  '/api/v1/reports/{reportId}',
  '/api/v1/reports/{reportId}/download',
  '/api/v1/imports/mock/normalize',
  '/api/v1/imports/batches',
  '/api/v1/imports/batches/{batchId}',
  '/api/v1/imports/batches/{batchId}/confirm',
  '/api/v1/settlements/preview',
  '/api/v1/settlements/monthly-preview',
  '/api/v1/assistant/tools/settlement.preview',
  '/api/v1/assistant/tools',
  '/api/v1/assistant',
  '/api/v1/documents/status',
  '/api/v1/documents/search',
];

for (const path of requiredPaths) {
  if (!openApi.paths?.[path]) {
    throw new Error(`OpenAPI contract is missing required path: ${path}`);
  }
}

if (!openApi.paths['/api/v1/assistant']?.post) {
  throw new Error('OpenAPI contract is missing the Assistant POST operation.');
}

const toolText = await readFile(
  new URL('../packages/contracts/src/tool-schemas/tools.json', import.meta.url),
  'utf8',
);
const tools = JSON.parse(toolText);
const toolNames = tools.map((tool) => tool.name);
const uniqueToolNames = new Set(toolNames);

if (uniqueToolNames.size !== toolNames.length) {
  throw new Error('Agent Tool Schema contains duplicate tool names.');
}

for (const requiredTool of [
  'sales.search',
  'artist.get',
  'settlement.preview',
  'settlement.get',
  'approval.status',
  'documents.search',
]) {
  if (!toolNames.includes(requiredTool)) {
    throw new Error(`Tool contract is missing: ${requiredTool}`);
  }
}

const settlementPreviewTool = tools.find((tool) => tool.name === 'settlement.preview');
if (
  JSON.stringify(settlementPreviewTool?.input?.required) !==
    JSON.stringify(['artistId', 'settlementMonth']) ||
  settlementPreviewTool?.input?.additionalProperties !== false
) {
  throw new Error('settlement.preview must accept only artistId and settlementMonth.');
}
for (const requiredField of [
  'artistId',
  'settlementMonth',
  'calculatedAt',
  'dataCutoff',
  'readOnly',
  'result',
]) {
  if (!settlementPreviewTool?.output?.properties?.[requiredField]) {
    throw new Error(`settlement.preview output is missing: ${requiredField}`);
  }
}
for (const requiredField of [
  'creator',
  'creatorRevenueShareAmountCents',
  'amountPayableToCreatorCents',
  'rentals',
  'lowStockReminder',
]) {
  if (!settlementPreviewTool?.output?.properties?.result?.properties?.[requiredField]) {
    throw new Error(`settlement.preview M3 result is missing: ${requiredField}`);
  }
}

const documentSearchTool = tools.find((tool) => tool.name === 'documents.search');
for (const requiredField of ['query', 'evidenceSufficient', 'results']) {
  if (!documentSearchTool?.output?.properties?.[requiredField]) {
    throw new Error(`documents.search output is missing: ${requiredField}`);
  }
}
if (!documentSearchTool?.input?.properties?.limit) {
  throw new Error('documents.search input is missing: limit');
}
if (documentSearchTool?.input?.properties?.query?.maxLength !== 4_000) {
  throw new Error('documents.search query must accept the full Assistant message length.');
}
const documentSearchResult = documentSearchTool?.output?.properties?.results?.items;
for (const requiredCitationField of [
  'documentId',
  'documentVersion',
  'chunkId',
  'title',
  'locator',
  'excerpt',
  'content',
]) {
  if (!documentSearchResult?.properties?.[requiredCitationField]) {
    throw new Error(`documents.search result is missing: ${requiredCitationField}`);
  }
}
if (documentSearchResult?.properties?.excerpt?.maxLength !== 480) {
  throw new Error('documents.search excerpt must be limited to 480 verbatim characters.');
}

const assistantCitation = openApi.components?.schemas?.AssistantCitation;
if (
  !assistantCitation?.required?.includes('excerpt') ||
  assistantCitation?.properties?.excerpt?.maxLength !== 480
) {
  throw new Error('Assistant citations must include a 480-character verbatim excerpt field.');
}

const forbiddenWriteWords = ['approve', 'reject', 'delete', 'update'];
for (const name of toolNames) {
  if (forbiddenWriteWords.some((word) => name.includes(word))) {
    throw new Error(`Agent tool must remain read-only in the prototype: ${name}`);
  }
}

for (const tool of tools) {
  if (tool.readOnly !== true) {
    throw new Error(`Agent tool must declare readOnly=true: ${tool.name}`);
  }

  if (!tool.owner || !tool.description) {
    throw new Error(`Agent tool must declare an owner and description: ${tool.name}`);
  }

  for (const boundary of ['input', 'output']) {
    if (tool[boundary]?.type !== 'object' || !tool[boundary]?.properties) {
      throw new Error(`Agent tool ${tool.name} must declare an object ${boundary} schema.`);
    }

    const propertyNames = new Set(Object.keys(tool[boundary].properties));
    for (const requiredName of tool[boundary].required ?? []) {
      if (!propertyNames.has(requiredName)) {
        throw new Error(
          `Agent tool ${tool.name} ${boundary} requires missing property: ${requiredName}`,
        );
      }
    }
  }
}

const operationIds = [];
for (const pathItem of Object.values(openApi.paths ?? {})) {
  for (const operation of Object.values(pathItem ?? {})) {
    if (operation && typeof operation === 'object' && 'operationId' in operation) {
      operationIds.push(operation.operationId);
    }
  }
}

if (new Set(operationIds).size !== operationIds.length) {
  throw new Error('OpenAPI operationId values must be unique.');
}

console.log(
  `Validated OpenAPI (${requiredPaths.length} required paths) and ${tools.length} tools.`,
);
