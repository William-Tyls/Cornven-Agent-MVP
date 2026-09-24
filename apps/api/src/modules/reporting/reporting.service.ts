import { randomUUID } from 'node:crypto';
import {
  GenerateMonthlyReportRequestSchema,
  GenerateMonthlyReportResponseSchema,
  IdempotencyKeySchema,
  MonthlyReportDocumentSchema,
  SettlementPreviewInputSchema,
  type MonthlyReportContextProvider,
} from '@cornven/contracts';
import { requireArtist, type ReportActor } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import { monthAt } from '../../shared/report-time.js';
import { calculateSettlementPreview } from '../settlement/settlement.service.js';
import type { MonthlyReportPdfRenderer } from './pdf-renderer.js';
import { renderMonthlyReportHtml } from './report-html.js';
import { mapM3SettlementPreviewToMonthlyReport } from './report-mapper.js';
import type { LocalReportArtifactStorage } from './report-artifact-storage.js';
import type { ReportRepository } from './report.repository.js';
import { reportSummary, type GenerateReportCommand } from './report.repository.js';

export interface ReportPdfPublisher {
  publish(input: {
    reportId: string;
    fileName: string;
    bytes: Uint8Array;
  }): Promise<{ pdfFileReference: string }>;
}
export class MonthlyReportingService {
  constructor(
    readonly repository: ReportRepository,
    private readonly provider: MonthlyReportContextProvider,
    private readonly renderer: MonthlyReportPdfRenderer,
    readonly storage: LocalReportArtifactStorage,
    readonly now: () => Date = () => new Date(),
    readonly maxAttempts = 3,
  ) {}

  async generate(request: unknown, key: unknown, actor: ReportActor) {
    const parsed = GenerateMonthlyReportRequestSchema.parse(request);
    const idempotencyKey = IdempotencyKeySchema.parse(key);
    requireArtist(actor, parsed.artistId);
    const now = this.now();
    const command: GenerateReportCommand = {
      artistId: parsed.artistId,
      settlementMonth: monthAt(now),
      asOf: now.toISOString(),
      trigger: 'manual',
    };
    const { task, created } = await this.repository.getOrCreate(
      command,
      actor.id,
      idempotencyKey,
      JSON.stringify(parsed),
      now,
    );
    const report =
      task.status === 'SUCCEEDED'
        ? await this.repository.completedForTask(task.id)
        : await this.runTask(task.id);
    const summary = reportSummary(report);
    return {
      status: created ? 201 : 200,
      body: GenerateMonthlyReportResponseSchema.parse({
        reportId: summary.reportId,
        artistId: summary.artistId,
        displayName: summary.displayName,
        settlementMonth: summary.settlementMonth,
        asOf: summary.asOf,
        generatedAt: summary.generatedAt,
        isProvisional: summary.isProvisional,
        reportStatus: summary.reportStatus,
        generationStatus: summary.generationStatus,
        pdfFileReference: summary.pdfFileReference,
      }),
    };
  }

  async enqueueScheduled(command: GenerateReportCommand) {
    return this.repository.getOrCreate(
      command,
      'system:scheduler',
      `scheduled:${command.artistId}:${command.settlementMonth}`,
      JSON.stringify(command),
      this.now(),
    );
  }

  async runTask(id: string) {
    const claim = await this.repository.claim(id, this.now(), this.maxAttempts);
    if (!claim) return this.repository.completedForTask(id);
    const { task, token } = claim;
    const heartbeat = setInterval(() => {
      void this.repository.renew(id, token, this.now()).catch(() => {});
    }, 30_000);
    heartbeat.unref();
    try {
      let saved = task.reportId
        ? await this.repository.db.artistMonthlyReport.findUniqueOrThrow({
            where: { id: task.reportId },
          })
        : null;
      if (!saved) {
        const context = await this.provider
          .getMonthlyReportContext({
            artistId: task.artistId,
            settlementMonth: task.settlementMonth,
            asOf: task.asOf.toISOString(),
          })
          .catch((error: unknown) => {
            if (error instanceof ReportError) throw error;
            throw new ReportError(503, 'REPORT_DATA_UNAVAILABLE', 'Report data is unavailable.');
          });
        if (context.artistId !== task.artistId)
          throw new ReportError(503, 'REPORT_DATA_UNAVAILABLE', 'Upstream artist does not match.');
        const parsed = SettlementPreviewInputSchema.safeParse({
          ...context,
          artistId: task.artistId,
          settlementMonth: task.settlementMonth,
          asOf: task.asOf.toISOString(),
          currency: 'TWD',
          businessTimezone: 'Asia/Taipei',
        });
        if (!parsed.success)
          throw new ReportError(
            503,
            'REPORT_DATA_UNAVAILABLE',
            'Upstream report context is invalid.',
          );
        const output = calculateSettlementPreview(parsed.data);
        const document = mapM3SettlementPreviewToMonthlyReport({
          reportId: randomUUID(),
          generatedAt: this.now().toISOString(),
          settlement: output,
        });
        if (
          document.settlementMonth !== task.settlementMonth ||
          Date.parse(document.settlementPeriod.asOf) !== task.asOf.getTime()
        )
          throw new Error('Report scope mismatch');
        saved = await this.repository.freeze(id, token, parsed.data, output, document, this.now());
      }
      const document = MonthlyReportDocumentSchema.parse(saved.reportJson);
      // A crash after publishing but before committing metadata must reuse the stored PDF, not re-render different bytes.
      const existing = await this.storage.retrieve(saved.id);
      const artifact =
        existing?.metadata ??
        (await this.storage.publish({
          reportId: saved.id,
          fileName: `report-${saved.settlementMonth}-${saved.id}.pdf`,
          bytes: await this.renderer.render(renderMonthlyReportHtml(document)),
        }));
      return await this.repository.complete(id, token, artifact, this.now());
    } catch (error) {
      const failure =
        error instanceof ReportError
          ? error
          : new ReportError(
              500,
              'REPORT_GENERATION_FAILED',
              'Report generation failed. Retry with the same key.',
            );
      await this.repository.fail(task, token, failure, this.now(), this.maxAttempts);
      throw failure;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async download(id: string, actor: ReportActor) {
    await this.repository.getReport(id, actor);
    try {
      const artifact = await this.storage.retrieve(id);
      if (!artifact || Date.parse(artifact.metadata.expiresAt) <= this.now().getTime())
        throw new Error('File unavailable');
      return artifact;
    } catch {
      throw new ReportError(
        410,
        'REPORT_FILE_UNAVAILABLE',
        'Report PDF is unavailable. Generate a new report.',
      );
    }
  }
}
