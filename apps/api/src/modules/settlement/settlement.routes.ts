import { Router } from 'express';

import { SettlementPreviewInputSchema } from '@cornven/contracts';

import { calculateSettlementPreview } from './settlement.service.js';

export const settlementRouter = Router();

settlementRouter.post('/preview', (request, response, next) => {
  try {
    const input = SettlementPreviewInputSchema.parse(request.body);
    response.json(calculateSettlementPreview(input));
  } catch (error) {
    next(error);
  }
});
