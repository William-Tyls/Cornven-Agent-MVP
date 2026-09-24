import { Router } from 'express';
import { IdentifierSchema } from '@cornven/contracts';
import type { ResolveReportActor } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import type { DeliveryService } from './delivery.service.js';
export function createDeliveryRouter(service: DeliveryService, resolveActor: ResolveReportActor) {
  const router = Router();
  const actorFor = (request: Parameters<ResolveReportActor>[0]) => {
    const actor = resolveActor(request);
    if (!actor)
      throw new ReportError(401, 'UNAUTHENTICATED', 'An application identity is required.');
    return actor;
  };
  router.get('/config', (req, res) => {
    actorFor(req);
    res.json(service.config());
  });
  router.get('/profiles/:artistId', async (req, res) => {
    res.json(await service.profile(IdentifierSchema.parse(req.params.artistId), actorFor(req)));
  });
  router.put('/profiles/:artistId', async (req, res) => {
    res.json(
      await service.saveProfile(
        IdentifierSchema.parse(req.params.artistId),
        req.body,
        actorFor(req),
      ),
    );
  });
  router.get('/', async (req, res) => {
    res.json(await service.list(req.query, actorFor(req)));
  });
  router.post('/', async (req, res) => {
    res.json(await service.send(req.body, actorFor(req)));
  });
  router.post('/:deliveryId/retry', async (req, res) => {
    res.json(await service.retry(IdentifierSchema.parse(req.params.deliveryId), actorFor(req)));
  });
  return router;
}
