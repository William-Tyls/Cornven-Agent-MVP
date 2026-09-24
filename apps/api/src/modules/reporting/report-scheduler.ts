import { SettlementMonthSchema } from '@cornven/contracts';
import type { DatabaseMonthlyReportContext } from '../import/database-monthly-report-context.service.js';
import { monthAt, monthBounds, shiftMonth } from '../../shared/report-time.js';
import { ReportError } from '../../shared/report-errors.js';
import type { MonthlyReportingService } from './reporting.service.js';

export class ReportScheduler {
  private running = false;
  constructor(
    private readonly service: MonthlyReportingService,
    private readonly data: DatabaseMonthlyReportContext,
    private readonly startMonth: string,
    private readonly delayMinutes = 10,
  ) {
    SettlementMonthSchema.parse(startMonth);
    if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 1439)
      throw new Error('Invalid scheduler delay');
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.service.now();
      const db = this.service.repository.db;
      for (let month = this.startMonth; month < monthAt(now); month = shiftMonth(month, 1)) {
        const { end } = monthBounds(month);
        if (now.getTime() < end.getTime() + this.delayMinutes * 60_000) continue;
        let checkpoint = await db.reportScheduleCheckpoint.upsert({
          where: { settlementMonth: month },
          create: { settlementMonth: month },
          update: {},
        });
        while (!checkpoint.enumerated) {
          const page = await this.data.listMonthlyReportArtistIds({
            settlementMonth: month,
            asOf: end.toISOString(),
            limit: 100,
            ...(checkpoint.artistCursor ? { cursor: checkpoint.artistCursor } : {}),
          });
          for (const artistId of page.artistIds)
            await this.service.enqueueScheduled({
              artistId,
              settlementMonth: month,
              asOf: end.toISOString(),
              trigger: 'scheduled',
            });
          await db.reportScheduleCheckpoint.updateMany({
            where: {
              settlementMonth: month,
              artistCursor: checkpoint.artistCursor,
              enumerated: false,
            },
            data: { artistCursor: page.nextCursor, enumerated: page.nextCursor === null },
          });
          checkpoint = await db.reportScheduleCheckpoint.findUniqueOrThrow({
            where: { settlementMonth: month },
          });
        }
      }
      const tasks = await this.service.repository.dueTasks(now, this.service.maxAttempts);
      for (const task of tasks) {
        try {
          await this.service.runTask(task.id);
        } catch (error) {
          // Each task persists its own failure/backoff. A busy lease belongs to another worker.
          if (!(error instanceof ReportError)) throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }
  async batchStatus(settlementMonth: string) {
    SettlementMonthSchema.parse(settlementMonth);
    const db = this.service.repository.db;
    const checkpoint = await db.reportScheduleCheckpoint.findUnique({ where: { settlementMonth } });
    const groups = await db.reportGenerationTask.groupBy({
      by: ['status'],
      where: { settlementMonth, trigger: 'scheduled' },
      _count: true,
    });
    const counts = Object.fromEntries(groups.map((group) => [group.status, group._count]));
    const pending = (counts.QUEUED ?? 0) + (counts.RUNNING ?? 0);
    const failed = counts.FAILED ?? 0,
      succeeded = counts.SUCCEEDED ?? 0;
    const status = !checkpoint
      ? 'queued'
      : !checkpoint.enumerated || pending
        ? 'running'
        : failed
          ? succeeded
            ? 'partial_success'
            : 'failed'
          : 'success';
    return { settlementMonth, status, counts, enumerated: checkpoint?.enumerated ?? false };
  }
  start(intervalMs = 30_000) {
    const tick = () => {
      void this.tick().catch((error) =>
        console.error(
          'Report scheduler failed:',
          error instanceof Error ? error.message : 'Unknown failure',
        ),
      );
    };
    tick();
    const interval = setInterval(tick, intervalMs);
    interval.unref();
    return () => clearInterval(interval);
  }
}
