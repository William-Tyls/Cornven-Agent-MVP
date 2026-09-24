import {
  assertEvidenceBudget,
  contextPolicy,
  MAX_RAG_PASSAGES,
  modelReferences,
} from '../documents/context-policy.js';
import { readSseData } from '@cornven/contracts';
import { leadingEvidenceDecision, partialKnowledgeAnswer } from './knowledge-stream.js';
import { KNOWLEDGE_SYSTEM_PROMPT } from './knowledge-prompt.js';
import { INTENT_SYSTEM_PROMPT } from './intent-prompt.js';
import { z } from 'zod';
import {
  AssistantInterpretationSchema,
  type AssistantInterpretation,
  type AssistantRequest,
} from '@cornven/contracts';
import type { AssistantEvidenceBundle } from '../documents/assistant-evidence.js';
import { ReportError } from '../../shared/report-errors.js';

export interface KnowledgeAnswer {
  answer: string;
  evidenceSufficient: boolean;
  citationIds: string[];
}
export interface AssistantModelOptions {
  signal?: AbortSignal | undefined;
  onTextDelta?: (delta: string) => void;
}
export interface AssistantModel {
  readonly configured: boolean;
  classify(
    request: AssistantRequest,
    today: string,
    options?: AssistantModelOptions,
  ): Promise<AssistantInterpretation>;
  answerKnowledge(
    question: string,
    evidence: AssistantEvidenceBundle,
    options?: AssistantModelOptions,
  ): Promise<KnowledgeAnswer>;
}
const nullableText = { type: ['string', 'null'] };
export const intentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'slots', 'clarification'],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'sales.refunds',
        'settlement.preview',
        'settlement.get',
        'documents.search',
        'unsupported',
        'unknown',
      ],
    },
    slots: {
      type: 'object',
      additionalProperties: false,
      required: ['artistQuery', 'settlementMonth', 'knowledgeQuery', 'metric'],
      properties: {
        artistQuery: nullableText,
        settlementMonth: nullableText,
        knowledgeQuery: nullableText,
        metric: {
          type: ['string', 'null'],
          enum: ['refund_quantity', 'refund_amount', 'refund_transactions', null],
        },
      },
    },
    clarification: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['missingFields', 'question'],
          properties: {
            missingFields: {
              type: 'array',
              items: { type: 'string', enum: ['artistQuery', 'settlementMonth', 'intent'] },
            },
            question: { type: 'string' },
          },
        },
      ],
    },
  },
};
const KnowledgeAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(3500),
    evidenceSufficient: z.boolean(),
    citationIds: z.array(z.string().min(1)).max(MAX_RAG_PASSAGES),
  })
  .strict();
const knowledgeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceSufficient', 'citationIds', 'answer'],
  properties: {
    evidenceSufficient: { type: 'boolean' },
    citationIds: { type: 'array', items: { type: 'string' } },
    answer: { type: 'string' },
  },
};

