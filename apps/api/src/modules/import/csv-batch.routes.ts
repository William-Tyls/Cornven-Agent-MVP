import { Router } from 'express';
import { z } from 'zod';
import { getRequestId } from '../../shared/request-id.js';
import type { CsvBatchService } from './csv-batch.service.js';

export function createCsvBatchRouter(service: CsvBatchService) {
  const router = Router();
  router.post('/batches', async (request, response) => {
    response.status(201).json(await service.upload(request.body, getRequestId(request)));
  });
  router.get('/batches', async (request, response) => {
    response.json(await service.list(request.query));
  });
  router.get('/batches/:batchId', async (request, response) => {
    response.json(await service.get(z.string().uuid().parse(request.params.batchId)));
  });
  router.post('/batches/:batchId/confirm', async (request, response) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    response.json(
      await service.confirm(z.string().uuid().parse(request.params.batchId), getRequestId(request)),
    );
  });
  return router;
}
