import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  leadingEvidenceDecision,
  partialKnowledgeAnswer,
} from '../src/modules/assistant/knowledge-stream.js';
import {
  OpenAiAssistantModel,
  type AssistantModel,
} from '../src/modules/assistant/assistant-model.js';
import type { AssistantEvidenceBundle } from '../src/modules/documents/assistant-evidence.js';
import { createApp } from '../src/app.js';
import type { ReportRuntime } from '../src/modules/reporting/report-runtime.js';
import { createAssistantRouter } from '../src/modules/assistant/assistant.routes.js';
import express from 'express';
import { once } from 'node:events';

const evidence: AssistantEvidenceBundle = { query: '标签', evidenceSufficient: true, items: [] };
const result = {
  evidenceSufficient: true,
  citationIds: ['source'],
  answer: '标签需要名称。\n请核对 "编号" 😀 [1]',
};
const completed = (value: unknown) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  },
});
const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
function adapter(events: unknown[]) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            events.forEach((event) => c.enqueue(frame(event)));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  return { model: new OpenAiAssistantModel({ OPENAI_API_KEY: 'test' }, fetcher), fetcher };
}
const unknown = {
  intent: 'unknown' as const,
  slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: null },
  clarification: null,
};
const runtime = {
  repository: { db: {} },
  resolveActor: () => ({ id: 'test', artistIds: '*' }),
} as unknown as ReportRuntime;

