import {
  contractFallbackMessage,
  contractResourceFallback,
} from '../documents/contract-resource-fallback.js';
import { enrichDocumentCitations } from '../documents/document-resources.js';
import { RagError } from '../documents/rag-errors.js';
import {
  AssistantAnswerSchema,
  AssistantInterpretationSchema,
  AssistantRequestSchema,
  MonthlyReportDocumentSchema,
  MonthlyRefundMetricsResponseSchema,
  type MonthlyRefundMetricsResponse,
  MonthlySettlementPreviewResponseSchema,
  type AssistantAnswer,
  type AssistantInterpretation,
  type AssistantRequest,
  type DocumentSearchOutput,
  type MonthlyReportDocument,
  type MonthlySettlementPreviewResponse,
} from '@cornven/contracts';
import type { AssistantModel, AssistantModelOptions } from './assistant-model.js';
import { buildAssistantEvidenceBundle } from '../documents/assistant-evidence.js';
import { ReportError } from '../../shared/report-errors.js';

export interface AssistantArtist {
  id: string;
  name: string;
  externalRef: string | null;
  brandName: string | null;
}
export interface AssistantTools {
  resolveArtists(query: string): Promise<AssistantArtist[]>;
  searchSales(artistId: string, settlementMonth: string): Promise<MonthlyRefundMetricsResponse>;
  preview(artistId: string, settlementMonth: string): Promise<MonthlySettlementPreviewResponse>;
  getReport(artistId: string, settlementMonth: string): Promise<MonthlyReportDocument | null>;
  searchDocuments(
    query: string,
    options?: { originalQuestion?: string; signal?: AbortSignal | undefined },
  ): Promise<DocumentSearchOutput>;
}
const money = (cents: number | null) =>
  cents === null
    ? '待确认'
    : new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD' }).format(cents / 100);