export class OpenAiAssistantModel implements AssistantModel {
  readonly configured: boolean;
  private readonly apiKey: string;
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly knowledgePrompt: string = KNOWLEDGE_SYSTEM_PROMPT,
  ) {
    this.apiKey = environment.OPENAI_API_KEY?.trim() ?? '';
    this.configured = this.apiKey.length > 0;
  }
  private async structured(
    name: string,
    schema: object,
    instructions: string,
    input: unknown,
    options: AssistantModelOptions = {},
  ): Promise<unknown> {
    if (!this.configured)
      throw new ReportError(
        503,
        'ASSISTANT_NOT_CONFIGURED',
        'Chatbot 尚未配置模型密钥，请在服务器 .env 配置 OPENAI_API_KEY 后重启。',
      );
    try {
      const response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.any([
          AbortSignal.timeout(25000),
          ...(options.signal ? [options.signal] : []),
        ]),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4-nano',
          store: false,
          ...(options.onTextDelta ? { stream: true } : {}),
          reasoning: { effort: 'low' },
          instructions,
          input: JSON.stringify(input),
          max_output_tokens: 2000,
          text: { format: { type: 'json_schema', name, strict: true, schema } },
        }),
      });
      if (!response.ok)
        throw new ReportError(
          503,
          'ASSISTANT_MODEL_UNAVAILABLE',
          '模型服务暂时不可用，请稍后重试或检查服务器 API 配置。',
        );
      let payload: unknown;
      let streamedJson = '';
      let emitted = '';
      let streamDecision: boolean | undefined;
      if (options.onTextDelta) {
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
          throw new Error('Missing provider stream');

        for await (const data of readSseData(response.body)) {
          options.signal?.throwIfAborted();
          const event = JSON.parse(data) as { type: string; delta?: string; response?: unknown };
          if (event.type === 'response.output_text.delta') {
            if (typeof event.delta !== 'string') throw new Error('Invalid delta');
            streamedJson += event.delta;
            if (streamedJson.length > 32_000) throw new Error('Model output too large');
            streamDecision = leadingEvidenceDecision(streamedJson);
            if (streamDecision === true) {
              const answer = partialKnowledgeAnswer(streamedJson);
              if (!answer.startsWith(emitted)) throw new Error('Non-monotonic answer');
              if (answer.length > emitted.length) options.onTextDelta(answer.slice(emitted.length));
              emitted = answer;
            }
          } else if (event.type === 'response.completed') {
            payload = event.response;
            break;
          } else if (
            [
              'error',
              'response.failed',
              'response.incomplete',
              'response.refusal.delta',
              'response.refusal.done',
            ].includes(event.type)
          ) {
            throw new Error('Provider stream failed');
          }
        }
        if (!payload) throw new Error('Stream ended before completion');
      } else {
        payload = await response.json();
      }
      const body = z
        .object({
          status: z.literal('completed'),
          output: z.array(
            z.object({
              type: z.string(),
              content: z
                .array(z.object({ type: z.string(), text: z.string().optional() }))
                .optional(),
            }),
          ),
        })
        .parse(payload);
      const content = body.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? []);
      if (content.some((item) => item.type === 'refusal')) throw new Error('Model declined');
      const text = content
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('');
      const parsed: unknown = JSON.parse(text);
      if (options.onTextDelta) {
        const result = KnowledgeAnswerSchema.parse(parsed);
        // Compare raw text: schema trimming must not turn harmless whitespace into a mismatch.
        const completedAnswer = (parsed as { answer: string }).answer;
        if (
          (streamDecision !== undefined && streamDecision !== result.evidenceSufficient) ||
          !completedAnswer.startsWith(partialKnowledgeAnswer(streamedJson)) ||
          !completedAnswer.startsWith(emitted)
        )
          throw new Error('Completed answer disagrees with streamed decision or text');
        if (result.evidenceSufficient && completedAnswer.length > emitted.length)
          options.onTextDelta(completedAnswer.slice(emitted.length));
      }
      return parsed;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ReportError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new ReportError(504, 'ASSISTANT_MODEL_TIMEOUT', '模型响应超时，请重试。');
      throw new ReportError(502, 'ASSISTANT_MODEL_INVALID', '模型未返回有效结果，请重试。');
    }
  }
  async classify(request: AssistantRequest, today: string, options?: AssistantModelOptions) {
    const raw = await this.structured(
      'cornven_intent',
      intentJsonSchema,
      INTENT_SYSTEM_PROMPT,
      {
        businessDate: today,
        businessTimezone: 'Asia/Taipei',
        history: request.history ?? [],
        message: request.message,
      },
      { signal: options?.signal },
    );
    const parsed = AssistantInterpretationSchema.safeParse(raw);
    if (!parsed.success)
      throw new ReportError(
        502,
        'ASSISTANT_MODEL_INVALID',
        '模型返回的意图或参数无效，请重新描述艺术家和年月。',
      );
    // A well-formed model response can still invent a year. Require user/history evidence
    // before allowing an absolute month; server businessDate alone is not evidence.
    const result = parsed.data;
    const context = [request.message, ...(request.history ?? []).map((turn) => turn.content)].join(
      '\n',
    );
    const hasYearEvidence =
      /\b[2-9]\d{3}\b|今年|去年|前年|明年|本年|(?:本|这|這|当|當|上|下|前|后|後)(?:个|個)?月|(?:this|last|next|current|previous)\s+(?:month|year)|month\s+(?:to\s+date|before|ago)/iu.test(
        context,
      );
    if (
      (result.intent === 'sales.refunds' ||
        result.intent === 'settlement.preview' ||
        result.intent === 'settlement.get') &&
      result.slots.settlementMonth &&
      !hasYearEvidence
    ) {
      result.slots.settlementMonth = null;
      result.clarification = {
        missingFields: [
          ...(result.slots.artistQuery ? [] : ['artistQuery' as const]),
          'settlementMonth',
        ],
        question: '请提供完整的结算年月（例如 2026-09）；如果还未指定艺术家，也请一并提供。',
      };
    }
    if (
      ['sales.refunds', 'settlement.preview', 'settlement.get'].includes(result.intent) &&
      !result.clarification
    ) {
      const missingFields: NonNullable<AssistantInterpretation['clarification']>['missingFields'] =
        [];
      if (!result.slots.artistQuery) missingFields.push('artistQuery');
      if (!result.slots.settlementMonth) missingFields.push('settlementMonth');
      if (missingFields.length)
        result.clarification = {
          missingFields,
          question: `请补充${missingFields.map((field) => (field === 'artistQuery' ? '艺术家姓名或编号' : '完整年月（YYYY-MM）')).join('和')}。`,
        };
    }
    return result;
  }
  async answerKnowledge(
    question: string,
    evidence: AssistantEvidenceBundle,
    options?: AssistantModelOptions,
  ) {
    assertEvidenceBudget(evidence.items, contextPolicy(this.environment).tokenBudget);
    const raw = await this.structured(
      'cornven_knowledge_answer',
      {
        ...knowledgeJsonSchema,
        properties: {
          ...knowledgeJsonSchema.properties,
          citationIds: {
            type: 'array',
            maxItems: evidence.items.length,
            items: evidence.items.length
              ? { type: 'string', enum: evidence.items.map((item) => item.citation.chunkId) }
              : { type: 'string' },
            ...(evidence.items.length ? {} : { maxItems: 0 }),
          },
        },
      },
      this.knowledgePrompt,
      {
        question,
        references: modelReferences(evidence.items),
      },
      options,
    );
    const parsed = KnowledgeAnswerSchema.safeParse(raw);
    if (!parsed.success)
      throw new ReportError(502, 'ASSISTANT_MODEL_INVALID', '模型未返回有效的知识回答，请重试。');
    return parsed.data;
  }
}
