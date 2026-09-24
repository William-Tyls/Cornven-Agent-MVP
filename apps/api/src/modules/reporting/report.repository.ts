import { createHash, randomUUID } from 'node:crypto';
import {
  MonthlyReportDocumentSchema,
  ReportListQuerySchema,
  ReportListResponseSchema,
  ReportSummarySchema,
  type MonthlyReportDocument,
  type SettlementPreview,
  type SettlementPreviewInput,
} from '@cornven/contracts';
import {
  Prisma,
  type PrismaClient,
  type ReportGenerationTask,
  type ArtistMonthlyReport,
} from '@cornven/database';
import type { ReportActor } from '../../shared/report-auth.js';
import { requireArtist } from '../../shared/report-auth.js';
import { decodeCursor, encodeCursor } from '../../shared/report-cursor.js';
import { ReportError } from '../../shared/report-errors.js';
import type { StoredReportArtifact } from './report-artifact-storage.js';

export type GenerateReportCommand = {
  artistId: string;
  settlementMonth: string;
  asOf: string;
  trigger: 'manual' | 'scheduled';
};
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const busy = () =>
  new ReportError(
    409,
    'REPORT_GENERATION_IN_PROGRESS',
    'Report generation is in progress. Retry with the same key.',
  );

export function reportSummary(row: ArtistMonthlyReport & { approval?: { status: string } | null }) {
  const report = MonthlyReportDocumentSchema.parse(row.reportJson);
  return ReportSummarySchema.parse({
    reportId: row.id,
    artistId: row.artistId,
    displayName: report.creator.displayName,
    settlementMonth: row.settlementMonth,
    asOf: row.asOf.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    isProvisional: row.isProvisional,
    reportStatus: 'draft',
    generationStatus: 'ready',
    pdfFileReference: `/api/v1/reports/${row.id}/download`,
    trigger: row.trigger,
    version: row.version,
    ...(row.approval !== undefined
      ? { approvalStatus: row.approval?.status.toLowerCase() ?? 'draft' }
      : {}),
  });
}

export class ReportRepository {
  constructor(readonly db: PrismaClient) {}

