import {
  AssistantAnswerSchema,
  AssistantStreamEventSchema,
  readSseData,
  type AssistantStreamEvent,
  AssistantRequestSchema,
  type AssistantRequest,
  type AssistantAnswer,
} from '@cornven/contracts';
import type { AgentToolName } from '@cornven/contracts';

import { apiRequest, ApiError, BASE_URL } from './client';

export interface AssistantToolDefinition {
  name: AgentToolName;
  description: string;
  owner: string;
  readOnly: true;
  input: unknown;
  output: unknown;
}

export interface ListAssistantToolsResponse {
  topologyStatus: 'proposed';
  tools: AssistantToolDefinition[];
}

export function listAssistantTools() {
  return apiRequest<ListAssistantToolsResponse>('/api/v1/assistant/tools');
}

export interface AssistantStatus {
  configured: boolean;
  model: string;
  availableIntents: string[];
}
export function getAssistantStatus() {
  return apiRequest<AssistantStatus>('/api/v1/assistant/status');
}
export async function askAssistant(input: AssistantRequest) {
  return AssistantAnswerSchema.parse(
    await apiRequest('/api/v1/assistant', {
      method: 'POST',
      body: JSON.stringify(AssistantRequestSchema.parse(input)),
    }),
  );
}

// Follow-ups need the interpreted question, not previously returned business amounts or SOP text.
export function assistantHistoryContent(answer: AssistantAnswer): string {
  if (answer.interpretation) return JSON.stringify(answer.interpretation);
  return answer.outcome === 'needs_clarification' ? answer.answer : 'Previous request completed.';
}

export async function streamAssistant(
  input: AssistantRequest,
  onEvent: (event: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AssistantAnswer> {
  const response = await fetch(`${BASE_URL}/api/v1/assistant/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(AssistantRequestSchema.parse(input)),
    signal: AbortSignal.any([AbortSignal.timeout(70000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('服务器未返回有效的流式响应，请重试。');
  for await (const data of readSseData(response.body)) {
    signal?.throwIfAborted();
    const event = AssistantStreamEventSchema.parse(JSON.parse(data));
    if (event.type === 'error')
      throw new ApiError(502, {
        error: {
          code: event.code,
          message: event.message,
          requestId: event.requestId,
          details: [],
        },
      });
    onEvent(event);
    if (event.type === 'final') return event.answer;
  }
  throw new Error('连接已中断，回答尚未完成，请重试。');
}
