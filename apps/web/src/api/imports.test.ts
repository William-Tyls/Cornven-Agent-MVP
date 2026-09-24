import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeMockImport, normalizeCsvImport } from './imports';
import { mockPosImport } from '../fixtures/mockPos';

describe('normalizeMockImport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the complete raw POS request to the v0.3 normalize endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ summary: {}, records: [], auditEvents: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await normalizeMockImport(mockPosImport);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3119/api/v1/imports/mock/normalize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(mockPosImport),
      }),
    );
  });
});

it('sends the selected CSV text and explicit rate unit instead of a fixture batch', async () => {
  const csv = 'recordType,sourceRecordId\nsale,selected-file-row';
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ summary: {}, records: [], auditEvents: [] }), { status: 200 }),
    );
  vi.stubGlobal('fetch', fetchMock);
  try {
    await normalizeCsvImport(csv, 'percentage');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3119/api/v1/imports/csv/normalize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ csv, commissionRateUnit: 'percentage' }),
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
