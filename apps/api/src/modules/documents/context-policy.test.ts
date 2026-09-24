import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DocumentSearchInputSchema, type DocumentSearchOutput } from '@cornven/contracts';
import { contextPolicy, assertEvidenceBudget, evidenceTokenUpperBound } from './context-policy.js';
import { buildAssistantEvidenceBundle } from './assistant-evidence.js';
import { rankCandidates } from './hybrid-retrieval.js';
import { OpenAiAssistantModel } from '../assistant/assistant-model.js';
import { answerWithSelectedEvidence, topKLiveOptions } from './evaluate-topk-live.js';
import { metrics } from './evaluate-quality.js';
import { lazyDocumentsService } from './documents.routes.js';

function evidence(count = 15): DocumentSearchOutput {
  return {
    query: '商品标签',
    evidenceSufficient: true,
    results: Array.from({ length: count }, (_, i) => {
      const locator = '标签' + i,
        content = '商品标签必须有商品代码 ' + i;
      return {
        documentId: 'sop',
        documentVersion: 'v1',
        title: '标签',
        locator,
        content,
        excerpt: content,
        chunkId: createHash('sha256').update(`sop\nv1\n${locator}\n${content}`).digest('hex'),
      };
    }),
  };
}
describe('bounded configurable evidence', () => {
  it('uses the user-selected Chatbot default of eight without changing the public search default', () => {
    expect(contextPolicy({})).toMatchObject({ topK: 8, tokenBudget: 16000 });
    expect(DocumentSearchInputSchema.parse({ query: 'x' }).limit).toBe(5);
  });
  it('supports public limit 15, retaining default 5 and rejecting 16', () => {
    expect(DocumentSearchInputSchema.parse({ query: 'x' }).limit).toBe(5);
    expect(DocumentSearchInputSchema.parse({ query: 'x', limit: 15 }).limit).toBe(15);
    expect(DocumentSearchInputSchema.safeParse({ query: 'x', limit: 16 }).success).toBe(false);
  });
  it.each(['0', '16', 'NaN', '5.5', '', ' 5', '1e1'])(
    'isolates invalid top-k %s',
    async (value) => {
      expect(() => contextPolicy({ RAG_TOP_K: value })).toThrow();
      const lazy = lazyDocumentsService({ RAG_TOP_K: value });
      expect((await lazy.status()).status).toBe('not_configured');
      await expect(
        lazy.search({ query: '标签', limit: 5 }, { permissionTags: ['staff'] }),
      ).rejects.toMatchObject({ code: 'RAG_CONFIG_INVALID' });
    },
  );
  it('rejects an invalid token budget and measures actual serialized metadata too', () => {
    expect(() => contextPolicy({ RAG_CONTEXT_TOKEN_BUDGET: '1023' })).toThrow();
    const items = buildAssistantEvidenceBundle(evidence()).items;
    const bytes = evidenceTokenUpperBound(items);
    expect(bytes).toBeGreaterThan(Buffer.byteLength(items.map((x) => x.verbatimContent).join('')));
    expect(() => assertEvidenceBudget(items, bytes)).not.toThrow();
    expect(() => assertEvidenceBudget(items, bytes - 1)).toThrow();
  });
  it('skips entire related and contradictory packages when the budget cannot hold both', () => {
    const candidates = evidence(2).results.map((r) => ({ ...r, score: 1 }));
    const ids = candidates.map((r) => r.chunkId);
    const selected = rankCandidates(
      candidates,
      ['商品标签'],
      'lexical_hash',
      15,
      undefined,
      new Map([
        [ids[0]!, [ids[1]!]],
        [ids[1]!, [ids[0]!]],
      ]),
      new Set(),
      (rows) => rows.length < 2,
    );
    expect(selected).toEqual([]);
    const contradictory = candidates.map((r, i) => ({
      ...r,
      content: i ? '商品标签不得公开。' : '商品标签必须公开。',
    }));
    expect(
      rankCandidates(
        contradictory,
        ['商品标签'],
        'lexical_hash',
        15,
        undefined,
        new Map(),
        new Set(),
        (rows) => rows.length < 2,
      ),
    ).toEqual([]);
  });
  it('accepts fifteen citations using the current evidence enum, and blocks oversize input before fetch', async () => {
    const bundle = buildAssistantEvidenceBundle(evidence());
    const result = {
      answer: '商品标签需有代码。[15]',
      evidenceSufficient: true,
      citationIds: bundle.items.map((i) => i.citation.chunkId),
    };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
            ],
          }),
        ),
    );
    const model = new OpenAiAssistantModel({ OPENAI_API_KEY: 'test' }, fetcher);
    expect(await model.answerKnowledge('标签', bundle)).toEqual(result);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.text.format.schema.properties.citationIds.maxItems).toBe(15);
    expect(body.text.format.schema.properties.citationIds.items.enum).toHaveLength(15);
    await expect(
      model.answerKnowledge('标签', buildAssistantEvidenceBundle(evidence(16))),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('validates and renumbers double digit references; rejects a dangling 16', async () => {
    const data = evidence();
    const model = {
      answerKnowledge: vi.fn(async () => ({
        answer: '商品标签需有代码。[10][15]',
        evidenceSufficient: true,
        citationIds: [data.results[9]!.chunkId, data.results[14]!.chunkId],
      })),
    };
    const result = await answerWithSelectedEvidence('标签', data, model);
    expect(result.response.outcome).toBe('answered');
    expect(result.response.answer).toContain('[1][2]');
    expect(result.response.citations).toHaveLength(2);
    model.answerKnowledge.mockResolvedValue({
      answer: '商品标签需有代码。[16]',
      evidenceSufficient: true,
      citationIds: [data.results[14]!.chunkId],
    });
    expect((await answerWithSelectedEvidence('标签', data, model)).response.outcome).toBe(
      'tool_error',
    );
  });
  it('does not generate on empty evidence and requires explicit new live budget', async () => {
    const model = { answerKnowledge: vi.fn() };
    expect(
      (
        await answerWithSelectedEvidence(
          '未知',
          { query: '未知', evidenceSufficient: false, results: [] },
          model,
        )
      ).response.outcome,
    ).toBe('insufficient_evidence');
    expect(model.answerKnowledge).not.toHaveBeenCalled();
    expect(() => topKLiveOptions([])).toThrow();
    expect(() => topKLiveOptions(['--allow-external', '--max-model-calls', '81'])).toThrow();
    expect(topKLiveOptions(['--allow-external', '--max-model-calls', '80']).maximum).toBe(80);
    expect(metrics([{ rank: 8, excerpt: true, verbatim: true }]).recall).toBe(0);
    expect(metrics([{ rank: 8, excerpt: true, verbatim: true }], 8).recall).toBe(1);
  });
});