  async getOrCreate(
    command: GenerateReportCommand,
    actorId: string,
    key: string,
    fingerprint: string,
    now: Date,
  ) {
    const scopedKey = createHash('sha256')
      .update(JSON.stringify([actorId, key]))
      .digest('hex');
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.reportGenerationTask.findUnique({
          where: { idempotencyKey: scopedKey },
        });
        if (existing) return { task: this.match(existing, fingerprint), created: false };
        const task = await tx.reportGenerationTask.create({
          data: {
            ...command,
            asOf: new Date(command.asOf),
            actorId,
            idempotencyKey: scopedKey,
            requestFingerprint: fingerprint,
            createdAt: now,
          },
        });
        if (command.trigger === 'scheduled') {
          await tx.scheduledReportLock.create({
            data: {
              artistId: command.artistId,
              settlementMonth: command.settlementMonth,
              taskId: task.id,
            },
          });
        }
        return { task, created: true };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003')
        throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Artist not found.');
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.db.reportGenerationTask.findUnique({
          where: { idempotencyKey: scopedKey },
        });
        if (existing) return { task: this.match(existing, fingerprint), created: false };
      }
      throw error;
    }
  }

  private match(task: ReportGenerationTask, fingerprint: string) {
    if (task.requestFingerprint !== fingerprint)
      throw new ReportError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different request.',
      );
    return task;
  }

  async claim(id: string, now: Date, maxAttempts: number) {
    const token = randomUUID();
    const result = await this.db.reportGenerationTask.updateMany({
      where: {
        id,
        attemptCount: { lt: maxAttempts },
        OR: [
          { status: 'QUEUED' },
          { status: 'FAILED' },
          { status: 'RUNNING', leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'RUNNING',
        attemptCount: { increment: 1 },
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + 120_000),
        nextRetryAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (!result.count) {
      const task = await this.db.reportGenerationTask.findUniqueOrThrow({ where: { id } });
      if (task.status === 'SUCCEEDED') return null;
      if (task.attemptCount >= maxAttempts && task.status !== 'RUNNING') {
        throw new ReportError(
          500,
          'REPORT_GENERATION_FAILED',
          'Retry limit reached. Start a new report or reset the failed task locally.',
        );
      }
      throw busy();
    }
    return { token, task: await this.db.reportGenerationTask.findUniqueOrThrow({ where: { id } }) };
  }

  async renew(id: string, token: string, now: Date) {
    const result = await this.db.reportGenerationTask.updateMany({
      where: { id, leaseToken: token, status: 'RUNNING', leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + 120_000) },
    });
    return result.count === 1;
  }

  private async lockTask(tx: Prisma.TransactionClient, id: string, token: string, now: Date) {
    await tx.$queryRaw`SELECT "id" FROM "ReportGenerationTask" WHERE "id" = ${id} FOR UPDATE`;
    const task = await tx.reportGenerationTask.findUniqueOrThrow({ where: { id } });
    if (
      task.status !== 'RUNNING' ||
      task.leaseToken !== token ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= now
    )
      throw busy();
    return task;
  }

  async freeze(
    id: string,
    token: string,
    input: SettlementPreviewInput,
    output: SettlementPreview,
    document: MonthlyReportDocument,
    now: Date,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, id, token, now);
      if (task.reportId)
        return tx.artistMonthlyReport.findUniqueOrThrow({ where: { id: task.reportId } });
      // Artist row lock serializes version allocation across tasks/processes without a read+increment race.
      await tx.$queryRaw`SELECT "id" FROM "Artist" WHERE "id" = ${task.artistId} FOR UPDATE`;
      const latest = await tx.artistMonthlyReport.aggregate({
        where: { artistId: task.artistId, settlementMonth: task.settlementMonth },
        _max: { version: true },
      });
      const report = await tx.artistMonthlyReport.create({
        data: {
          id: document.reportId,
          artistId: task.artistId,
          settlementMonth: task.settlementMonth,
          asOf: task.asOf,
          generatedAt: new Date(document.generatedAt),
          trigger: task.trigger,
          version: (latest._max.version ?? 0) + 1,
          isProvisional: document.isProvisional,
          schemaVersion: 'm3-pr25/report-v1',
          reportJson: json(document),
          inputSnapshot: { create: { m3InputJson: json(input), m3OutputJson: json(output) } },
        },
      });
      await tx.reportGenerationTask.update({ where: { id }, data: { reportId: report.id } });
      return report;
    });
  }

  async complete(id: string, token: string, artifact: StoredReportArtifact, now: Date) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, id, token, now);
      if (task.reportId !== artifact.reportId) throw new Error('Artifact mismatch');
      await tx.reportArtifact.upsert({
        where: { storageKey: artifact.storageKey },
        update: {},
        create: {
          reportId: artifact.reportId,
          storageKey: artifact.storageKey,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          byteSize: artifact.sizeBytes,
          sha256: artifact.checksumSha256,
          createdAt: new Date(artifact.createdAt),
          expiresAt: new Date(artifact.expiresAt),
        },
      });
      await tx.reportGenerationTask.update({
        where: { id },
        data: { status: 'SUCCEEDED', leaseToken: null, leaseExpiresAt: null, nextRetryAt: null },
      });
      return tx.artistMonthlyReport.findUniqueOrThrow({ where: { id: artifact.reportId } });
    });
  }

  async fail(
    task: ReportGenerationTask,
    token: string,
    error: ReportError,
    now: Date,
    maxAttempts: number,
  ) {
    await this.db.reportGenerationTask.updateMany({
      where: { id: task.id, status: 'RUNNING', leaseToken: token },
      data: {
        status: 'FAILED',
        errorCode: error.code,
        errorMessage: error.message,
        leaseToken: null,
        leaseExpiresAt: null,
        nextRetryAt:
          task.attemptCount < maxAttempts
            ? new Date(now.getTime() + (task.attemptCount === 1 ? 60_000 : 300_000))
            : null,
      },
    });
  }

  async completedForTask(id: string) {
    const task = await this.db.reportGenerationTask.findUniqueOrThrow({ where: { id } });
    if (task.status !== 'SUCCEEDED' || !task.reportId) throw busy();
    return this.db.artistMonthlyReport.findUniqueOrThrow({ where: { id: task.reportId } });
  }

  async getReport(id: string, actor: ReportActor) {
    const report = await this.db.artistMonthlyReport.findFirst({
      where: { id, tasks: { some: { status: 'SUCCEEDED' } } },
    });
    if (!report) throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Report not found.');
    requireArtist(actor, report.artistId);
    return report;
  }

  async listReports(input: unknown, actor: ReportActor) {
    const query = ReportListQuerySchema.parse(input);
    if (query.artistId) requireArtist(actor, query.artistId);
    const filter = JSON.stringify({
      artistId: query.artistId ?? null,
      settlementMonth: query.settlementMonth ?? null,
    });
    const cursor = decodeCursor(query.cursor, filter);
    if (cursor && !cursor.time)
      throw new ReportError(400, 'VALIDATION_FAILED', 'Invalid report cursor.');
    const rows = await this.db.artistMonthlyReport.findMany({
      where: {
        AND: [
          { tasks: { some: { status: 'SUCCEEDED' } } },
          actor.artistIds === '*' ? {} : { artistId: { in: [...actor.artistIds] } },
          query.artistId ? { artistId: query.artistId } : {},
          query.settlementMonth ? { settlementMonth: query.settlementMonth } : {},
          cursor
            ? {
                OR: [
                  { generatedAt: { lt: new Date(cursor.time!) } },
                  { generatedAt: new Date(cursor.time!), id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: { approval: true },
      orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const selected = rows.slice(0, query.limit),
      last = selected.at(-1);
    return ReportListResponseSchema.parse({
      items: selected.map(reportSummary),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(filter, last.id, last.generatedAt.toISOString())
          : null,
    });
  }

  async dueTasks(now: Date, maxAttempts: number, limit = 100) {
    // A process may die on its final attempt; recover that expired lease as a terminal failure.
    await this.db.reportGenerationTask.updateMany({
      where: {
        status: 'RUNNING',
        leaseExpiresAt: { lte: now },
        attemptCount: { gte: maxAttempts },
      },
      data: {
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: 'REPORT_GENERATION_FAILED',
        errorMessage: 'Worker lease expired after final attempt.',
      },
    });
    return this.db.reportGenerationTask.findMany({
      where: {
        attemptCount: { lt: maxAttempts },
        OR: [
          { status: 'QUEUED' },
          { status: 'FAILED', nextRetryAt: { lte: now } },
          { status: 'RUNNING', leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }
}
