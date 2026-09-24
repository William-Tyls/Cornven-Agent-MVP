import { Router } from 'express';
import type { MonthlySettlementPreviewService } from './monthly-preview.service.js';

export function createMonthlyPreviewRouter(service: MonthlySettlementPreviewService) {
  const router = Router();
  // Both entry points share exactly the same request, validation and read-only service.
  router.post(
    ['/settlements/monthly-preview', '/assistant/tools/settlement.preview'],
    async (request, response, next) => {
      try {
        response.set('Cache-Control', 'no-store').json(await service.preview(request.body));
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