function financialText(r: MonthlyReportDocument['financialSummary']) {
  return `商品销售额：${money(r.totalProductSalesCents)}；退款：${money(r.refundsCents)}；有效销售额：${money(r.validSalesCents)}。\n艺术家分成：${money(r.creatorRevenueShareAmountCents)}；转账手续费：${money(r.bankTransferFeeCents)}；应付金额：${money(r.amountPayableToCreatorCents)}。`;
}
export class AssistantService {
  constructor(
    readonly model: AssistantModel,
    private readonly now = () => new Date(),
  ) {}
  async answer(
    input: AssistantRequest,
    requestId: string,
    tools: AssistantTools,
    options: AssistantModelOptions & { onStatus?: (message: string) => void } = {},
  ): Promise<AssistantAnswer> {
    const progress = (message: string) => {
      options.signal?.throwIfAborted();
      options.onStatus?.(message);
    };
    progress('正在理解问题…');
    const request = AssistantRequestSchema.parse(input);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now());
    const interpretation = AssistantInterpretationSchema.parse(
      await this.model.classify(request, today, { signal: options.signal }),
    );
    options.signal?.throwIfAborted();
    const reply = (
      fields: Partial<AssistantAnswer> & Pick<AssistantAnswer, 'answer' | 'outcome'>,
    ) =>
      AssistantAnswerSchema.parse({
        requestId,
        citations: [],
        toolCalls: [],
        interpretation,
        ...fields,
      });
    const clarify = (
      question: string,
      missingFields: NonNullable<AssistantInterpretation['clarification']>['missingFields'],
    ) => {
      interpretation.clarification = { question, missingFields };
      return reply({ outcome: 'needs_clarification', answer: question });
    };
    if (interpretation.intent === 'unsupported')
      return reply({
        outcome: 'refused',
        answer:
          '目前可以试算某位艺术家某月的结算、查询已保存报告，以及查询 SOP。暂不支持执行退款、审批、保存报告或其他写入操作；生成并保存报告请前往 Settlement Runs。',
      });
    if (interpretation.intent === 'unknown')
      return clarify(
        interpretation.clarification?.question ??
          '你想重新试算结算、查询已保存报告，还是查询操作流程？每次请先选择一项。',
        ['intent'],
      );
    if (interpretation.clarification)
      return clarify(
        interpretation.clarification.question,
        interpretation.clarification.missingFields,
      );
    const tool = interpretation.intent;
    const started = Date.now();
    let argumentsSummary = '';
    const execution = (resultSummary: string) => [
      {
        requestId,
        tool,
        execution: {
          status: 'succeeded' as const,
          argumentsSummary,
          resultSummary,
          durationMs: Math.max(0, Date.now() - started),
        },
      },
    ];
    try {
      if (tool === 'documents.search') {
        // The intent is already known; a missing keyword summary must not discard the user's question.
        const query = interpretation.slots.knowledgeQuery ?? request.message;
        argumentsSummary = query;
        progress('正在检索 SOP 文档…');
        const evidence = buildAssistantEvidenceBundle(
          await tools.searchDocuments(query, {
            originalQuestion: request.message,
            signal: options.signal,
          }),
        );
        options.signal?.throwIfAborted();
        const toolCalls = execution(`Retrieved ${evidence.items.length} source passages`);
        if (!evidence.evidenceSufficient || !evidence.items.length) {
          console.info({
            event: 'rag.insufficient',
            requestId,
            reason: 'no_matches',
            passages: 0,
            resources: 0,
          });
          return reply({
            outcome: 'insufficient_evidence',
            answer: '现有知识库没有找到足够依据，请补充更具体的流程名称或关键词。',
            toolCalls,
          });
        }
        progress('正在根据文档生成回答…');
        const answer = await this.model.answerKnowledge(request.message, evidence, options);
        progress('正在校验回答与引用…');
        if (!answer.evidenceSufficient) {
          const resourceFallback = await contractResourceFallback(request.message, evidence);
          options.signal?.throwIfAborted();
          console.info({
            event: 'rag.insufficient',
            requestId,
            reason: resourceFallback ? 'attachment_body_not_indexed' : 'model_insufficient',
            passages: evidence.items.length,
            resources: resourceFallback?.resources.length ?? 0,
          });
          return reply({
            outcome: 'insufficient_evidence',
            answer: resourceFallback
              ? contractFallbackMessage(request.message)
              : '检索到的资料不足以回答这个问题，请补充更具体的流程名称或关键词。',
            ...(resourceFallback ? { resourceFallback } : {}),
            toolCalls,
          });
        }
        const ids = [...new Set(answer.citationIds)];
        if (
          !ids.length ||
          ids.some((id) => !evidence.items.some((item) => item.citation.chunkId === id))
        )
          throw new RagError('RAG_EVIDENCE_INVALID');
        // Model markers refer to explicitly numbered retrieved passages. Remap to the
        // displayed subset in first-use order; never show a dangling or mismatched [n].
        const markers = [...answer.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
        if (
          !markers.length ||
          markers.some(
            (number) =>
              !evidence.items[number - 1] ||
              !ids.includes(evidence.items[number - 1]!.citation.chunkId),
          )
        )
          throw new RagError('RAG_EVIDENCE_INVALID');
        const displayedIds = [
          ...new Set(markers.map((number) => evidence.items[number - 1]!.citation.chunkId)),
        ];
        const citedAnswer = answer.answer.replace(
          /\[(\d+)\]/g,
          (_match, number: string) =>
            `[${displayedIds.indexOf(evidence.items[Number(number) - 1]!.citation.chunkId) + 1}]`,
        );
        return reply({
          outcome: 'answered',
          answer: citedAnswer,
          ...(await enrichDocumentCitations(
            displayedIds.map(
              (id) => evidence.items.find((item) => item.citation.chunkId === id)!.citation,
            ),
          )),
          toolCalls,
        });
      }
      const { artistQuery, settlementMonth } = interpretation.slots;
      const missing: NonNullable<AssistantInterpretation['clarification']>['missingFields'] = [];
      if (!artistQuery) missing.push('artistQuery');
      if (!settlementMonth) missing.push('settlementMonth');
      if (missing.length)
        return clarify(
          `请补充${missing.map((f) => (f === 'artistQuery' ? '艺术家姓名或编号' : '结算年月（例如 2026-09）')).join('和')}。`,
          missing,
        );
      argumentsSummary = `artist=${artistQuery}; month=${settlementMonth}`;
      progress('正在查找艺术家…');
      const artists = await tools.resolveArtists(artistQuery!);
      options.signal?.throwIfAborted();
      if (artists.length !== 1) {
        return clarify(
          artists.length === 0
            ? `没有找到“${artistQuery}”，请检查艺术家姓名或编号。`
            : `找到了多位艺术家，请回复其中一位的编号：\n${artists.map((a) => `${a.name}${a.brandName ? ` / ${a.brandName}` : ''}（${a.externalRef ?? a.id}）`).join('\n')}`,
          ['artistQuery'],
        );
      }
      const artist = artists[0]!;
      argumentsSummary = `artistId=${artist.id}; settlementMonth=${settlementMonth}`;
      if (tool === 'sales.refunds') {
        const metric = interpretation.slots.metric;
        if (!metric)
          return clarify('你想查询退款商品件数、退款交易笔数，还是退款金额？', ['intent']);
        progress('正在查询退款记录…');
        const data = MonthlyRefundMetricsResponseSchema.parse(
          await tools.searchSales(artist.id, settlementMonth!),
        );
        const period = `${artist.name} 在 ${data.settlementMonth}`;
        const detail =
          metric === 'refund_quantity'
            ? `${period} 的退款数量为 ${data.refundQuantity} 件，涉及 ${data.refundTransactionCount} 笔退款交易。\n这里的“数量”按退回的商品件数统计。`
            : metric === 'refund_amount'
              ? `${period} 的退款金额为 ${money(data.refundAmountCents)}。`
              : `${period} 共有 ${data.refundTransactionCount} 笔退款交易，涉及 ${data.refundQuantity} 件商品。\n交易笔数按来源交易编号去重统计。`;
        return reply({
          outcome: 'answered',
          answer: `${detail}\n按退款发生月份统计，包含原销售发生在更早月份的退款；数据截止 ${new Date(data.dataCutoff).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false })}（Asia/Taipei）。`,
          toolCalls: execution(`Read ${data.refundRecordCount} refund records; metric=${metric}`),
        });
      }
      if (tool === 'settlement.preview') {
        progress('正在读取数据并计算结算…');
        const data = MonthlySettlementPreviewResponseSchema.parse(
          await tools.preview(artist.id, settlementMonth!),
        );
        return reply({
          outcome: 'answered',
          answer: `${artist.name} · ${data.settlementMonth} 只读试算（未保存）\n${financialText(data.result)}\n数据截止：${new Date(data.dataCutoff).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false })}（Asia/Taipei）。库存情况和明细见下方。`,
          result: { kind: 'preview', data },
          toolCalls: execution('Read-only calculation completed; no report saved'),
        });
      }
      progress('正在读取已保存的报告…');
      const raw = await tools.getReport(artist.id, settlementMonth!);
      if (!raw)
        return reply({
          outcome: 'answered',
          answer: `${artist.name} 在 ${settlementMonth} 没有已保存的报告。你可以要求只读试算，或前往 Settlement Runs 生成并保存当前月份报告。`,
          toolCalls: execution('No saved report found; no calculation performed'),
        });
      const data = MonthlyReportDocumentSchema.parse(raw);
      return reply({
        outcome: 'answered',
        answer: `${data.creator.displayName} · ${data.settlementMonth} 最新已保存报告（草稿）\n${financialText(data.financialSummary)}\n生成时间：${new Date(data.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false })}（Asia/Taipei）。这是保存时的快照，未重新计算；草稿不代表已审批。`,
        result: { kind: 'report', data },
        toolCalls: execution(`Read saved report ${data.reportId}`),
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ReportError && error.code.startsWith('RAG_'))
        console.warn({ requestId, code: error.code });
      const code =
        error instanceof ReportError && error.status === 504
          ? 'TOOL_TIMEOUT'
          : error instanceof ReportError && error.status === 400
            ? 'TOOL_ARGUMENTS_INVALID'
            : error instanceof ReportError && error.status === 403
              ? 'TOOL_NOT_ALLOWED'
              : 'TOOL_EXECUTION_FAILED';
      return reply({
        outcome: 'tool_error',
        answer: error instanceof ReportError ? error.message : '无法取得有效结果，请稍后重试。',
        toolCalls: [
          {
            requestId,
            tool,
            execution: {
              status: code === 'TOOL_TIMEOUT' ? 'timed_out' : 'failed',
              argumentsSummary: argumentsSummary || tool,
              errorCode: code,
              durationMs: Math.max(0, Date.now() - started),
            },
          },
        ],
      });
    }
  }
}
