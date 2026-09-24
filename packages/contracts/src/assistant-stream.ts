import { z } from 'zod';
import { AssistantAnswerSchema } from './assistant.js';

export const AssistantStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), message: z.string().min(1) }).strict(),
  z.object({ type: z.literal('text_delta'), delta: z.string() }).strict(),
  z.object({ type: z.literal('final'), answer: AssistantAnswerSchema }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    })
    .strict(),
]);
export type AssistantStreamEvent = z.infer<typeof AssistantStreamEventSchema>;

// Shared by the browser and the provider adapter. Decode UTF-8 across byte boundaries,
// support CRLF and multi-line data, ignore heartbeats, and reject truncated frames.
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        size += line.length;
        if (size > 1_000_000) throw new Error('SSE frame too large');
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          size = 0;
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (buffer.length + size > 1_000_000) throw new Error('SSE frame too large');
      if (done) {
        if (buffer.trim() || data.length) throw new Error('Incomplete SSE frame');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
