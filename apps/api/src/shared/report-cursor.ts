import { z } from 'zod';
import { ReportError } from './report-errors.js';
const CursorSchema = z
  .object({ filter: z.string(), id: z.string().min(1), time: z.string().datetime().optional() })
  .strict();
export function encodeCursor(filter: string, id: string, time?: string): string {
  return Buffer.from(JSON.stringify({ filter, id, ...(time ? { time } : {}) })).toString(
    'base64url',
  );
}
export function decodeCursor(cursor: string | undefined, filter: string) {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid encoding');
    const value = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (value.filter !== filter) throw new Error('Mismatched query');
    return value;
  } catch {
    throw new ReportError(400, 'VALIDATION_FAILED', 'Invalid cursor for this query.');
  }
}
