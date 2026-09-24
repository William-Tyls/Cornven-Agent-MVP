import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  MonthlySettlementPreviewResponseSchema,
  type MonthlyReportContext,
} from '@cornven/contracts';
import { MonthlySettlementPreviewService } from '../src/modules/settlement/monthly-preview.service.js';
import { createMonthlyPreviewRouter } from '../src/modules/settlement/monthly-preview.routes.js';
import { errorHandler } from '../src/shared/errors.js';
import { ReportError } from '../src/shared/report-errors.js';

const artistId = 'b9e0a2d0-a19e-4fef-b3ec-1f670f8836af';
const query = { artistId, settlementMonth: '2026-09' };
const context: MonthlyReportContext = {
  artistId,
  artistName: 'Zero sales artist',
  brandName: null,
  sales: [],
  historicalRecords: [],
  rentals: [],
  inventory: null,
  bankTransferFeeCents: null,
};
function setup(now = '2026-09-20T04:00:00.000Z') {
  const getMonthlyReportContext = vi.fn(async () => structuredClone(context));
  const service = new MonthlySettlementPreviewService(
    { getMonthlyReportContext },
    () => new Date(now),
  );
  const app = express()
    .use(express.json())
    .use('/api/v1', createMonthlyPreviewRouter(service))
    .use(errorHandler);
  return { getMonthlyReportContext, service, app };
}
describe('read-only monthly settlement preview', () => {
  it('derives the current-month cutoff on the server and preserves unknown amounts', async () => {
    const { service, getMonthlyReportContext } = setup();
    const result = MonthlySettlementPreviewResponseSchema.parse(await service.preview(query));
    expect(getMonthlyReportContext).toHaveBeenCalledWith({
      ...query,
      asOf: '2026-09-20T04:00:00.000Z',
    });
    expect(result).toMatchObject({
      readOnly: true,
      dataCutoff: '2026-09-20T04:00:00.000Z',
      result: {
        isProvisional: true,
        totalProductSalesCents: 0,
        bankTransferFeeCents: null,
        amountPayableToCreatorCents: null,
        lowStockReminder: { status: 'unavailable' },
      },
    });
  });
  it('closes an earlier month at the Taipei boundary including leap day', async () => {
    const { service, getMonthlyReportContext } = setup();
    const result = await service.preview({ ...query, settlementMonth: '2024-02' });
    expect(getMonthlyReportContext).toHaveBeenCalledWith({
      ...query,
      settlementMonth: '2024-02',
      asOf: '2024-02-29T16:00:00.000Z',
    });
    expect(result.dataCutoff).toBe('2024-02-29T15:59:59.999Z');
    expect(result.result.settlementPeriod.to).toBe('2024-02-29');
    expect(result.result.isProvisional).toBe(false);
  });
  it('uses Taipei month rather than the UTC month at midnight', async () => {
    const { service } = setup('2026-08-31T16:00:00.000Z');
    const result = await service.preview(query);
    expect(result.result.settlementPeriod.from).toBe('2026-09-01');
    expect(result.result.settlementPeriod.to).toBe('2026-09-01');
    expect(result.result.isProvisional).toBe(true);
  });
  it('rejects future months before reading database data', async () => {
    const { service, getMonthlyReportContext } = setup();
    await expect(service.preview({ ...query, settlementMonth: '2026-10' })).rejects.toMatchObject({
      status: 400,
      code: 'FUTURE_SETTLEMENT_MONTH',
    });
    expect(getMonthlyReportContext).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs/months and client-supplied calculation context', async () => {
    const { app, getMonthlyReportContext } = setup();
    for (const input of [
      {},
      { ...query, artistId: 'ART-001' },
      { ...query, settlementMonth: '2026-13' },
      { ...query, sales: [] },
      { ...query, asOf: '2026-09-30T00:00:00Z' },
      { ...query, bankTransferFeeCents: 0 },
    ]) {
      const response = await request(app).post('/api/v1/settlements/monthly-preview').send(input);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(getMonthlyReportContext).not.toHaveBeenCalled();
  });
  it('returns the same validated response through the HTTP and M5 tool entry points', async () => {
    const { app } = setup();
    const http = await request(app).post('/api/v1/settlements/monthly-preview').send(query);
    const tool = await request(app).post('/api/v1/assistant/tools/settlement.preview').send(query);
    expect(http.status).toBe(200);
    expect(tool.status).toBe(200);
    expect(http.headers['cache-control']).toBe('no-store');
    expect(tool.body).toEqual(http.body);
    expect(http.body).not.toHaveProperty('reportId');
  });
  it('preserves not-found errors and does not return invented zero totals on data failure', async () => {
    const { app, getMonthlyReportContext } = setup();
    getMonthlyReportContext.mockRejectedValueOnce(
      new ReportError(404, 'RESOURCE_NOT_FOUND', 'Artist not found.'),
    );
    expect(
      (await request(app).post('/api/v1/settlements/monthly-preview').send(query)).status,
    ).toBe(404);
    getMonthlyReportContext.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(app).post('/api/v1/settlements/monthly-preview').send(query);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SETTLEMENT_DATA_UNAVAILABLE');
    expect(response.body).not.toHaveProperty('result');
  });
  it('rejects mismatched upstream artist context', async () => {
    const { service, getMonthlyReportContext } = setup();
    getMonthlyReportContext.mockResolvedValueOnce({ ...context, artistId: 'different-artist' });
    await expect(service.preview(query)).rejects.toMatchObject({
      status: 503,
      code: 'SETTLEMENT_DATA_UNAVAILABLE',
    });
  });
});
