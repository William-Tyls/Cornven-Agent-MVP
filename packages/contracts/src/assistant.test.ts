import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AgentToolExecutionSchema,
  AssistantAnswerSchema,
  AssistantRequestSchema,
} from './assistant.js';

const assistantContractExample = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/assistant/assistant-contract-example.json', import.meta.url),
    'utf8',
  ),
) as { request: unknown; response: unknown };

const generalAnswerExample = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/assistant/general-answer-example.json', import.meta.url),
    'utf8',
  ),
) as { request: unknown; response: unknown };

describe('Assistant public contracts', () => {
  it('accepts the safe request and answer example', () => {
    expect(AssistantRequestSchema.parse(assistantContractExample.request)).toEqual(
      assistantContractExample.request,
    );
    expect(AssistantAnswerSchema.parse(assistantContractExample.response)).toEqual(
      assistantContractExample.response,
    );
  });

  it('rejects an empty message', () => {
    expect(AssistantRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
  });

  it('rejects actor context supplied in the public request body', () => {
    const result = AssistantRequestSchema.safeParse({
      message: 'Search sales for ART-001.',
      actorId: 'UNTRUSTED-ACTOR',
      actorType: 'staff',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    {
      outcome: 'refused',
      answer: 'This request is outside the Assistant read-only scope.',
      citations: [],
      toolCalls: [],
    },
    {
      outcome: 'insufficient_evidence',
      answer: 'No approved source supports an answer to this request.',
      citations: [],
      toolCalls: [],
    },
    {
      outcome: 'tool_error',
      answer: 'The requested information is temporarily unavailable.',
      citations: [],
      toolCalls: [
        {
          requestId: 'REQ-tool_error',
          tool: 'documents.search',
          execution: {
            status: 'failed',
            argumentsSummary: 'Approved SOP search; query text redacted',
            errorCode: 'TOOL_EXECUTION_FAILED',
            durationMs: 8,
          },
        },
      ],
    },
  ])('accepts the $outcome outcome', ({ outcome, answer, citations, toolCalls }) => {
    expect(
      AssistantAnswerSchema.safeParse({
        requestId: `REQ-${outcome}`,
        outcome,
        answer,
        citations,
        toolCalls,
      }).success,
    ).toBe(true);
  });

  it('requires a citation when an answered response uses SOP search', () => {
    const response = assistantContractExample.response as {
      citations: unknown[];
      [key: string]: unknown;
    };

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        citations: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a general-knowledge answer without SOP citations or tool calls', () => {
    expect(AssistantRequestSchema.safeParse(generalAnswerExample.request).success).toBe(true);
    expect(AssistantAnswerSchema.safeParse(generalAnswerExample.response).success).toBe(true);
  });

  it('rejects an SOP citation that is not backed by a successful document search', () => {
    const response = assistantContractExample.response as {
      citations: unknown[];
      [key: string]: unknown;
    };

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        toolCalls: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an answered SOP response when document search failed', () => {
    const response = assistantContractExample.response as {
      toolCalls: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        toolCalls: [
          {
            ...response.toolCalls[0],
            execution: {
              status: 'failed',
              argumentsSummary: 'Approved SOP search; query text redacted',
              errorCode: 'TOOL_RESULT_INVALID',
              durationMs: 12,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a bounded hover excerpt on every citation', () => {
    const response = assistantContractExample.response as {
      citations: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    const citation = response.citations[0];

    expect(citation).toBeDefined();

    const withoutExcerpt = { ...citation };
    delete withoutExcerpt.excerpt;

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        citations: [withoutExcerpt],
      }).success,
    ).toBe(false);

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        citations: [{ ...citation, excerpt: 'x'.repeat(481) }],
      }).success,
    ).toBe(false);
  });

  it('rejects raw tool arguments in the public response', () => {
    const response = assistantContractExample.response as {
      toolCalls: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        toolCalls: [
          {
            ...response.toolCalls[0],
            arguments: { query: 'secret raw query' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects the removed refusal flag', () => {
    expect(
      AssistantAnswerSchema.safeParse({
        ...(assistantContractExample.response as Record<string, unknown>),
        refusal: false,
      }).success,
    ).toBe(false);
  });

  it('rejects a tool-call requestId that differs from the response requestId', () => {
    const response = assistantContractExample.response as {
      toolCalls: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

    expect(
      AssistantAnswerSchema.safeParse({
        ...response,
        toolCalls: [
          {
            ...response.toolCalls[0],
            requestId: 'REQ-DIFFERENT',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      name: 'succeeded with an error code',
      execution: {
        status: 'succeeded',
        argumentsSummary: 'Sensitive arguments redacted',
        errorCode: 'TOOL_EXECUTION_FAILED',
        durationMs: 5,
      },
    },
    {
      name: 'failed without an error code',
      execution: {
        status: 'failed',
        argumentsSummary: 'Sensitive arguments redacted',
        durationMs: 5,
      },
    },
    {
      name: 'timed_out with a non-timeout error code',
      execution: {
        status: 'timed_out',
        argumentsSummary: 'Sensitive arguments redacted',
        errorCode: 'TOOL_EXECUTION_FAILED',
        durationMs: 5,
      },
    },
    {
      name: 'failed with the timeout error code',
      execution: {
        status: 'failed',
        argumentsSummary: 'Sensitive arguments redacted',
        errorCode: 'TOOL_TIMEOUT',
        durationMs: 5,
      },
    },
  ])('rejects $name', ({ execution }) => {
    expect(AgentToolExecutionSchema.safeParse(execution).success).toBe(false);
  });

  it('accepts TOOL_TIMEOUT with the timed_out status', () => {
    expect(
      AgentToolExecutionSchema.safeParse({
        status: 'timed_out',
        argumentsSummary: 'Sensitive arguments redacted',
        errorCode: 'TOOL_TIMEOUT',
        durationMs: 5,
      }).success,
    ).toBe(true);
  });
});
