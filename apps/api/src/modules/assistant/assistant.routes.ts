import { type AssistantStreamEvent } from '@cornven/contracts';
import { Router } from 'express';
import {
  agentToolDefinitions,
  AssistantRequestSchema,
  DocumentPermissionTagSchema,
  SavedSettlementQuerySchema,
  SavedSettlementResponseSchema,
  MonthlyRefundMetricsRequestSchema,
} from '@cornven/contracts';
import type { ReportRuntime } from '../reporting/report-runtime.js';
import { getRequestId } from '../../shared/request-id.js';
import { ReportError } from '../../shared/report-errors.js';
import { OpenAiAssistantModel, type AssistantModel } from './assistant-model.js';
import { AssistantService } from './assistant.service.js';
import { createAssistantTools } from './assistant-tools.js';

export function createAssistantRouter(
  reports?: ReportRuntime,
  model: AssistantModel = new OpenAiAssistantModel(),
) {
  const router = Router();
  const service = new AssistantService(model);
  router.get('/tools', (_request, response) => {
    response.json({ topologyStatus: 'proposed', tools: agentToolDefinitions });
  });
  router.get('/status', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({
      configured: model.configured && Boolean(reports),
      model: 'gpt-5.4-nano',
      availableIntents: reports
        ? ['sales.refunds', 'settlement.preview', 'settlement.get', 'documents.search']
        : [],
    });
  });
  router.post('/tools/sales.refunds', async (request, response) => {
    const input = MonthlyRefundMetricsRequestSchema.parse(request.body);
    if (!reports) throw new ReportError(503, 'ASSISTANT_UNAVAILABLE', '退款查询服务尚未就绪。');
    const actor = reports.resolveActor(request);
    if (!actor) throw new ReportError(403, 'FORBIDDEN', '当前服务未提供业务数据访问上下文。');
    response
      .set('Cache-Control', 'no-store')
      .json(
        await createAssistantTools(reports, actor, []).searchSales(
          input.artistId,
          input.settlementMonth,
        ),
      );
  });
  router.post('/tools/settlement.get', async (request, response) => {
    const input = SavedSettlementQuerySchema.parse(request.body);
    if (!reports) throw new ReportError(503, 'ASSISTANT_UNAVAILABLE', '报告查询服务尚未就绪。');
    const actor = reports.resolveActor(request);
    if (!actor) throw new ReportError(403, 'FORBIDDEN', '当前服务未提供业务数据访问上下文。');
    const report = await createAssistantTools(reports, actor, []).getReport(
      input.artistId,
      input.settlementMonth,
    );
    response.set('Cache-Control', 'no-store').json(SavedSettlementResponseSchema.parse({ report }));
  });
  router.post(['/', '/stream'], async (request, response) => {
    const input = AssistantRequestSchema.parse(request.body);
    if (!reports) throw new ReportError(503, 'ASSISTANT_UNAVAILABLE', 'Chatbot 业务服务尚未就绪。');
    const actor = reports.resolveActor(request);
    if (!actor) throw new ReportError(403, 'FORBIDDEN', '当前服务未提供业务数据访问上下文。');
    // Reuse the existing local demo identity; no new login or client-provided permissions.
    const trusted = DocumentPermissionTagSchema.array().safeParse(
      response.locals.documentPermissionTags,
    );
    const localDemo =
      process.env.LOCAL_DEVELOPMENT_IDENTITY === 'true' && process.env.NODE_ENV !== 'production';
    const tags = trusted.success ? trusted.data : localDemo ? ['staff' as const] : [];
    const tools = createAssistantTools(reports, actor, tags);
    const requestId = getRequestId(request);
    if (request.path === '/stream') {
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.on('close', abort);
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      const send = (event: AssistantStreamEvent) => {
        if (!controller.signal.aborted && !response.writableEnded)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!controller.signal.aborted) response.write(': heartbeat\n\n');
      }, 10000);
      const timeout = setTimeout(() => {
        send({
          type: 'error',
          code: 'ASSISTANT_TIMEOUT',
          message: '处理超时，请重试。',
          requestId,
        });
        controller.abort();
        response.end();
      }, 60000);
      try {
        const answer = await service.answer(input, requestId, tools, {
          signal: controller.signal,
          onStatus: (message) => send({ type: 'status', message }),
          onTextDelta: (delta) => send({ type: 'text_delta', delta }),
        });
        send({ type: 'final', answer });
      } catch (error) {
        send({
          type: 'error',
          code: error instanceof ReportError ? error.code : 'ASSISTANT_FAILED',
          message: error instanceof ReportError ? error.message : '无法完成回答，请重试。',
          requestId,
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        response.off('close', abort);
        response.end();
      }
      return;
    }
    response.set('Cache-Control', 'no-store').json(await service.answer(input, requestId, tools));
  });
  return router;
}
