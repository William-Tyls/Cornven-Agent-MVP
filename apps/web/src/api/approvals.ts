import {
  ApprovalDetailSchema,
  ApprovalListResponseSchema,
  type ApprovalCommand,
} from '@cornven/contracts';
import { apiRequest } from './client';
export async function listApprovals(params: URLSearchParams) {
  return ApprovalListResponseSchema.parse(await apiRequest(`/api/v1/approvals?${params}`));
}
export async function getApproval(reportId: string) {
  return ApprovalDetailSchema.parse(
    await apiRequest(`/api/v1/approvals/${encodeURIComponent(reportId)}`),
  );
}
export async function actOnApproval(reportId: string, command: ApprovalCommand) {
  return ApprovalDetailSchema.parse(
    await apiRequest(`/api/v1/approvals/${encodeURIComponent(reportId)}/actions`, {
      method: 'POST',
      body: JSON.stringify(command),
    }),
  );
}
