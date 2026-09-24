import { describe, expect, it } from 'vitest';
import { readSseData } from './assistant-stream.js';
function bytes(text: string) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
}
async function collect(text: string) {
  const events: string[] = [];
  for await (const data of readSseData(bytes(text))) events.push(data);
  return events;
}
describe('SSE framing', () => {
  it('handles split UTF-8, CRLF, comments and multi-line data', async () => {
    expect(
      await collect(
        ': heartbeat\r\n\r\nevent: delta\r\ndata: 退款😀\r\ndata: 第二行\r\n\r\ndata: done\n\n',
      ),
    ).toEqual(['退款😀\n第二行', 'done']);
  });
  it('rejects truncated frames', async () => {
    await expect(collect('data: partial\n')).rejects.toThrow('Incomplete');
  });
  it('limits incomplete frame memory', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(1_000_001)));
        c.close();
      },
    });
    await expect(readSseData(body).next()).rejects.toThrow('too large');
  });
  it('cancels the upstream body when the consumer stops at final', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: done\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const data of readSseData(body)) {
      expect(data).toBe('done');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
