import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import * as contracts from '../packages/contracts/dist/index.js';
const path = new URL('../docs/architecture/openapi.yaml', import.meta.url);
const api = parse(await readFile(path, 'utf8'));
function schema(z) {
  const d = z._def;
  switch (d.typeName) {
    case 'ZodEffects':
      return schema(d.schema);
    case 'ZodDefault':
      return { ...schema(d.innerType), default: d.defaultValue() };
    case 'ZodOptional':
      return schema(d.innerType);
    case 'ZodNullable':
      return { ...schema(d.innerType), nullable: true };
    case 'ZodString': {
      const s = { type: 'string' };
      for (const c of d.checks) {
        if (c.kind === 'min') s.minLength = c.value;
        if (c.kind === 'max') s.maxLength = c.value;
        if (c.kind === 'regex') s.pattern = c.regex.source;
        if (c.kind === 'datetime') s.format = 'date-time';
        if (c.kind === 'uuid') s.format = 'uuid';
      }
      return s;
    }
    case 'ZodNumber': {
      const s = { type: d.checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of d.checks) {
        if (c.kind === 'min') {
          s.minimum = c.value;
          if (!c.inclusive) s.exclusiveMinimum = true;
        }
        if (c.kind === 'max') {
          s.maximum = c.value;
          if (!c.inclusive) s.exclusiveMaximum = true;
        }
      }
      return s;
    }
    case 'ZodDiscriminatedUnion':
      return { oneOf: d.options.map(schema) };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { type: typeof d.value, enum: [d.value] };
    case 'ZodEnum':
      return { type: 'string', enum: d.values };
    case 'ZodArray':
      return { type: 'array', items: schema(d.type) };
    case 'ZodObject': {
      const shape = d.shape(),
        required = Object.keys(shape).filter((k) => !shape[k].isOptional());
      return {
        type: 'object',
        ...(d.unknownKeys === 'strict' ? { additionalProperties: false } : {}),
        ...(required.length ? { required } : {}),
        properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, schema(v)])),
      };
    }
    default:
      throw new Error(`Unsupported schema: ${d.typeName}`);
  }
}
const names = [
  'DeliveryProfileInput',
  'DeliveryProfile',
  'SendReportRequest',
  'DeliveryRecord',
  'DeliveryListResponse',
  'DeliveryConfig',
  'ApprovalCommand',
  'ApprovalDetail',
  'ApprovalSummary',
  'ApprovalListResponse',
  'AssistantRequest',
  'AssistantAnswer',
  'DocumentResource',
  'ResourceAction',
  'Citation',
  'AssistantStreamEvent',
  'AssistantInterpretation',
  'SavedSettlementQuery',
  'SavedSettlementResponse',
  'MonthlyRefundMetricsRequest',
  'MonthlyRefundMetricsResponse',
  'GenerateMonthlyReportRequest',
  'GenerateMonthlyReportResponse',
  'ReportSummary',
  'ReportListResponse',
  'ArtistListResponse',
  'MonthlyReportDocument',
  'MonthlyReportContext',
  'MonthlyReportContextQuery',
  'CsvBatchUpload',
  'CsvBatch',
  'CsvBatchList',
  'MonthlySettlementPreviewRequest',
  'MonthlySettlementPreviewResponse',
];
for (const name of names) api.components.schemas[name] = schema(contracts[name + 'Schema']);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const response = (name, description) => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 410, 500, 503].map((code) => [
    code,
    response(
      'ErrorEnvelope',
      'ErrorEnvelope; report errors follow monthly-report-integration.zh-CN.md',
    ),
  ]),
);
const parameters = (z) =>
  Object.entries(schema(z).properties).map(([name, value]) => ({
    name,
    in: 'query',
    required: false,
    schema: value,
  }));