describe('structured answer streaming', () => {
  it.each([
    JSON.stringify(result),
    '{"citationIds":["answer", "source"],"evidenceSufficient":true,"answer":"转义\\n\\"引号\\" \\uD83D\\uDE00 [1]"}',
  ])('extracts only the answer for every possible character boundary', (json) => {
    const answer = JSON.parse(json).answer as string;
    let previous = '';
    for (let i = 0; i <= json.length; i++) {
      const current = partialKnowledgeAnswer(json.slice(0, i));
      expect(current.startsWith(previous)).toBe(true);
      expect(answer.startsWith(current)).toBe(true);
      expect(/[\uD800-\uDBFF]$/.test(current)).toBe(false);
      previous = current;
    }
    expect(previous).toBe(answer);
  });
  it('delivers text before response.completed and requires the complete structured result', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const model = new OpenAiAssistantModel({ OPENAI_API_KEY: 'test' }, fetcher);
    const deltas: string[] = [];
    let settled = false;
    const answer = model
      .answerKnowledge('标签', evidence, { onTextDelta: (delta) => deltas.push(delta) })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(controller).toBeDefined());
    for (const delta of JSON.stringify(result))
      controller.enqueue(frame({ type: 'response.output_text.delta', delta }));
    await vi.waitFor(() => expect(deltas.join('')).toBe(result.answer));
    expect(settled).toBe(false);
    controller.enqueue(frame(completed(result)));
    expect(await answer).toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
      stream: true,
      model: 'gpt-5.4-nano',
      store: false,
    });
  });
  it.each(['eof', 'response.incomplete', 'response.failed', 'error', 'response.refusal.delta'])(
    'rejects %s after provisional text',
    async (type) => {
      const events: unknown[] = [
        {
          type: 'response.output_text.delta',
          delta: '{"evidenceSufficient":true,"citationIds":[],"answer":"临时',
        },
      ];
      if (type !== 'eof') events.push({ type });
      const { model } = adapter(events);
      const onTextDelta = vi.fn();
      await expect(model.answerKnowledge('标签', evidence, { onTextDelta })).rejects.toMatchObject({
        code: 'ASSISTANT_MODEL_INVALID',
      });
      expect(onTextDelta).toHaveBeenCalledWith('临时');
    },
  );
  it('propagates cancellation to provider fetch without translating it to a timeout', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const model = new OpenAiAssistantModel({ OPENAI_API_KEY: 'test' }, fetcher);
    const answer = model.classify({ message: '标签' }, '2026-09-20', { signal: controller.signal });
    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
describe('stream route', () => {
  it('validates input and runtime before starting SSE', async () => {
    expect(
      (await request(createApp()).post('/api/v1/assistant/stream').send({ message: '' })).status,
    ).toBe(400);
    expect(
      (await request(createApp()).post('/api/v1/assistant/stream').send({ message: 'hi' })).status,
    ).toBe(503);
  });
  it('emits status and a validated final or a sanitized error', async () => {
    for (const fail of [false, true]) {
      const model: AssistantModel = {
        configured: true,
        classify: async () => {
          if (fail) throw new Error('private secret');
          return unknown;
        },
        answerKnowledge: vi.fn(),
      };
      const response = await request(createApp(runtime, model))
        .post('/api/v1/assistant/stream')
        .send({ message: 'hi' });
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('event: status');
      expect(response.text).toContain(fail ? 'event: error' : 'event: final');
      expect(response.text).not.toContain('private secret');
    }
  });
  it('flushes progress while classification is pending, and aborts it on disconnect', async () => {
    let modelSignal: AbortSignal | undefined;
    const model: AssistantModel = {
      configured: true,
      classify: async (_request, _today, options) =>
        new Promise((_resolve, reject) => {
          modelSignal = options?.signal;
          modelSignal!.addEventListener('abort', () => reject(modelSignal!.reason), { once: true });
        }),
      answerKnowledge: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use('/assistant', createAssistantRouter(runtime, model));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/assistant/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
        signal: controller.signal,
      });
      const chunk = await response.body!.getReader().read();
      expect(new TextDecoder().decode(chunk.value)).toContain('正在理解问题');
      controller.abort();
      await vi.waitFor(() => expect(modelSignal?.aborted).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('decision-first streaming gate', () => {
  it.each([
    ['{"evidenceSufficient":tru', undefined],
    ['{"evidenceSufficient":true', undefined],
    ['{"evidenceSufficient":true,', true],
    [' { "evidenceSufficient" : false,', false],
    ['{"answer":"evidenceSufficient:true","evidenceSufficient":false}', undefined],
    ['{"nested":{"evidenceSufficient":true},"answer":"fake"}', undefined],
    ['{"evidenceSufficient":trueish,', undefined],
  ])('only recognizes a complete root decision: %s', (json, decision) => {
    expect(leadingEvidenceDecision(json as string)).toBe(decision);
  });
  it.each([true, false])(
    'never emits false-decision business text (decision first: %s)',
    async (first) => {
      const answer = '未经验证的合同条款';
      const value = first
        ? { evidenceSufficient: false, citationIds: [], answer }
        : { answer, evidenceSufficient: false, citationIds: [] };
      const events = [...JSON.stringify(value)].map((delta) => ({
        type: 'response.output_text.delta',
        delta,
      }));
      const { model } = adapter([...events, completed(value)]);
      const delta = vi.fn();
      expect(
        (await model.answerKnowledge('合同是怎样的？', evidence, { onTextDelta: delta }))
          .evidenceSufficient,
      ).toBe(false);
      expect(delta).not.toHaveBeenCalled();
    },
  );
  it('buffers out-of-order true until completion', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const model = new OpenAiAssistantModel({ OPENAI_API_KEY: 'test' }, fetcher);
    const delta = vi.fn();
    const pending = model.answerKnowledge('标签', evidence, { onTextDelta: delta });
    await vi.waitFor(() => expect(controller).toBeDefined());
    const value = { answer: '有据回答 [1]', citationIds: ['source'], evidenceSufficient: true };
    controller.enqueue(frame({ type: 'response.output_text.delta', delta: JSON.stringify(value) }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delta).not.toHaveBeenCalled();
    controller.enqueue(frame(completed(value)));
    await pending;
    expect(delta).toHaveBeenCalledExactlyOnceWith(value.answer);
  });
  it.each(['decision', 'text'])(
    'rejects completed %s inconsistent with the streamed draft',
    async (kind) => {
      const initial = { evidenceSufficient: true, citationIds: ['source'], answer: '临时文本 [1]' };
      const final =
        kind === 'decision'
          ? { ...initial, evidenceSufficient: false }
          : { ...initial, answer: '另一段文本 [1]' };
      const { model } = adapter([
        { type: 'response.output_text.delta', delta: JSON.stringify(initial) },
        completed(final),
      ]);
      const delta = vi.fn();
      await expect(
        model.answerKnowledge('标签', evidence, { onTextDelta: delta }),
      ).rejects.toMatchObject({ code: 'ASSISTANT_MODEL_INVALID' });
      expect(delta).toHaveBeenCalled();
    },
  );
  it('allows harmless answer whitespace without weakening consistency checks', async () => {
    const value = { evidenceSufficient: true, citationIds: ['source'], answer: '  有据回答 [1]  ' };
    const { model } = adapter([
      { type: 'response.output_text.delta', delta: JSON.stringify(value) },
      completed(value),
    ]);
    expect((await model.answerKnowledge('标签', evidence, { onTextDelta: vi.fn() })).answer).toBe(
      '有据回答 [1]',
    );
  });
});
