import { z } from 'zod';
import { DocumentResourceSchema } from './document-resources.js';

import { IdentifierSchema, VerbatimExcerptSchema } from './common.js';
import {
  MonthlySettlementPreviewRequestSchema,
  MonthlySettlementPreviewResponseSchema,
} from './settlement-preview-api.js';
import { MonthlyReportDocumentSchema, SettlementMonthSchema } from './reporting.js';

export const AgentToolNameSchema = z.enum([
  'sales.search',
  'sales.refunds',
  'artist.get',
  'settlement.preview',
  'settlement.get',
  'approval.status',
  'documents.search',
]);

export const AssistantIntentSchema = z.enum([
  'sales.refunds',
  'settlement.preview',
  'settlement.get',
  'documents.search',
  'unsupported',
  'unknown',
]);
export const AssistantInterpretationSchema = z
  .object({
    intent: AssistantIntentSchema,
    slots: z
      .object({
        artistQuery: z.string().trim().min(1).max(200).nullable(),
        settlementMonth: SettlementMonthSchema.nullable(),
        knowledgeQuery: z.string().trim().min(1).max(1000).nullable(),
        metric: z.enum(['refund_quantity', 'refund_amount', 'refund_transactions']).nullish(),
      })
      .strict(),
    clarification: z
      .object({
        missingFields: z.array(z.enum(['artistQuery', 'settlementMonth', 'intent'])).max(3),
        question: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AssistantInterpretation = z.infer<typeof AssistantInterpretationSchema>;
export const AssistantHistoryMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(4000),
  })
  .strict();
export const AssistantResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preview'), data: MonthlySettlementPreviewResponseSchema }).strict(),
  z.object({ kind: z.literal('report'), data: MonthlyReportDocumentSchema }).strict(),
]);

export const AssistantRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    history: z.array(AssistantHistoryMessageSchema).max(12).optional(),
  })
  .strict();

export const AssistantOutcomeSchema = z.enum([
  'needs_clarification',
  'answered',
  'refused',
  'insufficient_evidence',
  'tool_error',
]);

export const AgentToolExecutionStatusSchema = z.enum([
  'succeeded',
  'failed',
  'timed_out',
  'skipped',
]);

export const AgentToolErrorCodeSchema = z.enum([
  'TOOL_ARGUMENTS_INVALID',
  'TOOL_NOT_ALLOWED',
  'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT',
  'TOOL_RESULT_INVALID',
  'TOOL_UNAVAILABLE',
]);

export const AgentToolExecutionSchema = z
  .object({
    status: AgentToolExecutionStatusSchema,
    argumentsSummary: z.string().trim().min(1),
    resultSummary: z.string().trim().min(1).optional(),
    errorCode: AgentToolErrorCodeSchema.optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (
      (execution.status === 'succeeded' || execution.status === 'skipped') &&
      execution.errorCode !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: `${execution.status} executions must not include an error code.`,
      });
    }

    if (execution.status === 'failed' && execution.errorCode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'Failed executions must include an error code.',
      });
    }

    if (execution.status === 'failed' && execution.errorCode === 'TOOL_TIMEOUT') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'TOOL_TIMEOUT must use the timed_out execution status.',
      });
    }

    if (execution.status === 'timed_out' && execution.errorCode !== 'TOOL_TIMEOUT') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'Timed-out executions must use the TOOL_TIMEOUT error code.',
      });
    }
  });

export const AgentToolCallSchema = z
  .object({
    requestId: IdentifierSchema,
    tool: AgentToolNameSchema,
    execution: AgentToolExecutionSchema,
  })
  .strict();

export const CitationSchema = z
  .object({
    documentId: IdentifierSchema,
    documentVersion: IdentifierSchema,
    chunkId: IdentifierSchema,
    title: z.string().trim().min(1),
    locator: z.string().trim().min(1),
    excerpt: VerbatimExcerptSchema,
    sourceUrl: z.string().url().startsWith('https://').optional(),
  })
  .strict();

