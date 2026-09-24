import {
  DeliveryConfigSchema,
  DeliveryListResponseSchema,
  DeliveryProfileSchema,
  DeliveryRecordSchema,
  type DeliveryProfile,
} from '@cornven/contracts';
import { apiRequest } from './client';
export async function deliveryConfig() {
  return DeliveryConfigSchema.parse(await apiRequest('/api/v1/deliveries/config'));
}
export async function getDeliveryProfile(id: string) {
  return DeliveryProfileSchema.parse(
    await apiRequest(`/api/v1/deliveries/profiles/${encodeURIComponent(id)}`),
  );
}
export async function saveDeliveryProfile(id: string, body: Omit<DeliveryProfile, 'artistId'>) {
  return DeliveryProfileSchema.parse(
    await apiRequest(`/api/v1/deliveries/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  );
}
export async function sendReport(reportId: string) {
  return DeliveryRecordSchema.parse(
    await apiRequest('/api/v1/deliveries', { method: 'POST', body: JSON.stringify({ reportId }) }),
  );
}
export async function retryDelivery(id: string) {
  return DeliveryRecordSchema.parse(
    await apiRequest(`/api/v1/deliveries/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: '{}',
    }),
  );
}
export async function listDeliveries(params: URLSearchParams) {
  return DeliveryListResponseSchema.parse(await apiRequest(`/api/v1/deliveries?${params}`));
}
