import { afterEach, describe, expect, it, vi } from 'vitest';
import { askAssistant, assistantHistoryContent, streamAssistant } from './assistant';
afterEach(() => vi.unstubAllGlobals());
describe('assistant client', () => {
  it('sends actual message and clarification history and validates response', async () => {
    const result = {
      requestId: 'test',
      outcome: 'needs_clarification',
      answer: '哪个年月？',
      citations: [],
      toolCalls: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    const input = {
      message: '帮我试算小王',
      history: [{ role: 'user' as const, content: '结算试算' }],
    };
    expect(await askAssistant(input)).toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(input);
  });
  it('rejects malformed responses instead of rendering invented data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answer: 'fake' }))),
    );
    await expect(askAssistant({ message: 'hello' })).rejects.toThrow();
  });
});

it('keeps follow-up intent context without sending returned financial results back to the model', () => {
  const context = assistantHistoryContent({
    requestId: 'test',
    outcome: 'answered',
    answer: '退款金额为 NT$123,456',
    citations: [],
    toolCalls: [],
    interpretation: {
      intent: 'sales.refunds',
      slots: {
        artistQuery: 'Sample Creator A',
        settlementMonth: '2026-09',
        metric: 'refund_amount',
        knowledgeQuery: null,
      },
      clarification: null,
    },
  });
  expect(context).not.toContain('123,456');
  expect(JSON.parse(context)).toMatchObject({
    intent: 'sales.refunds',
    slots: { metric: 'refund_amount', settlementMonth: '2026-09' },
  });
});

describe('stream client', () => {
  const final = {
    requestId: 'stream',
    outcome: 'needs_clarification',
    answer: '请提供月份',
    citations: [],
    toolCalls: [],
  };
  function mock(events: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
  }
  it('delivers ordered updates and returns only the authoritative final answer', async () => {
    mock([
      { type: 'status', message: '检索中' },
      { type: 'text_delta', delta: '临时文字' },
      { type: 'final', answer: final },
    ]);
    const event = vi.fn();
    expect(await streamAssistant({ message: 'hi' }, event)).toEqual(final);
    expect(event.mock.calls.map(([item]) => item.type)).toEqual(['status', 'text_delta', 'final']);
  });
  it('does not accept a disconnected partial answer', async () => {
    mock([{ type: 'text_delta', delta: '临时文字' }]);
    await expect(streamAssistant({ message: 'hi' }, vi.fn())).rejects.toThrow('连接已中断');
  });
  it('rejects terminal errors and malformed final results', async () => {
    mock([{ type: 'error', code: 'FAIL', message: '校验失败', requestId: 'stream' }]);
    await expect(streamAssistant({ message: 'hi' }, vi.fn())).rejects.toThrow('校验失败');
    mock([{ type: 'final', answer: { ...final, outcome: 'invented' } }]);
    await expect(streamAssistant({ message: 'hi' }, vi.fn())).rejects.toThrow();
  });
});
