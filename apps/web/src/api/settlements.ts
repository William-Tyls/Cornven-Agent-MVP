import type { SettlementPreview, SettlementPreviewInput } from '@cornven/contracts';
import {
  MonthlySettlementPreviewRequestSchema,
  MonthlySettlementPreviewResponseSchema,
  type MonthlySettlementPreviewRequest,
} from '@cornven/contracts';

import { apiRequest } from './client';

export function previewSettlement(input: SettlementPreviewInput) {
  return apiRequest<SettlementPreview>('/api/v1/settlements/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function previewMonthlySettlement(input: MonthlySettlementPreviewRequest) {
  return MonthlySettlementPreviewResponseSchema.parse(
    await apiRequest('/api/v1/settlements/monthly-preview', {
      method: 'POST',
      body: JSON.stringify(MonthlySettlementPreviewRequestSchema.parse(input)),
    }),
  );
}