api.paths['/api/v1/artists'] = {
  get: {
    operationId: 'listReportArtists',
    summary: 'List artists within the trusted actor scope',
    parameters: parameters(contracts.ArtistListQuerySchema),
    responses: { 200: response('ArtistListResponse', 'Paginated artists'), ...errors },
  },
};
api.paths['/api/v1/reports'] = {
  post: {
    operationId: 'generateCurrentMonthReport',
    summary: 'Generate and save a draft report through server time',
    description:
      'Local integration uses an explicit server-side development identity on loopback. Production requires a trusted identity resolver. Month/asOf are never accepted from the browser.',
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 120 },
      },
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('GenerateMonthlyReportRequest') } },
    },
    responses: {
      201: response('GenerateMonthlyReportResponse', 'New saved report'),
      200: response('GenerateMonthlyReportResponse', 'Same request replay'),
      ...errors,
    },
  },
  get: {
    operationId: 'listSavedReports',
    summary: 'List saved reports in descending generatedAt and reportId order',
    parameters: parameters(contracts.ReportListQuerySchema),
    responses: { 200: response('ReportListResponse', 'Saved reports'), ...errors },
  },
};
const id = { name: 'reportId', in: 'path', required: true, schema: { type: 'string' } };
api.paths['/api/v1/deliveries/config'] = {
  get: {
    operationId: 'getDeliveryConfig',
    summary: 'Email channel and Taipei monthly schedule',
    responses: {
      200: response('DeliveryConfig', 'Configuration, not a live connectivity check'),
      ...errors,
    },
  },
};
api.paths['/api/v1/deliveries'] = {
  get: {
    operationId: 'listReportDeliveries',
    parameters: parameters(contracts.DeliveryListQuerySchema),
    responses: { 200: response('DeliveryListResponse', 'Paginated delivery history'), ...errors },
  },
  post: {
    operationId: 'sendApprovedReport',
    summary: 'Send one approved immutable PDF to its saved artist recipient',
    description:
      'Deduplicated by report version, recipient and channel. An existing sent/unknown/failed task is returned without another send. Sent means SMTP accepted, not confirmed inbox delivery.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('SendReportRequest') } },
    },
    responses: { 200: response('DeliveryRecord', 'Current delivery status'), ...errors },
  },
};
const artistParam = { name: 'artistId', in: 'path', required: true, schema: { type: 'string' } };
api.paths['/api/v1/deliveries/profiles/{artistId}'] = {
  get: {
    operationId: 'getArtistDeliveryProfile',
    parameters: [artistParam],
    responses: {
      200: response('DeliveryProfile', 'Artist recipient and automatic-send setting'),
      ...errors,
    },
  },
  put: {
    operationId: 'saveArtistDeliveryProfile',
    parameters: [artistParam],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('DeliveryProfileInput') } },
    },
    responses: {
      200: response('DeliveryProfile', 'Saved setting; automatic sending requires non-null email'),
      ...errors,
    },
  },
};
api.paths['/api/v1/deliveries/{deliveryId}/retry'] = {
  post: {
    operationId: 'retryFailedReportDelivery',
    summary: 'Retry a definitive failure; unknown outcomes cannot be replayed',
    parameters: [{ name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: response('DeliveryRecord', 'Delivery status'), ...errors },
  },
};
api.paths['/api/v1/approvals'] = {
  get: {
    operationId: 'listMonthlyReportApprovals',
    summary: 'List saved report versions by review status',
    parameters: parameters(contracts.ApprovalListQuerySchema),
    responses: { 200: response('ApprovalListResponse', 'Paginated review queue'), ...errors },
  },
};
api.paths['/api/v1/approvals/{reportId}'] = {
  get: {
    operationId: 'getMonthlyReportApproval',
    summary: 'Read saved snapshot, review status and audit history',
    parameters: [id],
    responses: { 200: response('ApprovalDetail', 'Version-specific approval'), ...errors },
  },
};
api.paths['/api/v1/approvals/{reportId}/actions'] = {
  post: {
    operationId: 'actOnMonthlyReportApproval',
    summary: 'Submit, approve or reject a saved report version',
    description:
      'Rejection requires a nonblank reason. requestId is an idempotency key per report version; reuse with different content returns 409. Only draft -> pending -> approved/rejected is allowed. Actor comes from server identity. Does not modify report JSON/PDF or execute payment.',
    parameters: [id],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('ApprovalCommand') } },
    },
    responses: {
      200: response('ApprovalDetail', 'Current status and history after action or replay'),
      ...errors,
    },
  },
};
api.paths['/api/v1/reports/{reportId}'] = {
  get: {
    operationId: 'getSavedReport',
    summary: 'Read saved report JSON without recalculating',
    parameters: [id],
    responses: { 200: response('MonthlyReportDocument', 'Saved report'), ...errors },
  },
};
api.paths['/api/v1/reports/{reportId}/download'] = {
  get: {
    operationId: 'downloadSavedReport',
    summary: 'Download private saved PDF',
    parameters: [id],
    responses: {
      200: {
        description: 'PDF attachment',
        content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
      },
      ...errors,
    },
  },
};
const batchId = {
  name: 'batchId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
api.paths['/api/v1/imports/batches'] = {
  post: {
    operationId: 'validateCsvBatch',
    summary: 'Save and validate a CSV batch without importing transactions',
    description:
      'Local Plan B workflow; login is intentionally not included. Maximum 500 KB / 1000 rows. The response may have FAILED status with persisted row errors. Reuploading identical contents with the same rate unit reuses the batch.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('CsvBatchUpload') } },
    },
    responses: {
      201: response('CsvBatch', 'Saved batch and validation result'),
      400: response('ErrorEnvelope', 'Invalid request'),
      413: response('ErrorEnvelope', 'CSV exceeds size limit'),
    },
  },
  get: {
    operationId: 'listCsvBatches',
    summary: 'List persisted CSV batches, newest first',
    parameters: parameters(contracts.CsvBatchListQuerySchema),
    responses: {
      200: response('CsvBatchList', 'Batch history'),
      400: response('ErrorEnvelope', 'Invalid filter or cursor'),
    },
  },
};
api.paths['/api/v1/imports/batches/{batchId}'] = {
  get: {
    operationId: 'getCsvBatch',
    summary: 'Read a saved batch, preview and row errors',
    parameters: [batchId],
    responses: {
      200: response('CsvBatch', 'Saved batch'),
      404: response('ErrorEnvelope', 'Batch not found'),
    },
  },
};
api.paths['/api/v1/imports/batches/{batchId}/confirm'] = {
  post: {
    operationId: 'confirmCsvBatch',
    summary: 'Revalidate saved input and atomically import a batch',
    parameters: [batchId],
    description:
      'Only batchId is accepted. No client-supplied records are trusted. A domain validation failure returns status FAILED and writes no transactions. Successful retries return the same saved result. New reports include committed transactions; previous report snapshots remain unchanged.',
    requestBody: {
      required: false,
      content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } },
    },
    responses: {
      200: response('CsvBatch', 'IMPORTED, or FAILED after revalidation'),
      400: response('ErrorEnvelope', 'Invalid request'),
      404: response('ErrorEnvelope', 'Batch not found'),
    },
  },
};

