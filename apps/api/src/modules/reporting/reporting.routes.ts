import { Router } from 'express';
import { IdentifierSchema, MonthlyReportDocumentSchema } from '@cornven/contracts';
import type { DatabaseMonthlyReportContext } from '../import/database-monthly-report-context.service.js';
import { ReportError } from '../../shared/report-errors.js';
import type { ResolveReportActor } from '../../shared/report-auth.js';
import type { MonthlyReportingService } from './reporting.service.js';

export function createReportingRouter(
  service: MonthlyReportingService,
  data: DatabaseMonthlyReportContext,
  resolveActor: ResolveReportActor,
) {
  const router = Router();
  const actorFor = (request: Parameters<ResolveReportActor>[0]) => {
    const actor = resolveActor(request);
    if (!actor) throw new ReportError(401, 'UNAUTHENTICATED', 'Sign in to access reports.');
    return actor;
  };
  router.get('/artists', async (request, response) => {
    response.json(await data.listArtists(request.query, actorFor(request)));
  });
  router.post('/reports', async (request, response) => {
    const result = await service.generate(
      request.body,
      request.get('Idempotency-Key'),
      actorFor(request),
    );
    response.status(result.status).json(result.body);
  });
  router.get('/reports', async (request, response) => {
    response.json(await service.repository.listReports(request.query, actorFor(request)));
  });
  router.get('/reports/:reportId', async (request, response) => {
    const report = await service.repository.getReport(
      IdentifierSchema.parse(request.params.reportId),
      actorFor(request),
    );
    response.json(MonthlyReportDocumentSchema.parse(report.reportJson));
  });
  router.get('/reports/:reportId/download', async (request, response) => {
    const artifact = await service.download(
      IdentifierSchema.parse(request.params.reportId),
      actorFor(request),
    );
    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${artifact.metadata.fileName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(Buffer.from(artifact.bytes));
  });
  return router;
}
