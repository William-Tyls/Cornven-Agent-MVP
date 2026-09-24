import { randomUUID } from 'node:crypto';

import type { Request } from 'express';

export function getRequestId(request: Request): string {
  const header = request.header('x-request-id');
  return header && header.trim().length > 0 ? header : randomUUID();
}