for (const [path, operationId] of [
  ['/api/v1/settlements/monthly-preview', 'previewMonthlySettlement'],
  ['/api/v1/assistant/tools/settlement.preview', 'invokeSettlementPreviewTool'],
]) {
  api.paths[path] = {
    post: {
      operationId,
      summary: 'Read artist/month data and calculate a settlement preview without saving',
      description:
        'Local Plan B read-only preview. artistId is an internal UUID returned by GET /artists. Current month uses server time in Asia/Taipei; earlier months use the full month; future months are rejected. dataCutoff is inclusive. M3 result.settlementPeriod.asOf for a closed month is the exclusive next-month boundary. No reports, tasks, PDFs or approval records are created.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('MonthlySettlementPreviewRequest') } },
      },
      responses: {
        200: response(
          'MonthlySettlementPreviewResponse',
          'Read-only M3 result with inclusive data cutoff',
        ),
        400: response('ErrorEnvelope', 'Invalid request or future month'),
        404: response('ErrorEnvelope', 'Artist not found'),
        503: response('ErrorEnvelope', 'Settlement data unavailable'),
      },
    },
  };
}
// Keep M5's JSON Schema aligned with the same Zod request and response as HTTP.
// OpenAPI 3.0 nullable becomes JSON Schema's union type for tool consumers.
function toolSchema(value) {
  if (Array.isArray(value)) return value.map(toolSchema);
  if (value === null || typeof value !== 'object') return value;
  const { nullable, ...rest } = value;
  const result = Object.fromEntries(
    Object.entries(rest).map(([key, item]) => [key, toolSchema(item)]),
  );
  if (nullable) result.type = [result.type, 'null'];
  return result;
}
const toolsPath = new URL('../packages/contracts/src/tool-schemas/tools.json', import.meta.url);
const tools = JSON.parse(await readFile(toolsPath, 'utf8'));
const preview = tools.find((tool) => tool.name === 'settlement.preview');
preview.description =
  'Read current database data for an artist and month and calculate a settlement preview. Uses POST /api/v1/assistant/tools/settlement.preview. Does not save reports or approvals. Current month is month-to-date in Asia/Taipei; future months are rejected. Unknown fees and payable amounts remain null.';
