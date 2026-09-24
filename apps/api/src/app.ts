import cors from 'cors';
import { createDocumentAssetsRouter } from './modules/documents/document-assets.routes.js';
import { createDeliveryRouter } from './modules/delivery/delivery.routes.js';
import { createApprovalsRouter } from './modules/approvals/approvals.routes.js';
import type { AssistantModel } from './modules/assistant/assistant-model.js';
import { createCsvBatchRouter } from './modules/import/csv-batch.routes.js';
import { CsvBatchService } from './modules/import/csv-batch.service.js';
import { createReportingRouter } from './modules/reporting/reporting.routes.js';
import type { ReportRuntime } from './modules/reporting/report-runtime.js';
import express from 'express';
import { createMonthlyPreviewRouter } from './modules/settlement/monthly-preview.routes.js';

import { createAssistantRouter } from './modules/assistant/assistant.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { importRouter } from './modules/import/import.routes.js';
import { settlementRouter } from './modules/settlement/settlement.routes.js';
import { errorHandler, notFoundHandler } from './shared/errors.js';

export function createApp(reports?: ReportRuntime, assistantModel?: AssistantModel) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'cornven-api',
      version: '0.1.0',
    });
  });

  app.use('/api/v1/imports', importRouter);
  app.use('/api/v1/settlements', settlementRouter);
  app.use('/api/v1/assistant', createAssistantRouter(reports, assistantModel));
  app.use('/api/v1/documents', createDocumentAssetsRouter());
  app.use('/api/v1/documents', documentsRouter);

  if (reports) {
    app.use('/api/v1/deliveries', createDeliveryRouter(reports.delivery, reports.resolveActor));
    app.use('/api/v1/approvals', createApprovalsRouter(reports.approvals, reports.resolveActor));
    app.use('/api/v1', createMonthlyPreviewRouter(reports.preview));
    app.use('/api/v1/imports', createCsvBatchRouter(new CsvBatchService(reports.repository.db)));
    app.use('/api/v1', createReportingRouter(reports.service, reports.data, reports.resolveActor));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
