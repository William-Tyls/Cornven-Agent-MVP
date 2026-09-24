import {
  ApprovalCommandSchema,
  ApprovalDetailSchema,
  ApprovalListQuerySchema,
  ApprovalListResponseSchema,
  MonthlyReportDocumentSchema,
} from '@cornven/contracts';
import type { PrismaClient, ArtistMonthlyReport, MonthlyReportApproval } from '@cornven/database';
import { requireArtist, type ReportActor } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import { decodeCursor, encodeCursor } from '../../shared/report-cursor.js';
import { reportSummary } from '../reporting/report.repository.js';
const summary = (row: ArtistMonthlyReport & { approval: MonthlyReportApproval | null }) => ({
  ...reportSummary(row),
  approvalStatus: row.approval?.status.toLowerCase() ?? 'draft',
  approvalUpdatedAt: row.approval?.updatedAt.toISOString() ?? null,
});
export class ApprovalsService {
  constructor(private readonly db: PrismaClient) {}
  async detail(reportId: string, actor: ReportActor) {
    const row = await this.db.artistMonthlyReport.findFirst({
      where: { id: reportId, tasks: { some: { status: 'SUCCEEDED' } } },
      include: {
        approval: { include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } },
      },
    });
    if (!row) throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Saved report not found.');
    requireArtist(actor, row.artistId);
    return ApprovalDetailSchema.parse({
      summary: summary(row),
      report: MonthlyReportDocumentSchema.parse(row.reportJson),
      events: (row.approval?.events ?? []).map((event) => ({
        id: event.id,
        action: event.action.toLowerCase(),
        actorId: event.actorId,
        reason: event.reason,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  }
  async list(input: unknown, actor: ReportActor) {
    const query = ApprovalListQuerySchema.parse(input);
    const filter = JSON.stringify({
      status: query.status,
      artistQuery: query.artistQuery,
      month: query.settlementMonth,
      scope: actor.artistIds,
    });
    const cursor = decodeCursor(query.cursor, filter);
    if (cursor && !cursor.time) throw new ReportError(400, 'VALIDATION_FAILED', 'Invalid cursor.');
    const status =
      query.status === 'pending'
        ? 'PENDING'
        : query.status === 'approved'
          ? 'APPROVED'
          : 'REJECTED';
    const rows = await this.db.artistMonthlyReport.findMany({
      where: {
        AND: [
          { tasks: { some: { status: 'SUCCEEDED' } } },
          actor.artistIds === '*' ? {} : { artistId: { in: [...actor.artistIds] } },
          query.settlementMonth ? { settlementMonth: query.settlementMonth } : {},
          query.artistQuery
            ? {
                artist: {
                  OR: [
                    { name: { contains: query.artistQuery, mode: 'insensitive' } },
                    { brandName: { contains: query.artistQuery, mode: 'insensitive' } },
                    { externalRef: { contains: query.artistQuery, mode: 'insensitive' } },
                  ],
                },
              }
            : {},
          !query.status
            ? {}
            : query.status === 'draft'
              ? { approval: { is: null } }
              : { approval: { is: { status } } },
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
    return ApprovalListResponseSchema.parse({
      items: selected.map(summary),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(filter, last.id, last.generatedAt.toISOString())
          : null,
    });
  }
  async act(reportId: string, input: unknown, actor: ReportActor) {
    const command = ApprovalCommandSchema.parse(input);
    // Only successfully generated, accessible snapshots can enter the workflow.
    await this.detail(reportId, actor);
    await this.db.$transaction(async (tx) => {
      // Serialize all commands for this version, including its first submission.
      await tx.$queryRaw`SELECT "id" FROM "ArtistMonthlyReport" WHERE "id" = ${reportId} FOR UPDATE`;
      const previous = await tx.monthlyReportApprovalEvent.findUnique({
        where: { reportId_requestId: { reportId, requestId: command.requestId } },
      });
      const action =
        command.action === 'submit'
          ? 'SUBMIT'
          : command.action === 'approve'
            ? 'APPROVE'
            : 'REJECT';
      const reason = command.reason || null;
      if (previous) {
        if (
          previous.action !== action ||
          previous.reason !== reason ||
          previous.actorId !== actor.id
        )
          throw new ReportError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request ID was used for a different action.',
          );
        return;
      }
      const existing = await tx.monthlyReportApproval.findUnique({ where: { reportId } });
      if (action === 'SUBMIT') {
        if (existing)
          throw new ReportError(
            409,
            'APPROVAL_STATE_CONFLICT',
            'This version was already submitted. Review it, or generate a new version after rejection.',
          );
        await tx.monthlyReportApproval.create({ data: { reportId } });
      } else {
        if (existing?.status !== 'PENDING')
          throw new ReportError(
            409,
            'APPROVAL_STATE_CONFLICT',
            'Only a pending report can be approved or rejected. Refresh to see its current status.',
          );
        await tx.monthlyReportApproval.update({
          where: { reportId },
          data: { status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED' },
        });
      }
      await tx.monthlyReportApprovalEvent.create({
        data: {
          reportId,
          action,
          actorId: actor.id,
          reason,
          requestId: command.requestId,
        },
      });
    });
    return this.detail(reportId, actor);
  }
}
