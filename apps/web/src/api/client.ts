import type { ErrorEnvelope } from '@cornven/contracts';

export type ApiErrorDetail = ErrorEnvelope['error']['details'][number];

export const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3119').replace(
  /\/$/,
  '',
);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, envelope: ErrorEnvelope | null) {
    super(envelope?.error.message ?? `Request failed with status ${status}.`);
    this.status = status;
    this.code = envelope?.error.code ?? 'UNKNOWN_ERROR';
    this.requestId = envelope?.error.requestId ?? 'unknown';
    this.details = envelope?.error.details ?? [];
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, {
      error: {
        code: 'NETWORK_UNREACHABLE',
        message: 'Could not reach the API. Is the local server running?',
        requestId: 'client',
        details: [],
      },
    });
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new ApiError(response.status, body as ErrorEnvelope | null);
  }

  return body as T;
}
