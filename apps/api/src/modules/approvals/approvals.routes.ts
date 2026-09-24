import { Router } from 'express';
import { IdentifierSchema } from '@cornven/contracts';
import type { ResolveReportActor } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import type { ApprovalsService } from './approvals.service.js';
export function createApprovalsRouter(service: ApprovalsService, resolveActor: ResolveReportActor) {
  const router = Router();
  const actorFor = (request: Parameters<ResolveReportActor>[0]) => {
    const actor = resolveActor(request);
    if (!actor)
      throw new ReportError(401, 'UNAUTHENTICATED', 'An application identity is required.');
    return actor;
  };
  router.get('/', async (request, response) => {
    response.json(await service.list(request.query, actorFor(request)));
  });
  router.get('/:reportId', async (request, response) => {
    response.json(
      await service.detail(IdentifierSchema.parse(request.params.reportId), actorFor(request)),
    );
  });
  router.post('/:reportId/actions', async (request, response) => {
    response.json(
      await service.act(
        IdentifierSchema.parse(request.params.reportId),
        request.body,
        actorFor(request),
      ),
    );
  });
  return router;
}
