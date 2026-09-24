import { Prisma, type PrismaClient } from '@cornven/database';
import {
  MonthlyRefundMetricsRequestSchema,
  MonthlyRefundMetricsResponseSchema,
} from '@cornven/contracts';
import { monthAt, monthBounds, reportRange } from '../../shared/report-time.js';
import { ReportError } from '../../shared/report-errors.js';

/** Counts canonical refund events in the requested Taipei month, regardless of sale month.
 * No M3 calculation, report writes or model arithmetic. One transaction may contain several rows.
 */
export class MonthlyRefundMetricsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly now = () => new Date(),
  ) {}
  async search(input: unknown) {
    const query = MonthlyRefundMetricsRequestSchema.parse(input);
    const now = this.now();
    if (query.settlementMonth > monthAt(now))
      throw new ReportError(400, 'FUTURE_SETTLEMENT_MONTH', '请选择当前月份或之前的月份。');
    const asOf =
      query.settlementMonth === monthAt(now) ? now : monthBounds(query.settlementMonth).end;
    const { start, cutoff } = reportRange(query.settlementMonth, asOf.toISOString());
    try {
      return await this.db.$transaction(
        async (tx) => {
          if (
            !(await tx.artist.findUnique({ where: { id: query.artistId }, select: { id: true } }))
          )
            throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Artist not found.');
          const rows = await tx.sale.findMany({
            where: {
              artistId: query.artistId,
              recordType: 'REFUND',
              soldAt: { gte: start, lte: cutoff },
            },
            select: {
              quantitySold: true,
              grossSalesCents: true,
              sourceTransactionId: true,
              currency: true,
            },
          });
          let quantity = 0n,
            amount = 0n;
          const transactions = new Set<string>();
          for (const row of rows) {
            if (
              row.currency !== 'TWD' ||
              row.quantitySold >= 0 ||
              row.grossSalesCents >= 0n ||
              !row.sourceTransactionId
            )
              throw new Error('Invalid canonical refund');
            quantity -= BigInt(row.quantitySold);
            amount -= row.grossSalesCents;
            transactions.add(row.sourceTransactionId);
          }
          if (
            quantity > BigInt(Number.MAX_SAFE_INTEGER) ||
            amount > BigInt(Number.MAX_SAFE_INTEGER)
          )
            throw new Error('Unsafe aggregate');
          return MonthlyRefundMetricsResponseSchema.parse({
            ...query,
            dataCutoff: cutoff.toISOString(),
            currency: 'TWD',
            refundQuantity: Number(quantity),
            refundTransactionCount: transactions.size,
            refundRecordCount: rows.length,
            refundAmountCents: Number(amount),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (error instanceof ReportError) throw error;
      throw new ReportError(503, 'REFUND_DATA_UNAVAILABLE', '无法读取有效的退款数据，请稍后重试。');
    }
  }
}