preview.input = toolSchema(schema(contracts.MonthlySettlementPreviewRequestSchema));
preview.output = toolSchema(schema(contracts.MonthlySettlementPreviewResponseSchema));
const saved = tools.find((tool) => tool.name === 'settlement.get');
saved.description =
  'Plan B: read the latest ready saved monthly report by artistId and settlementMonth using POST /api/v1/assistant/tools/settlement.get. Returns report:null when absent. Does not recalculate, create a report or infer approval status.';
saved.input = toolSchema(schema(contracts.SavedSettlementQuerySchema));
saved.output = toolSchema(schema(contracts.SavedSettlementResponseSchema));
let sales = tools.find((tool) => tool.name === 'sales.refunds');
if (!sales) {
  sales = { name: 'sales.refunds', readOnly: true, owner: 'A2/C5' };
  tools.push(sales);
}
sales.description =
  'Plan B monthly refund metrics: read canonical REFUND events for one artist and Taipei month. Returns item units, distinct source transaction count, record count and refunded amount. Does not calculate settlements or save reports. Current month is through server time; earlier months are complete. Uses POST /api/v1/assistant/tools/sales.refunds.';
sales.input = toolSchema(schema(contracts.MonthlyRefundMetricsRequestSchema));
sales.output = toolSchema(schema(contracts.MonthlyRefundMetricsResponseSchema));
await writeFile(toolsPath, JSON.stringify(tools, null, 2) + '\n');

