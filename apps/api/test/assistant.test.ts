import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  AssistantAnswerSchema,
  AssistantRequestSchema,
  type AssistantInterpretation,
} from '@cornven/contracts';
import {
  OpenAiAssistantModel,
  type AssistantModel,
} from '../src/modules/assistant/assistant-model.js';
import {
  AssistantService,
  type AssistantTools,
} from '../src/modules/assistant/assistant.service.js';
import { MonthlySettlementPreviewService } from '../src/modules/settlement/monthly-preview.service.js';
import { createApp } from '../src/app.js';
import { ReportError } from '../src/shared/report-errors.js';
import { createAssistantTools } from '../src/modules/assistant/assistant-tools.js';
import type { ReportRuntime } from '../src/modules/reporting/report-runtime.js';

const artist = {
  id: 'b9e0a2d0-a19e-4fef-b3ec-1f670f8836af',
  name: '小王',
  brandName: null,
  externalRef: 'ART-001',
};
const intent: AssistantInterpretation = {
  intent: 'settlement.preview',
  slots: { artistQuery: '小王', settlementMonth: '2026-09', knowledgeQuery: null },
  clarification: null,
};
function setup(value: AssistantInterpretation = intent) {
  const preview = new MonthlySettlementPreviewService(
    {
      getMonthlyReportContext: async () => ({
        artistId: artist.id,
        artistName: artist.name,
        brandName: null,
        sales: [],
        historicalRecords: [],
        rentals: [],
        inventory: null,
        bankTransferFeeCents: null,
      }),
    },
    () => new Date('2026-09-20T00:00:00Z'),
  );
  const model: AssistantModel = {
    configured: true,
    classify: vi.fn(async () => structuredClone(value)),
    answerKnowledge: vi.fn(),
  };
  const tools = {
    resolveArtists: vi.fn(async () => [artist]),
    searchSales: vi.fn<AssistantTools['searchSales']>(async () => ({
      artistId: artist.id,
      settlementMonth: '2026-09',
      dataCutoff: '2026-09-20T00:00:00.000Z',
      currency: 'TWD',
      refundQuantity: 7,
      refundTransactionCount: 2,
      refundRecordCount: 3,
      refundAmountCents: 123400,
    })),
    preview: vi.fn((artistId: string, settlementMonth: string) =>
      preview.preview({ artistId, settlementMonth }),
    ),
    getReport: vi.fn<AssistantTools['getReport']>(async () => null),
    searchDocuments: vi.fn<AssistantTools['searchDocuments']>(),
  };
  const service = new AssistantService(model, () => new Date('2026-09-19T16:01:00Z'));
  return {
    service,
    tools,
    model,
    answer: () => service.answer({ message: '帮我试算' }, 'test-request', tools),
  };
}
function evidence() {
  const content = '補貨前先核對產品清單。';
  const chunkId = createHash('sha256').update(`sop\nv1\n補貨\n${content}`).digest('hex');
  return {
    query: '補貨',
    evidenceSufficient: true,
    results: [
      {
        documentId: 'sop',
        documentVersion: 'v1',
        chunkId,
        title: '補貨 SOP',
        locator: '補貨',
        content,
        excerpt: content,
      },
    ],
  };
}
describe('assistant orchestration', () => {
  it.each([
    ['refund_quantity', '退款数量为 7 件'],
    ['refund_amount', '退款金额为'],
    ['refund_transactions', '共有 2 笔退款交易'],
  ] as const)(
    'answers only the requested %s metric without calculating a settlement',
    async (metric, text) => {
      const { answer, tools } = setup({
        ...intent,
        intent: 'sales.refunds',
        slots: { ...intent.slots, metric },
      });
      const result = await answer();
      expect(result.answer).toContain(text);
      expect(result.outcome).toBe('answered');
      expect(result.result).toBeUndefined();
      expect(result.toolCalls[0]?.tool).toBe('sales.refunds');
      expect(tools.searchSales).toHaveBeenCalledWith(artist.id, '2026-09');
      expect(tools.preview).not.toHaveBeenCalled();
      expect(tools.getReport).not.toHaveBeenCalled();
    },
  );
  it('asks which refund metric is wanted rather than showing a settlement', async () => {
    const { answer, tools } = setup({ ...intent, intent: 'sales.refunds' });
    expect((await answer()).outcome).toBe('needs_clarification');
    expect(tools.searchSales).not.toHaveBeenCalled();
    expect(tools.preview).not.toHaveBeenCalled();
  });
  it('preserves refund metric while asking for a missing year', async () => {
    const { answer, tools } = setup({
      ...intent,
      intent: 'sales.refunds',
      slots: { ...intent.slots, metric: 'refund_quantity', settlementMonth: null },
    });
    expect(await answer()).toMatchObject({
      outcome: 'needs_clarification',
      interpretation: { slots: { metric: 'refund_quantity' } },
    });
    expect(tools.searchSales).not.toHaveBeenCalled();
  });
  it('uses real M3 calculation after database name resolution and preserves unknown amounts', async () => {
    const { answer, tools, model } = setup();
    const result = AssistantAnswerSchema.parse(await answer());
    expect(tools.preview).toHaveBeenCalledWith(artist.id, '2026-09');
    expect(result.result).toMatchObject({
      kind: 'preview',
      data: {
        readOnly: true,
        result: { bankTransferFeeCents: null, amountPayableToCreatorCents: null },
      },
    });
    expect(result.answer).toContain('未保存');
    expect(tools.getReport).not.toHaveBeenCalled();
    expect(model.answerKnowledge).not.toHaveBeenCalled();
    expect(model.classify).toHaveBeenCalledWith({ message: '帮我试算' }, '2026-09-20', {
      signal: undefined,
    });
  });
  it.each(['artistQuery', 'settlementMonth'] as const)(
    'asks for absent %s even when model forgot clarification',
    async (field) => {
      const { answer, tools } = setup({ ...intent, slots: { ...intent.slots, [field]: null } });
      expect((await answer()).outcome).toBe('needs_clarification');
      expect(tools.resolveArtists).not.toHaveBeenCalled();
      expect(tools.preview).not.toHaveBeenCalled();
    },
  );
  it.each([0, 2])('does not choose an artist when %i matches exist', async (count) => {
    const { answer, tools } = setup();
    tools.resolveArtists.mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({ ...artist, externalRef: `ART-00${i}` })),
    );
    expect((await answer()).outcome).toBe('needs_clarification');
    expect(tools.preview).not.toHaveBeenCalled();
  });
  it.each(['unsupported', 'unknown'] as const)('does not run tools for %s', async (name) => {
    const { answer, tools } = setup({ ...intent, intent: name });
    expect((await answer()).outcome).toBe(
      name === 'unsupported' ? 'refused' : 'needs_clarification',
    );
    for (const tool of Object.values(tools)) expect(tool).not.toHaveBeenCalled();
  });
  it('does not calculate when a saved report is absent', async () => {
    const { answer, tools } = setup({ ...intent, intent: 'settlement.get' });
    expect((await answer()).answer).toContain('没有已保存');
    expect(tools.getReport).toHaveBeenCalledWith(artist.id, '2026-09');
    expect(tools.preview).not.toHaveBeenCalled();
  });
  it('returns future-month validation without generating anything', async () => {
    const { answer } = setup({ ...intent, slots: { ...intent.slots, settlementMonth: '2027-01' } });
    expect(await answer()).toMatchObject({
      outcome: 'tool_error',
      toolCalls: [{ execution: { errorCode: 'TOOL_ARGUMENTS_INVALID' } }],
    });
  });
  it('preserves bounded clarification history for the next model turn', async () => {
    const { service, tools, model } = setup();
    const history = [
      { role: 'user' as const, content: '帮我试算小王' },
      { role: 'assistant' as const, content: '哪个年月？' },
    ];
    await service.answer({ message: '2026年9月', history }, 'test-request', tools);
    expect(model.classify).toHaveBeenCalledWith({ message: '2026年9月', history }, '2026-09-20', {
      signal: undefined,
    });
  });
  it('returns safe tool failures without leaking raw errors', async () => {
    const { answer, tools } = setup();
    tools.preview.mockRejectedValue(new Error('postgres-password-secret'));
    const response = await answer();
    expect(response.outcome).toBe('tool_error');
    expect(JSON.stringify(response)).not.toContain('postgres-password-secret');
  });
  it('rejects invented tools before executing anything', async () => {
    const { answer, model, tools } = setup();
    vi.mocked(model.classify).mockResolvedValue({
      ...intent,
      intent: 'sql.execute',
    } as unknown as AssistantInterpretation);
    await expect(answer()).rejects.toThrow();
    expect(tools.resolveArtists).not.toHaveBeenCalled();
  });
  const ragIntent = {
    ...intent,
    intent: 'documents.search' as const,
    slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: '補貨' },
  };
  it('searches the original SOP question when classification omits only keywords', async () => {
    const { service, tools, model } = setup({
      ...ragIntent,
      slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: null },
    });
    const message = '改价申请最快几分钟可以批复？';
    tools.searchDocuments.mockResolvedValue({
      query: message,
      evidenceSufficient: false,
      results: [],
    });
    const result = await service.answer({ message }, 'missing-keywords', tools);
    expect(result.outcome).toBe('insufficient_evidence');
    expect(tools.searchDocuments).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ originalQuestion: message }),
    );
    expect(model.answerKnowledge).not.toHaveBeenCalled();
    expect(tools.preview).not.toHaveBeenCalled();
  });
  it('renders only citations verified against retrieved passages', async () => {
    const { answer, tools, model } = setup(ragIntent);
    tools.searchDocuments.mockResolvedValue(evidence());
    vi.mocked(model.answerKnowledge).mockResolvedValue({
      answer: '先核對產品清單。[1]',
      evidenceSufficient: true,
      citationIds: [evidence().results[0]!.chunkId],
    });
    expect(await answer()).toMatchObject({
      outcome: 'answered',
      citations: [{ excerpt: '補貨前先核對產品清單。' }],
    });
    expect(tools.preview).not.toHaveBeenCalled();
  });
  it('renumbers retrieved source markers to the displayed citation subset', async () => {
    const { answer, tools, model } = setup(ragIntent);
    const data = evidence();
    const second = {
      ...data.results[0]!,
      locator: '標籤',
      content: '商品標籤必須列出售價。',
      excerpt: '商品標籤必須列出售價。',
    };
    second.chunkId = createHash('sha256')
      .update(`sop\nv1\n${second.locator}\n${second.content}`)
      .digest('hex');
    data.results.push(second);
    tools.searchDocuments.mockResolvedValue(data);
    vi.mocked(model.answerKnowledge).mockResolvedValue({
      answer: '標籤列出售價。[2]',
      evidenceSufficient: true,
      citationIds: [second.chunkId],
    });
    expect(await answer()).toMatchObject({
      outcome: 'answered',
      answer: '標籤列出售價。[1]',
      citations: [{ chunkId: second.chunkId }],
    });
  });
  it.each(['不受支持的標籤。[5]', '沒有引用標記'])(
    'rejects missing or out-of-range source markers: %s',
    async (text) => {
      const { answer, tools, model } = setup(ragIntent);
      tools.searchDocuments.mockResolvedValue(evidence());
      vi.mocked(model.answerKnowledge).mockResolvedValue({
        answer: text,
        evidenceSufficient: true,
        citationIds: [evidence().results[0]!.chunkId],
      });
      expect(await answer()).toMatchObject({ outcome: 'tool_error', citations: [] });
    },
  );
  it.each(['empty', 'insufficient', 'fabricated', 'tampered'])(
    'handles %s evidence safely',
    async (mode) => {
      const { answer, tools, model } = setup(ragIntent);
      const data = evidence();
      if (mode === 'empty') {
        data.results = [];
        data.evidenceSufficient = false;
      }
      if (mode === 'tampered') data.results[0]!.content += 'tampered';
      tools.searchDocuments.mockResolvedValue(data);
      vi.mocked(model.answerKnowledge).mockResolvedValue({
        answer: 'Unsupported claim',
        evidenceSufficient: mode !== 'insufficient',
        citationIds: ['invented'],
      });
      const result = await answer();
      expect(result.outcome).toBe(
        ['empty', 'insufficient'].includes(mode) ? 'insufficient_evidence' : 'tool_error',
      );
      expect(result.citations).toEqual([]);
      if (['empty', 'tampered'].includes(mode))
        expect(model.answerKnowledge).not.toHaveBeenCalled();
    },
  );
});
describe('OpenAI structured adapter', () => {
  const response = (value: unknown) =>
    new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
        ],
      }),
      { status: 200 },
    );
  it('uses the exact selected model and strict Responses format without storing inputs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(intent));
    const model = new OpenAiAssistantModel({ OPENAI_API_KEY: 'test-only' }, fetcher);
    expect(await model.classify({ message: '试算2026年9月' }, '2026-09-20')).toEqual(intent);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      model: 'gpt-5.4-nano',
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body.instructions).toContain('bare month without a year');
  });
  it('clears a model-invented year when the user only supplied a bare month', async () => {
    const model = new OpenAiAssistantModel(
      { OPENAI_API_KEY: 'test-only' },
      vi.fn<typeof fetch>(async () => response(intent)),
    );
    const output = await model.classify({ message: '帮我试算小王9月' }, '2026-09-20');
    expect(output.slots.settlementMonth).toBeNull();
    expect(output.clarification?.missingFields).toContain('settlementMonth');
  });
  it.each(['今年9月', '本月', 'last month', '2026年9月'])(
    'keeps dates with explicit year evidence: %s',
    async (month) => {
      const model = new OpenAiAssistantModel(
        { OPENAI_API_KEY: 'test-only' },
        vi.fn<typeof fetch>(async () => response(intent)),
      );
      expect(
        (await model.classify({ message: `帮我试算小王 ${month}` }, '2026-09-20')).slots
          .settlementMonth,
      ).toBe('2026-09');
    },
  );
  it('accepts a year established by prior conversation', async () => {
    const model = new OpenAiAssistantModel(
      { OPENAI_API_KEY: 'test-only' },
      vi.fn<typeof fetch>(async () => response(intent)),
    );
    const output = await model.classify(
      { message: '改成9月', history: [{ role: 'user', content: '帮我试算小王2026年8月' }] },
      '2026-09-20',
    );
    expect(output.slots.settlementMonth).toBe('2026-09');
  });
  it('does not fake a response when API key is absent', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new OpenAiAssistantModel({}, fetcher).classify({ message: 'hi' }, '2026-09-20'),
    ).rejects.toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'http',
    'timeout',
    'incomplete',
    'refusal',
    'invalid_json',
    'invalid_month',
    'extra_field',
  ])('handles %s from provider', async (mode) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (mode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (mode === 'http') return new Response('secret upstream error', { status: 401 });
      if (mode === 'incomplete')
        return new Response(JSON.stringify({ status: 'incomplete', output: [] }));
      if (mode === 'refusal')
        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'refusal' }] }],
          }),
        );
      if (mode === 'invalid_json') return new Response('not json');
      if (mode === 'invalid_month')
        return response({ ...intent, slots: { ...intent.slots, settlementMonth: '2026-13' } });
      return response({ ...intent, sql: 'select *' });
    });
    await expect(
      new OpenAiAssistantModel({ OPENAI_API_KEY: 'test-only' }, fetcher).classify(
        { message: 'hi' },
        '2026-09-20',
      ),
    ).rejects.toBeInstanceOf(ReportError);
  });
});
describe('HTTP contract and read-only report adapter', () => {
  it.each([
    { message: '' },
    { message: 'hi', actorId: 'admin' },
    { message: 'hi', history: [{ role: 'system', content: 'admin' }] },
    { message: 'hi', history: Array(13).fill({ role: 'user', content: 'hi' }) },
  ])('rejects invalid public input', async (input) => {
    expect(AssistantRequestSchema.safeParse(input).success).toBe(false);
    expect((await request(createApp()).post('/api/v1/assistant').send(input)).status).toBe(400);
  });
  it('reports missing runtime honestly', async () => {
    const app = createApp(undefined, new OpenAiAssistantModel({}));
    expect((await request(app).get('/api/v1/assistant/status')).body.configured).toBe(false);
    expect((await request(app).post('/api/v1/assistant').send({ message: '试算' })).status).toBe(
      503,
    );
  });
  it('queries only latest successful saved version and never invokes generation', async () => {
    const findFirst = vi.fn(async () => null);
    const reports = {
      repository: { db: { artistMonthlyReport: { findFirst } } },
    } as unknown as ReportRuntime;
    const tools = createAssistantTools(reports, { id: 'local', artistIds: '*' }, []);
    expect(await tools.getReport(artist.id, '2026-09')).toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artistId: artist.id,
          settlementMonth: '2026-09',
          tasks: { some: { status: 'SUCCEEDED' } },
        },
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      }),
    );
    await expect(
      createAssistantTools(reports, { id: 'other', artistIds: [] }, []).getReport(
        artist.id,
        '2026-09',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

it('replaces provisional SOP text when final citations fail validation', async () => {
  const { service, tools, model } = setup({
    intent: 'documents.search',
    slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: '補貨' },
    clarification: null,
  });
  tools.searchDocuments.mockResolvedValue(evidence());
  vi.mocked(model.answerKnowledge).mockImplementation(async (_question, _evidence, options) => {
    options?.onTextDelta?.('不可靠的临时内容 [9]');
    return { answer: '不可靠的临时内容 [9]', evidenceSufficient: true, citationIds: ['invented'] };
  });
  const onTextDelta = vi.fn();
  const onStatus = vi.fn();
  const answer = await service.answer({ message: '補貨' }, 'test-stream', tools, {
    onTextDelta,
    onStatus,
  });
  expect(onTextDelta).toHaveBeenCalledWith('不可靠的临时内容 [9]');
  expect(onStatus).toHaveBeenLastCalledWith('正在校验回答与引用…');
  expect(answer.outcome).toBe('tool_error');
  expect(answer.answer).not.toContain('不可靠');
  expect(answer.citations).toEqual([]);
});

describe('enhanced RAG compatibility', () => {
  const sopIntent: AssistantInterpretation = {
    intent: 'documents.search',
    slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: '商品标签' },
    clarification: null,
  };
  it.each([
    ['RAG_CONFIG_INVALID', 503],
    ['RAG_INDEX_UNAVAILABLE', 503],
    ['RAG_PROVIDER_UNAVAILABLE', 503],
    ['RAG_PROVIDER_TIMEOUT', 504],
    ['RAG_EVIDENCE_INVALID', 502],
  ] as const)('maps %s to safe tool errors', async (code, status) => {
    const { service, tools, model } = setup(sopIntent);
    tools.searchDocuments.mockRejectedValue(new ReportError(status, code, '知识服务暂不可用'));
    const result = await service.answer({ message: '价签上必须写什么' }, 'rag-error', tools);
    expect(result.outcome).toBe('tool_error');
    expect(result.toolCalls[0]?.execution.status).toBe(status === 504 ? 'timed_out' : 'failed');
    expect(model.answerKnowledge).not.toHaveBeenCalled();
  });
  it('preserves the original qualifier and abort signal through document retrieval', async () => {
    const { service, tools } = setup(sopIntent);
    tools.searchDocuments.mockResolvedValue({
      query: '商品标签',
      evidenceSufficient: false,
      results: [],
    });
    const controller = new AbortController();
    await service.answer({ message: '没有预约补货会怎样' }, 'rag-options', tools, {
      signal: controller.signal,
    });
    expect(tools.searchDocuments).toHaveBeenCalledWith('商品标签', {
      originalQuestion: '没有预约补货会怎样',
      signal: controller.signal,
    });
  });
  it('does not retain provisional facts when completion says insufficient evidence', async () => {
    const { service, tools, model } = setup(sopIntent);
    tools.searchDocuments.mockResolvedValue(evidence());
    vi.mocked(model.answerKnowledge).mockImplementation(async (_q, _e, options) => {
      options?.onTextDelta?.('未验证的金额');
      return { answer: '资料不足', evidenceSufficient: false, citationIds: [] };
    });
    const delta = vi.fn();
    const result = await service.answer({ message: '费用多少' }, 'rag-partial', tools, {
      onTextDelta: delta,
    });
    expect(delta).toHaveBeenCalled();
    expect(result.outcome).toBe('insufficient_evidence');
    expect(result.answer).not.toContain('未验证的金额');
    expect(result.citations).toEqual([]);
  });
  it('cancellation during retrieval prevents generation', async () => {
    const { service, tools, model } = setup(sopIntent);
    const controller = new AbortController();
    tools.searchDocuments.mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      service.answer({ message: '价签' }, 'rag-cancel', tools, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.answerKnowledge).not.toHaveBeenCalled();
  });
});

it('a broken RAG configuration does not route settlement work into documents', async () => {
  vi.stubEnv('RAG_EMBEDDING_PROVIDER', 'invalid-test-provider');
  try {
    const { answer, tools, model } = setup();
    expect((await answer()).outcome).toBe('answered');
    expect(tools.preview).toHaveBeenCalledOnce();
    expect(tools.searchDocuments).not.toHaveBeenCalled();
    expect(model.answerKnowledge).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
