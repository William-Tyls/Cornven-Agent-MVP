import { createHash } from 'node:crypto';
import {
  DeliveryProfileInputSchema,
  DeliveryProfileSchema,
  DeliveryRecordSchema,
  DeliveryListQuerySchema,
  DeliveryListResponseSchema,
  DeliveryConfigSchema,
  SendReportRequestSchema,
} from '@cornven/contracts';
import type { Prisma, PrismaClient } from '@cornven/database';
import { requireArtist, type ReportActor } from '../../shared/report-auth.js';
import { ReportError } from '../../shared/report-errors.js';
import { decodeCursor, encodeCursor } from '../../shared/report-cursor.js';
import { monthAt, shiftMonth } from '../../shared/report-time.js';
import type { MonthlyReportingService } from '../reporting/reporting.service.js';
import { MailSendError, type ReportMailer } from './mail-transport.js';
const system: ReportActor = { id: 'system:delivery', artistIds: '*' };
const include = { artist: true, report: true } as const;
type Row = Prisma.MonthlyReportDeliveryGetPayload<{ include: typeof include }>;
const present = (row: Row) =>
  DeliveryRecordSchema.parse({
    id: row.id,
    artistId: row.artistId,
    artistName: row.artist.name,
    reportId: row.reportId,
    settlementMonth: row.settlementMonth,
    version: row.report?.version ?? null,
    recipientEmail: row.recipientEmail,
    trigger: row.trigger,
    mode: row.mode,
    status: row.status.toLowerCase(),
    actorId: row.actorId,
    attemptCount: row.attemptCount,
    messageId: row.messageId,
    pdfChecksum: row.pdfChecksum,
    sentAt: row.sentAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  });
const dedupe = (reportId: string, recipient: string, mode: string) =>
  createHash('sha256')
    .update(JSON.stringify([reportId, recipient, mode]))
    .digest('hex');
