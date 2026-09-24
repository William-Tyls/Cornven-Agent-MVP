import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateReport } from './reports';
afterEach(() => vi.unstubAllGlobals());
describe('M7 report requests', () => {
  it('sends only the artist and generation intent; retries reuse the supplied key', async () => {
    const response = {
      reportId: 'r',
      artistId: 'a',
      displayName: 'Artist',
      settlementMonth: '2026-09',
      asOf: '2026-09-18T00:00:00Z',
      generatedAt: '2026-09-18T00:00:01Z',
      isProvisional: true,
      reportStatus: 'draft',
      generationStatus: 'ready',
      pdfFileReference: '/api/v1/reports/r/download',
    };
    const mock = vi.fn(async () => new Response(JSON.stringify(response), { status: 201 }));
    vi.stubGlobal('fetch', mock);
    await generateReport('a', 'same-key');
    await generateReport('a', 'same-key');
    for (const call of mock.mock.calls) {
      expect(call).toEqual([
        'http://127.0.0.1:3119/api/v1/reports',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Idempotency-Key': 'same-key' }),
          body: JSON.stringify({ artistId: 'a', period: 'current_month', format: 'pdf' }),
        }),
      ]);
    }
  });
  it('preserves error status for retry guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'REPORT_GENERATION_IN_PROGRESS',
                message: 'Retry',
                requestId: 'x',
                details: [],
              },
            }),
            { status: 409 },
          ),
      ),
    );
    await expect(generateReport('a', 'same')).rejects.toMatchObject({
      status: 409,
      code: 'REPORT_GENERATION_IN_PROGRESS',
    });
  });
});
