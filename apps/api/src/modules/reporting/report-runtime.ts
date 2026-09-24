import { DeliveryService } from '../delivery/delivery.service.js';
import { createReportMailer, type ReportMailer } from '../delivery/mail-transport.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { resolve } from 'node:path';
import { MonthlyRefundMetricsService } from '../sales/monthly-refund-metrics.service.js';
import { database, type PrismaClient } from '@cornven/database';
import { DatabaseMonthlyReportContext } from '../import/database-monthly-report-context.service.js';
import { developmentIdentity, type ResolveReportActor } from '../../shared/report-auth.js';
import { LocalReportArtifactStorage } from './report-artifact-storage.js';
import {
  PuppeteerMonthlyReportPdfRenderer,
  type MonthlyReportPdfRenderer,
} from './pdf-renderer.js';
import { ReportRepository } from './report.repository.js';
import { MonthlyReportingService } from './reporting.service.js';
import { ReportScheduler } from './report-scheduler.js';
import { MonthlySettlementPreviewService } from '../settlement/monthly-preview.service.js';

export function createReportRuntime(
  options: {
    db?: PrismaClient;
    mailer?: ReportMailer;
    now?: () => Date;
    renderer?: MonthlyReportPdfRenderer;
    storagePath?: string;
    resolveActor?: ResolveReportActor;
    startMonth?: string;
  } = {},
) {
  const db = options.db ?? database;
  const now = options.now ?? (() => new Date());
  const data = new DatabaseMonthlyReportContext(db);
  const repository = new ReportRepository(db);
  const storage = new LocalReportArtifactStorage({
    rootDirectory: resolve(
      options.storagePath ?? process.env.REPORT_STORAGE_PATH ?? '.local/reports',
    ),
    now,
  });
  const service = new MonthlyReportingService(
    repository,
    data,
    options.renderer ?? new PuppeteerMonthlyReportPdfRenderer(),
    storage,
    now,
  );
  const scheduler = new ReportScheduler(
    service,
    data,
    options.startMonth ?? process.env.REPORT_SCHEDULER_START_MONTH ?? '2026-08',
  );
  return {
    delivery: new DeliveryService(db, service, options.mailer ?? createReportMailer(), now),
    approvals: new ApprovalsService(db),
    preview: new MonthlySettlementPreviewService(data, now),
    refunds: new MonthlyRefundMetricsService(db, now),
    data,
    repository,
    service,
    scheduler,
    resolveActor: options.resolveActor ?? developmentIdentity(),
  };
}
export type ReportRuntime = ReturnType<typeof createReportRuntime>;