api.paths['/api/v1/assistant'] = {
  post: {
    operationId: 'askAssistant',
    summary: 'Classify one request with GPT-5.4 nano and execute a read-only tool',
    description:
      'Optional bounded conversation history supports clarification. No client permissions or arbitrary tool calls. Requires server OPENAI_API_KEY. Saved report reads do not recalculate. SOP answers require validated source citations.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('AssistantRequest') } },
    },
    responses: {
      200: response('AssistantAnswer', 'Answer, clarification, refusal or tool error'),
      ...errors,
      502: response('ErrorEnvelope', 'Invalid model response'),
      504: response('ErrorEnvelope', 'Model timeout'),
    },
  },
};
api.paths['/api/v1/assistant/stream'] = {
  post: {
    operationId: 'streamAssistant',
    summary: 'Stream assistant progress and provisional SOP answer text over SSE',
    description:
      'POST with the same input as askAssistant. SSE data is an AssistantStreamEvent JSON object; event names are status, text_delta, final and error. Only final contains a validated answer with citations/results and replaces provisional text. A stream without final/error is incomplete. Disconnect cancels model work; no automatic retry or replay. Business answers are deterministic and delivered in final. Pre-stream failures use HTTP ErrorEnvelope; later failures use an error event. Comment heartbeats may occur.',
    requestBody: api.paths['/api/v1/assistant'].post.requestBody,
    responses: {
      200: {
        description: 'SSE events with JSON payloads described by AssistantStreamEvent',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
      ...errors,
    },
  },
};
api.paths['/api/v1/assistant/tools/settlement.get'] = {
  post: {
    operationId: 'readSavedSettlement',
    summary: 'Read the latest saved monthly report without calculating',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('SavedSettlementQuery') } },
    },
    responses: { 200: response('SavedSettlementResponse', 'Saved report or null'), ...errors },
  },
};
api.paths['/api/v1/assistant/tools/sales.refunds'] = {
  post: {
    operationId: 'readMonthlyRefundMetrics',
    summary:
      'Read monthly refund item units, transactions and amount without settlement calculation',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('MonthlyRefundMetricsRequest') } },
    },
    responses: {
      200: response(
        'MonthlyRefundMetricsResponse',
        'Refund event metrics; quantity is positive item units, transaction count is distinct sourceTransactionId',
      ),
      ...errors,
    },
  },
};
api.components.schemas.AssistantCitation = schema(contracts.CitationSchema);
api.paths['/api/v1/documents/assets/{assetId}'] = {
  get: {
    operationId: 'readRegisteredDocumentAsset',
    summary: 'View or download a registered SOP PDF or image in the current trusted scope',
    description:
      'Server-side asset whitelist and byte checksum validation. Local demo identity is permitted only outside production. No arbitrary paths or remote URL proxy. PDF contents are not necessarily indexed.',
    parameters: [
      {
        name: 'assetId',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^asset-[a-f0-9]{24}$' },
      },
      {
        name: 'action',
        in: 'query',
        required: true,
        schema: { type: 'string', enum: ['view', 'download'] },
      },
    ],
    responses: {
      200: {
        description:
          'Verified original bytes; inline or attachment Content-Disposition with original UTF-8 filename',
        content: {
          'application/pdf': { schema: { type: 'string', format: 'binary' } },
          'image/webp': { schema: { type: 'string', format: 'binary' } },
        },
      },
      ...Object.fromEntries(
        [400, 403, 404, 503].map((code) => [
          code,
          {
            description: 'Invalid, forbidden or unavailable resource. No filesystem path exposed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      required: ['code', 'message'],
                      properties: { code: { type: 'string' }, message: { type: 'string' } },
                    },
                  },
                  required: ['error'],
                },
              },
            },
          },
        ]),
      ),
    },
  },
};
api.paths['/api/v1/assistant/status'] = {
  get: {
    operationId: 'getAssistantStatus',
    summary:
      'Check model configuration and business runtime availability (not a live connectivity probe)',
    responses: {
      200: {
        description: 'Configured flag, model name and available intents',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['configured', 'model', 'availableIntents'],
              properties: {
                configured: { type: 'boolean' },
                model: { type: 'string' },
                availableIntents: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};
api.components.schemas.AssistantAnswer.properties.resourceFallback.description =
  'Optional metadata-only attachment fallback. Only for insufficient_evidence after successful documents.search. PDF contents must be unindexed; separate citations support file provenance, not contract clauses. Resource/citation IDs must be mutually bound.';
api.servers = [{ url: 'http://127.0.0.1:3119', description: 'Isolated local integration API' }];
await writeFile(path, stringify(api, { lineWidth: 100 }));
