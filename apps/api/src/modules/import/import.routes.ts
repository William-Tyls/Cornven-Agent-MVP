import { Router } from 'express';

import { CsvPosImportRequestSchema, RawPosImportRequestSchema } from '@cornven/contracts';

import { csvToRawPosRecords } from './import.csv.js';
import { normalizeRawPosRecords } from './import.service.js';

export const importRouter = Router();

importRouter.post('/mock/normalize', (request, response, next) => {
  try {
    const input = RawPosImportRequestSchema.parse(request.body);

    response.json(normalizeRawPosRecords(input.records, input.commissionRateUnit));
  } catch (error) {
    next(error);
  }
});

importRouter.post('/csv/normalize', (request, response, next) => {
  try {
    const input = CsvPosImportRequestSchema.parse(request.body);
    const records = csvToRawPosRecords(input.csv);

    response.json(normalizeRawPosRecords(records, input.commissionRateUnit));
  } catch (error) {
    next(error);
  }
});
