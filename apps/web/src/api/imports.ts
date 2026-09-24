import { CsvBatchSchema, CsvBatchListSchema } from '@cornven/contracts';
import type {
  CanonicalSale,
  CsvBatchUpload,
  CommissionRateUnit,
  ImportValidationSummary,
  PosAuditEvent,
  RawPosImportRequest,
} from '@cornven/contracts';

import { apiRequest } from './client';

export interface NormalizeMockImportResponse {
  summary: ImportValidationSummary;
  records: CanonicalSale[];
  auditEvents: PosAuditEvent[];
}

export function normalizeMockImport(payload: RawPosImportRequest) {
  return apiRequest<NormalizeMockImportResponse>('/api/v1/imports/mock/normalize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function normalizeCsvImport(
  csv: string,
  commissionRateUnit: CommissionRateUnit = 'fraction',
) {
  return apiRequest<NormalizeMockImportResponse>('/api/v1/imports/csv/normalize', {
    method: 'POST',
    body: JSON.stringify({ csv, commissionRateUnit }),
  });
}

export async function uploadCsvBatch(payload: CsvBatchUpload) {
  return CsvBatchSchema.parse(
    await apiRequest<unknown>('/api/v1/imports/batches', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );
}
export async function confirmCsvBatch(id: string) {
  return CsvBatchSchema.parse(
    await apiRequest<unknown>('/api/v1/imports/batches/' + encodeURIComponent(id) + '/confirm', {
      method: 'POST',
      body: '{}',
    }),
  );
}
export async function getCsvBatch(id: string) {
  return CsvBatchSchema.parse(
    await apiRequest<unknown>('/api/v1/imports/batches/' + encodeURIComponent(id)),
  );
}
export async function listCsvBatches(status = '', before?: string) {
  const query = new URLSearchParams({ limit: '20' });
  if (status) query.set('status', status);
  if (before) query.set('before', before);
  return CsvBatchListSchema.parse(
    await apiRequest<unknown>('/api/v1/imports/batches?' + query.toString()),
  );
}
