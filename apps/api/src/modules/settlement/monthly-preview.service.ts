import {
  MonthlySettlementPreviewRequestSchema,
  MonthlySettlementPreviewResponseSchema,
  MonthlyReportContextSchema,
  SettlementPreviewInputSchema,
  type MonthlyReportContextProvider,
} from '@cornven/contracts';
import { ReportError } from '../../shared/report-errors.js';
import { monthAt, monthBounds, reportRange } from '../../shared/report-time.js';
import { calculateSettlementPreview } from './settlement.service.js';

/** Read only: only depends on the context reader and pure M3 calculator.
 * No report repository, task scheduler, PDF renderer or persistence dependency.
 */
export class MonthlySettlementPreviewService {
  constructor(
    private readonly provider: MonthlyReportContextProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(input: unknown) {
    const query = MonthlySettlementPreviewRequestSchema.parse(input);
    const calculatedAt = this.now();
    const currentMonth = monthAt(calculatedAt);
    if (query.settlementMonth > currentMonth)
      throw new ReportError(
        400,
        'FUTURE_SETTLEMENT_MONTH',
        'Choose the current month or an earlier month.',
      );
    // Closed months use the next-month boundary for M3's complete-month flag.
    // The actual inclusive read cutoff is still the last millisecond of that month.
    const asOf = (
      query.settlementMonth === currentMonth ? calculatedAt : monthBounds(query.settlementMonth).end
    ).toISOString();
    const { cutoff } = reportRange(query.settlementMonth, asOf);
    try {
      const context = MonthlyReportContextSchema.parse(
        await this.provider.getMonthlyReportContext({ ...query, asOf }),
      );
      if (context.artistId !== query.artistId) throw new Error('Context artist does not match.');
      const result = calculateSettlementPreview(
        SettlementPreviewInputSchema.parse({
          ...context,
          ...query,
          asOf,
          currency: 'TWD',
          businessTimezone: 'Asia/Taipei',
        }),
      );
      return MonthlySettlementPreviewResponseSchema.parse({
        ...query,
        calculatedAt: calculatedAt.toISOString(),
        dataCutoff: cutoff.toISOString(),
        readOnly: true,
        result,
      });
    } catch (error) {
      if (error instanceof ReportError && error.status === 404) throw error;
      throw new ReportError(
        503,
        'SETTLEMENT_DATA_UNAVAILABLE',
        'Settlement data could not be read or calculated.',
      );
    }
  }
}