export class DeliveryService {
  private running = false;
  constructor(
    readonly db: PrismaClient,
    private readonly reports: MonthlyReportingService,
    readonly mailer: ReportMailer,
    readonly now: () => Date = () => new Date(),
  ) {}
  config() {
    const now = this.now();
    const month = monthAt(now);
    const due = new Date(`${month}-01T10:00:00+08:00`);
    return DeliveryConfigSchema.parse({
      mode: this.mailer.mode,
      configured: this.mailer.configured,
      from: this.mailer.from,
      timezone: 'Asia/Taipei',
      schedule: 'Every month on day 1 at 10:00',
      nextScheduledAt: (now < due
        ? due
        : new Date(`${shiftMonth(month, 1)}-01T10:00:00+08:00`)
      ).toISOString(),
      inboxUrl: this.mailer.mode === 'local' ? 'http://127.0.0.1:58025' : null,
    });
  }
  async profile(artistId: string, actor: ReportActor) {
    requireArtist(actor, artistId);
    if (!(await this.db.artist.findUnique({ where: { id: artistId } })))
      throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Artist not found.');
    const profile = await this.db.artistDeliveryProfile.findUnique({ where: { artistId } });
    return DeliveryProfileSchema.parse({
      artistId,
      recipientEmail: profile?.recipientEmail ?? null,
      automaticEnabled: profile?.automaticEnabled ?? false,
    });
  }
  async saveProfile(artistId: string, input: unknown, actor: ReportActor) {
    const value = DeliveryProfileInputSchema.parse(input);
    await this.profile(artistId, actor);
    await this.db.artistDeliveryProfile.upsert({
      where: { artistId },
      create: { artistId, ...value, updatedBy: actor.id },
      update: { ...value, updatedBy: actor.id },
    });
    return this.profile(artistId, actor);
  }
  private requireConfigured() {
    if (!this.mailer.configured || this.mailer.mode === 'disabled')
      throw new ReportError(503, 'MAIL_NOT_CONFIGURED', 'Configure report email delivery first.');
  }
  async send(input: unknown, actor: ReportActor) {
    this.requireConfigured();
    const { reportId } = SendReportRequestSchema.parse(input);
    const report = await this.reports.repository.getReport(reportId, actor);
    const approval = await this.db.monthlyReportApproval.findUnique({ where: { reportId } });
    if (approval?.status !== 'APPROVED')
      throw new ReportError(
        409,
        'REPORT_NOT_APPROVED',
        'Only an approved report version can be sent.',
      );
    const profile = await this.profile(report.artistId, actor);
    if (!profile.recipientEmail)
      throw new ReportError(409, 'RECIPIENT_REQUIRED', 'Save an artist recipient email first.');
    const key = dedupe(reportId, profile.recipientEmail, this.mailer.mode);
    await this.db.monthlyReportDelivery.createMany({
      skipDuplicates: true,
      data: [
        {
          artistId: report.artistId,
          reportId,
          settlementMonth: report.settlementMonth,
          recipientEmail: profile.recipientEmail,
          mode: this.mailer.mode,
          trigger: 'manual',
          actorId: actor.id,
          dedupeKey: key,
        },
      ],
    });
    const row = await this.db.monthlyReportDelivery.findUniqueOrThrow({
      where: { dedupeKey: key },
    });
    await this.process(row.id);
    return present(
      await this.db.monthlyReportDelivery.findUniqueOrThrow({ where: { id: row.id }, include }),
    );
  }
  async retry(id: string, actor: ReportActor) {
    this.requireConfigured();
    const row = await this.db.monthlyReportDelivery.findUnique({ where: { id } });
    if (!row) throw new ReportError(404, 'RESOURCE_NOT_FOUND', 'Delivery not found.');
    requireArtist(actor, row.artistId);
    if (row.mode !== this.mailer.mode)
      throw new ReportError(
        409,
        'DELIVERY_MODE_CHANGED',
        'Use the original delivery channel to retry.',
      );
    // Only definitive failures are retryable. Unknown SMTP outcomes never auto-resend.
    const changed = await this.db.monthlyReportDelivery.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'QUEUED', errorCode: null, errorMessage: null },
    });
    if (!changed.count)
      throw new ReportError(
        409,
        'DELIVERY_STATE_CONFLICT',
        'Only a definitively failed delivery can be retried. Refresh its status.',
      );
    await this.process(id);
    return present(
      await this.db.monthlyReportDelivery.findUniqueOrThrow({ where: { id }, include }),
    );
  }
  async list(input: unknown, actor: ReportActor) {
    const query = DeliveryListQuerySchema.parse(input);
    if (query.artistId) requireArtist(actor, query.artistId);
    const filter = JSON.stringify({
      artistId: query.artistId,
      month: query.settlementMonth,
      status: query.status,
      scope: actor.artistIds,
    });
    const cursor = decodeCursor(query.cursor, filter);
    if (cursor && !cursor.time) throw new ReportError(400, 'VALIDATION_FAILED', 'Invalid cursor.');
    const rows = await this.db.monthlyReportDelivery.findMany({
      where: {
        AND: [
          actor.artistIds === '*' ? {} : { artistId: { in: [...actor.artistIds] } },
          query.artistId ? { artistId: query.artistId } : {},
          query.settlementMonth ? { settlementMonth: query.settlementMonth } : {},
          query.status
            ? {
                status: query.status.toUpperCase() as NonNullable<
                  Prisma.MonthlyReportDeliveryWhereInput['status']
                >,
              }
            : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.time!) } },
                  { createdAt: new Date(cursor.time!), id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const selected = rows.slice(0, query.limit),
      last = selected.at(-1);
    return DeliveryListResponseSchema.parse({
      items: selected.map(present),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(filter, last.id, last.createdAt.toISOString())
          : null,
    });
  }
  async process(id: string) {
    if (!this.mailer.configured || this.mailer.mode === 'disabled') return;
    const claim = await this.db.monthlyReportDelivery.updateMany({
      where: { id, status: 'QUEUED', mode: this.mailer.mode },
      data: { status: 'SENDING', claimedAt: this.now(), attemptCount: { increment: 1 } },
    });
    if (!claim.count) return;
    let sending = false;
    try {
      const row = await this.db.monthlyReportDelivery.findUniqueOrThrow({ where: { id }, include });
      if (!row.reportId || !row.recipientEmail)
        throw new ReportError(409, 'RECIPIENT_REQUIRED', 'Recipient or report is missing.');
      const approval = await this.db.monthlyReportApproval.findUnique({
        where: { reportId: row.reportId },
      });
      if (approval?.status !== 'APPROVED')
        throw new ReportError(409, 'REPORT_NOT_APPROVED', 'Report approval is no longer valid.');
      const profile = await this.profile(row.artistId, system);
      if (
        profile.recipientEmail !== row.recipientEmail ||
        (row.trigger === 'scheduled' && !profile.automaticEnabled)
      )
        throw new ReportError(
          409,
          'DELIVERY_SETTINGS_CHANGED',
          'Recipient or automatic delivery setting changed. Review settings before retrying.',
        );
      const artifact = await this.reports.download(row.reportId, system);
      const messageId = `<${row.id}@cornven.reports>`;
      await this.db.monthlyReportDelivery.update({
        where: { id },
        data: { messageId, pdfChecksum: artifact.metadata.checksumSha256 },
      });
      sending = true;
      await this.mailer.send({
        to: row.recipientEmail,
        messageId,
        filename: artifact.metadata.fileName,
        pdf: artifact.bytes,
        subject: `Cornven settlement report — ${row.settlementMonth} — version ${row.report!.version}`,
        text: `Hello ${row.artist.name},\n\nAttached is your approved settlement report for ${row.settlementMonth}, version ${row.report!.version}.\nThis attachment is the original saved report; its draft label reflects generation time. This version has since been approved.\n${row.report!.isProvisional ? 'This is a month-to-date report, covering data only through its stated cutoff.\n' : ''}\nCornven`,
      });
      await this.db.monthlyReportDelivery.update({
        where: { id },
        data: { status: 'SENT', sentAt: this.now(), errorCode: null, errorMessage: null },
      });
    } catch (error) {
      const uncertain = sending && !(error instanceof MailSendError && !error.uncertain);
      await this.db.monthlyReportDelivery.update({
        where: { id },
        data: {
          status: uncertain ? 'UNKNOWN' : 'FAILED',
          errorCode: uncertain
            ? 'MAIL_OUTCOME_UNKNOWN'
            : error instanceof ReportError
              ? error.code
              : 'MAIL_SEND_FAILED',
          errorMessage: uncertain
            ? 'SMTP acceptance is uncertain. Check the mailbox; this task will not resend automatically.'
            : error instanceof ReportError || error instanceof MailSendError
              ? error.message
              : 'Could not send the saved PDF. Check the service and retry.',
        },
      });
    }
  }
  async enumerate() {
    if (!this.mailer.configured || this.mailer.mode === 'disabled') return;
    const now = this.now(),
      month = monthAt(now),
      priorMonth = shiftMonth(month, -1);
    const due = new Date(`${month}-01T10:00:00+08:00`);
    if (now < due) return;
    // A durable batch prevents restarts and multiple server instances from re-enumerating.
    await this.db.monthlyDeliveryBatch.createMany({
      data: [{ month, scheduledAt: due }],
      skipDuplicates: true,
    });
    await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "month" FROM "MonthlyDeliveryBatch" WHERE "month" = ${month} FOR UPDATE`;
        const batch = await tx.monthlyDeliveryBatch.findUniqueOrThrow({ where: { month } });
        if (batch.enumerated) return;
        const profiles = await tx.artistDeliveryProfile.findMany({
          where: { automaticEnabled: true, createdAt: { lte: due } },
        });
        for (const profile of profiles) {
          const scheduleKey = `${month}:${profile.artistId}`;
          const report = await tx.artistMonthlyReport.findFirst({
            where: {
              artistId: profile.artistId,
              settlementMonth: priorMonth,
              isProvisional: false,
              generatedAt: { lte: due },
              approval: { is: { status: 'APPROVED', updatedAt: { lte: due } } },
              tasks: { some: { status: 'SUCCEEDED' } },
            },
            orderBy: { version: 'desc' },
          });
          const key =
            report && profile.recipientEmail
              ? dedupe(report.id, profile.recipientEmail, this.mailer.mode)
              : `skip:${scheduleKey}`;
          const existing = await tx.monthlyReportDelivery.findUnique({ where: { dedupeKey: key } });
          if (existing) continue; // Manual and scheduled sends share one delivery for this PDF/recipient/channel.
          await tx.monthlyReportDelivery.create({
            data: {
              artistId: profile.artistId,
              reportId: report?.id ?? null,
              settlementMonth: priorMonth,
              recipientEmail: profile.recipientEmail,
              trigger: 'scheduled',
              mode: this.mailer.mode,
              actorId: system.id,
              dedupeKey: key,
              scheduleKey,
              status: report && profile.recipientEmail ? 'QUEUED' : 'SKIPPED',
              ...(!report || !profile.recipientEmail
                ? {
                    errorCode: 'NO_ELIGIBLE_REPORT',
                    errorMessage:
                      'No approved complete-month report or recipient was available for this scheduled send.',
                  }
                : {}),
            },
          });
        }
        await tx.monthlyDeliveryBatch.update({
          where: { month },
          data: { enumerated: true, completedAt: now },
        });
      },
      { timeout: 20000 },
    );
  }
  async tick() {
    if (this.running || !this.mailer.configured) return;
    this.running = true;
    try {
      await this.enumerate();
      await this.db.monthlyReportDelivery.updateMany({
        where: {
          status: 'SENDING',
          mode: this.mailer.mode,
          claimedAt: { lt: new Date(this.now().getTime() - 300000) },
        },
        data: {
          status: 'UNKNOWN',
          errorCode: 'WORKER_INTERRUPTED',
          errorMessage: 'Worker stopped during sending. Check mailbox before any resend.',
        },
      });
      const pending = await this.db.monthlyReportDelivery.findMany({
        where: { status: 'QUEUED', mode: this.mailer.mode },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const row of pending) await this.process(row.id);
    } finally {
      this.running = false;
    }
  }
  start() {
    const tick = () => {
      void this.tick().catch(() =>
        console.error('Report delivery worker failed; pending tasks remain persisted.'),
      );
    };
    tick();
    const timer = setInterval(tick, 30000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
