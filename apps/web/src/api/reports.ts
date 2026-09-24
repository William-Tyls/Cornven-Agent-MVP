import {
  ArtistListResponseSchema,
  GenerateMonthlyReportRequestSchema,
  GenerateMonthlyReportResponseSchema,
  MonthlyReportDocumentSchema,
  ReportListResponseSchema,
} from '@cornven/contracts';
import { apiRequest, ApiError, BASE_URL } from './client';
export async function listArtists(query = '', cursor?: string) {
  const params = new URLSearchParams({ query, limit: '20' });
  if (cursor) params.set('cursor', cursor);
  return ArtistListResponseSchema.parse(await apiRequest(`/api/v1/artists?${params}`));
}
export async function generateReport(artistId: string, key: string) {
  const body = GenerateMonthlyReportRequestSchema.parse({
    artistId,
    period: 'current_month',
    format: 'pdf',
  });
  return GenerateMonthlyReportResponseSchema.parse(
    await apiRequest('/api/v1/reports', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(body),
    }),
  );
}
export async function listReports(artistId: string, settlementMonth: string, cursor?: string) {
  const params = new URLSearchParams({ artistId, limit: '20' });
  if (settlementMonth) params.set('settlementMonth', settlementMonth);
  if (cursor) params.set('cursor', cursor);
  return ReportListResponseSchema.parse(await apiRequest(`/api/v1/reports?${params}`));
}
export async function getReport(reportId: string) {
  return MonthlyReportDocumentSchema.parse(
    await apiRequest(`/api/v1/reports/${encodeURIComponent(reportId)}`),
  );
}
export async function downloadReport(reportId: string) {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/v1/reports/${encodeURIComponent(reportId)}/download`);
  } catch {
    throw new ApiError(0, null);
  }
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-${reportId}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