export const AssistantAnswerSchema = z
  .object({
    requestId: IdentifierSchema,
    answer: z.string().trim().min(1),
    citations: z.array(CitationSchema),
    toolCalls: z.array(AgentToolCallSchema),
    outcome: AssistantOutcomeSchema,
    interpretation: AssistantInterpretationSchema.optional(),
    result: AssistantResultSchema.optional(),
    resources: z.array(DocumentResourceSchema).optional(),
    resourceFallback: z
      .object({
        citations: z.array(CitationSchema).min(1).max(15),
        resources: z.array(DocumentResourceSchema).min(1).max(15),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((answer, context) => {
    if (
      answer.resources?.length &&
      (answer.outcome !== 'answered' ||
        answer.resources.some((r) =>
          r.citationChunkIds.some((id) => !answer.citations.some((c) => c.chunkId === id)),
        ))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resources'],
        message: 'Resources must belong to final validated citations.',
      });
    answer.toolCalls.forEach((toolCall, index) => {
      if (toolCall.requestId !== answer.requestId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolCalls', index, 'requestId'],
          message: 'Tool-call requestId must match the Assistant response requestId.',
        });
      }
    });

    const attemptedSopSearch = answer.toolCalls.some(
      (toolCall) => toolCall.tool === 'documents.search',
    );
    const successfulSopSearch = answer.toolCalls.some(
      (toolCall) =>
        toolCall.tool === 'documents.search' && toolCall.execution.status === 'succeeded',
    );

    if (answer.resourceFallback) {
      const { citations, resources } = answer.resourceFallback;
      if (
        answer.outcome !== 'insufficient_evidence' ||
        !successfulSopSearch ||
        new Set(citations.map((c) => c.chunkId)).size !== citations.length ||
        new Set(resources.map((r) => r.resourceId)).size !== resources.length ||
        resources.some(
          (r) =>
            r.kind !== 'pdf' ||
            r.contentIndexed ||
            r.availability === 'missing' ||
            !r.actions.some((a) => a.kind === 'download') ||
            r.citationChunkIds.some((id) => !citations.some((c) => c.chunkId === id)),
        ) ||
        citations.some((c) => !resources.some((r) => r.citationChunkIds.includes(c.chunkId)))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resourceFallback'],
          message:
            'Attachment fallback requires insufficient evidence, a successful search and separate verified unindexed PDF references.',
        });
    }

    if (answer.outcome === 'answered' && attemptedSopSearch && !successfulSopSearch) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'An answered SOP response requires a successful document search.',
      });
    }

    if (answer.outcome === 'answered' && successfulSopSearch && answer.citations.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations'],
        message: 'An answered SOP response must include at least one citation.',
      });
    }

    if (answer.citations.length > 0 && (answer.outcome !== 'answered' || !successfulSopSearch)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations'],
        message: 'Document citations require an answered response and a successful SOP search.',
      });
    }
  });

export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;
export type AssistantOutcome = z.infer<typeof AssistantOutcomeSchema>;
export type AgentToolExecutionStatus = z.infer<typeof AgentToolExecutionStatusSchema>;
export type AgentToolErrorCode = z.infer<typeof AgentToolErrorCodeSchema>;
export type AgentToolExecution = z.infer<typeof AgentToolExecutionSchema>;
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type AssistantAnswer = z.infer<typeof AssistantAnswerSchema>;

export const SavedSettlementQuerySchema = MonthlySettlementPreviewRequestSchema;
export const SavedSettlementResponseSchema = z
  .object({ report: MonthlyReportDocumentSchema.nullable() })
  .strict();

export const MonthlyRefundMetricsRequestSchema = MonthlySettlementPreviewRequestSchema;
export const MonthlyRefundMetricsResponseSchema = z
  .object({
    artistId: z.string().uuid(),
    settlementMonth: SettlementMonthSchema,
    dataCutoff: z.string().datetime(),
    currency: z.literal('TWD'),
    refundQuantity: z.number().int().safe().nonnegative(),
    refundTransactionCount: z.number().int().safe().nonnegative(),
    refundRecordCount: z.number().int().safe().nonnegative(),
    refundAmountCents: z.number().int().safe().nonnegative(),
  })
  .strict();
export type MonthlyRefundMetricsResponse = z.infer<typeof MonthlyRefundMetricsResponseSchema>;
