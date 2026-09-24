import { describe, it, expect, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@cornven/database';
import { MonthlyRefundMetricsService } from '../src/modules/sales/monthly-refund-metrics.service.js';
const artistId = 'b9e0a2d0-a19e-4fef-b3ec-1f670f8836af';
const query = { artistId, settlementMonth: '2026-09' };
const refund = {
  quantitySold: -2,
  grossSalesCents: -10000n,
  sourceTransactionId: 'REFUND-1',
  currency: 'TWD',
};
function setup(rows = [refund], now = '2026-09-20T04:00:00Z') {
  const findMany = vi.fn(async () => rows);
  const findUnique = vi.fn(async () => ({ id: artistId }));
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ artist: { findUnique }, sale: { findMany } }),
  );
  const service = new MonthlyRefundMetricsService(
    { $transaction: transaction } as unknown as PrismaClient,
    () => new Date(now),
  );
  return { service, transaction, findMany, findUnique };
}
describe('monthly refund metrics', () => {
  it('separates units, distinct transactions, rows and amount', async () => {
    const { service, findMany, transaction } = setup([
      refund,
      { ...refund, quantitySold: -3 },
      { ...refund, quantitySold: -4, sourceTransactionId: 'REFUND-2' },
    ]);
    expect(await service.search(query)).toMatchObject({
      refundQuantity: 9,
      refundRecordCount: 3,
      refundTransactionCount: 2,
      refundAmountCents: 30000,
      dataCutoff: '2026-09-20T04:00:00.000Z',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artistId,
          recordType: 'REFUND',
          soldAt: { gte: new Date('2026-08-31T16:00:00Z'), lte: new Date('2026-09-20T04:00:00Z') },
        },
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });
  it('uses the full previous month including its final millisecond', async () => {
    const { service, findMany } = setup();
    expect((await service.search({ ...query, settlementMonth: '2026-08' })).dataCutoff).toBe(
      '2026-08-31T15:59:59.999Z',
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          soldAt: {
            gte: new Date('2026-07-31T16:00:00Z'),
            lte: new Date('2026-08-31T15:59:59.999Z'),
          },
        }),
      }),
    );
  });
  it('does not filter refunds by the date of their original sale', async () => {
    const { service, findMany } = setup();
    await service.search(query);
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: { artistId, recordType: 'REFUND', soldAt: expect.any(Object) },
      }),
    ]);
  });
  it('returns true zeroes when the artist exists but has no refunds', async () => {
    const { service } = setup([]);
    expect(await service.search(query)).toMatchObject({
      refundQuantity: 0,
      refundTransactionCount: 0,
      refundRecordCount: 0,
      refundAmountCents: 0,
    });
  });
  it('rejects a future month before querying the database', async () => {
    const { service, transaction } = setup();
    await expect(service.search({ ...query, settlementMonth: '2026-10' })).rejects.toMatchObject({
      status: 400,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...refund, quantitySold: 2 },
    { ...refund, grossSalesCents: 1n },
    { ...refund, currency: 'USD' },
  ])('rejects invalid canonical refund data', async (row) => {
    await expect(setup([row]).service.search(query)).rejects.toMatchObject({
      code: 'REFUND_DATA_UNAVAILABLE',
    });
  });
  it('rejects an unsafe aggregate instead of rounding it', async () => {
    const { service } = setup([
      { ...refund, grossSalesCents: -BigInt(Number.MAX_SAFE_INTEGER) },
      refund,
    ]);
    await expect(service.search(query)).rejects.toMatchObject({ code: 'REFUND_DATA_UNAVAILABLE' });
  });
});
