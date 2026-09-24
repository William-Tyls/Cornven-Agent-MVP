import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@cornven/database';
import { createApp } from '../src/app.js';
import { createReportRuntime } from '../src/modules/reporting/report-runtime.js';
import { monthBounds } from '../src/shared/report-time.js';
import {
  MailSendError,
  type ReportMail,
  type ReportMailer,
} from '../src/modules/delivery/mail-transport.js';
const db = new PrismaClient();
const actor = { id: 'delivery-test-staff', artistIds: '*' as const };
const enabled = process.env.RUN_REPORT_INTEGRATION === 'true';
describe.skipIf(!enabled)('approved PDF delivery with PostgreSQL and injectable clock/SMTP', () => {
  let storagePath: string;
  let now = new Date('2090-02-01T01:00:00Z');
  const owned: string[] = [],
    months: string[] = [];
  const mails: ReportMail[] = [];
  let failure: MailSendError | null = null;
  const mailer: ReportMailer = {
    mode: 'local',
    configured: true,
    from: 'reports@cornven.test',
    async send(mail) {
      if (failure) throw failure;
      mails.push(mail);
    },
  };
  let runtime: ReturnType<typeof createReportRuntime>;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('/cornven_planb_test?'))
      throw new Error('Use isolated test DB.');
    storagePath = await mkdtemp(join(tmpdir(), 'cornven-delivery-'));
    runtime = createReportRuntime({
      db,
      storagePath,
      now: () => now,
      mailer,
      renderer: {
        render: async () => new TextEncoder().encode('%PDF-1.7\napproved snapshot bytes'),
      },
      resolveActor: () => actor,
    });
  });
  afterAll(async () => {
    const ids = (
      await db.artistMonthlyReport.findMany({
        where: { artistId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await db.monthlyReportDelivery.deleteMany({ where: { artistId: { in: owned } } });
    await db.artistDeliveryProfile.deleteMany({ where: { artistId: { in: owned } } });
    await db.monthlyDeliveryBatch.deleteMany({ where: { month: { in: months } } });
    await db.monthlyReportApprovalEvent.deleteMany({ where: { reportId: { in: ids } } });
    await db.monthlyReportApproval.deleteMany({ where: { reportId: { in: ids } } });
    await db.reportArtifact.deleteMany({ where: { reportId: { in: ids } } });
    await db.settlementInputSnapshot.deleteMany({ where: { reportId: { in: ids } } });
    await db.reportGenerationTask.deleteMany({ where: { artistId: { in: owned } } });
    await db.artistMonthlyReport.deleteMany({ where: { artistId: { in: owned } } });
    await db.artist.deleteMany({ where: { id: { in: owned } } });
    await db.$disconnect();
    if (storagePath) await rm(storagePath, { recursive: true, force: true });
  });
  async function artist(automaticEnabled = false) {
    const id = (await db.artist.create({ data: { name: 'Delivery test ' + randomUUID() } })).id;
    owned.push(id);
    await runtime.delivery.saveProfile(
      id,
      { recipientEmail: id + '@cornven.test', automaticEnabled },
      actor,
    );
    return id;
  }
  async function report(artistId: string, month = '2090-01', approved = true, provisional = false) {
    const key = randomUUID();
    const { task } = await runtime.repository.getOrCreate(
      {
        artistId,
        settlementMonth: month,
        asOf: provisional ? `${month}-15T00:00:00Z` : monthBounds(month).end.toISOString(),
        trigger: 'manual',
      },
      actor.id,
      key,
      key,
      now,
    );
    const row = await runtime.service.runTask(task.id);
    if (approved) {
      await runtime.approvals.act(row.id, { action: 'submit', requestId: randomUUID() }, actor);
      await runtime.approvals.act(row.id, { action: 'approve', requestId: randomUUID() }, actor);
    }
    return row.id;
  }
  it('rejects unapproved versions and caller-supplied recipient/identity', async () => {
    const id = await report(await artist(), '2090-01', false);
    const app = createApp(runtime);
    expect((await request(app).post('/api/v1/deliveries').send({ reportId: id })).status).toBe(409);
    await runtime.approvals.act(id, { action: 'submit', requestId: randomUUID() }, actor);
    expect((await request(app).post('/api/v1/deliveries').send({ reportId: id })).status).toBe(409);
    await runtime.approvals.act(
      id,
      { action: 'reject', requestId: randomUUID(), reason: 'Wrong data' },
      actor,
    );
    expect((await request(app).post('/api/v1/deliveries').send({ reportId: id })).status).toBe(409);
    expect(
      (
        await request(app)
          .post('/api/v1/deliveries')
          .send({ reportId: id, recipientEmail: 'attacker@example.com' })
      ).status,
    ).toBe(400);
    expect(await db.monthlyReportDelivery.count({ where: { reportId: id } })).toBe(0);
  });
  it('sends exact saved PDF bytes once across concurrent manual requests', async () => {
    const id = await report(await artist());
    const before = await runtime.repository.getReport(id, actor);
    const count = mails.length;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runtime.delivery.send({ reportId: id }, actor)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(mails.length).toBe(count + 1);
    const row = (await runtime.delivery.list({ artistId: before.artistId }, actor)).items[0]!;
    expect(row.status).toBe('sent');
    expect(row.attemptCount).toBe(1);
    expect(row.pdfChecksum).toBe(createHash('sha256').update(mails.at(-1)!.pdf).digest('hex'));
    expect(mails.at(-1)!.to).toBe(before.artistId + '@cornven.test');
    expect(await runtime.repository.getReport(id, actor)).toEqual(before);
    expect((await runtime.delivery.send({ reportId: id }, actor)).id).toBe(row.id);
    expect(mails.length).toBe(count + 1);
  });
  it('permits retry of definitive failures and prevents retry of uncertain SMTP outcomes', async () => {
    const id = await report(await artist());
    failure = new MailSendError(false);
    const failed = await runtime.delivery.send({ reportId: id }, actor);
    expect(failed.status).toBe('failed');
    failure = null;
    expect((await runtime.delivery.retry(failed.id, actor)).status).toBe('sent');
    const second = await report(await artist());
    failure = new MailSendError(true);
    const unknown = await runtime.delivery.send({ reportId: second }, actor);
    failure = null;
    expect(unknown.status).toBe('unknown');
    await expect(runtime.delivery.retry(unknown.id, actor)).rejects.toMatchObject({ status: 409 });
    const count = mails.length;
    await runtime.delivery.process(unknown.id);
    expect(mails.length).toBe(count);
  });
  it('fails without sending when recipient, saved PDF or actor access is unavailable', async () => {
    const a = await artist();
    const id = await report(a);
    const count = mails.length;
    await expect(
      runtime.delivery.send({ reportId: id }, { id: 'other', artistIds: [] }),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.delivery.saveProfile(a, { recipientEmail: null, automaticEnabled: false }, actor);
    await expect(runtime.delivery.send({ reportId: id }, actor)).rejects.toMatchObject({
      code: 'RECIPIENT_REQUIRED',
    });
    await runtime.delivery.saveProfile(
      a,
      { recipientEmail: a + '@cornven.test', automaticEnabled: false },
      actor,
    );
    const unavailable = createReportRuntime({
      db,
      now: () => now,
      mailer,
      storagePath: storagePath + '/missing',
    });
    const result = await unavailable.delivery.send({ reportId: id }, actor);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('REPORT_FILE_UNAVAILABLE');
    expect(mails.length).toBe(count);
  });
  it('at Taipei 10:00 sends latest approved complete prior-month version and skips late/unapproved/provisional reports', async () => {
    months.push('2090-02');
    now = new Date('2090-02-01T01:30:00Z');
    const a = await artist(true),
      onlyProvisional = await artist(true),
      unapproved = await artist(true),
      late = await artist(true);
    await report(a);
    const latest = await report(a);
    await report(a, '2090-01', false);
    await report(a, '2090-01', true, true);
    await report(onlyProvisional, '2090-01', true, true);
    await report(unapproved, '2090-01', false);
    const lateId = await report(late);
    await db.monthlyReportApproval.update({
      where: { reportId: lateId },
      data: { updatedAt: new Date('2090-02-01T02:00:01Z') },
    });
    now = new Date('2090-02-01T01:59:59.999Z');
    await runtime.delivery.enumerate();
    expect(await db.monthlyDeliveryBatch.findUnique({ where: { month: '2090-02' } })).toBeNull();
    now = new Date('2090-02-01T02:00:00Z');
    const count = mails.length;
    await Promise.all([runtime.delivery.enumerate(), runtime.delivery.enumerate()]);
    await runtime.delivery.tick();
    const selected = (await runtime.delivery.list({ artistId: a }, actor)).items;
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ reportId: latest, status: 'sent', trigger: 'scheduled' });
    for (const id of [onlyProvisional, unapproved, late])
      expect((await runtime.delivery.list({ artistId: id }, actor)).items[0]!.status).toBe(
        'skipped',
      );
    expect(mails.length).toBe(count + 1);
    await runtime.delivery.tick();
    expect(mails.length).toBe(count + 1);
  });
  it('deduplicates scheduled versus manual delivery and recovers a current-month missed run on restart', async () => {
    months.push('2090-03');
    now = new Date('2090-03-01T01:00:00Z');
    const a = await artist(true);
    const id = await report(a, '2090-02');
    await runtime.delivery.send({ reportId: id }, actor);
    const count = mails.length;
    now = new Date('2090-03-04T04:00:00Z');
    const restarted = createReportRuntime({ db, storagePath, now: () => now, mailer });
    await restarted.delivery.tick();
    expect((await runtime.delivery.list({ artistId: a }, actor)).items).toHaveLength(1);
    expect(mails.length).toBe(count);
  });
  it('marks interrupted SMTP work as unknown instead of replaying it', async () => {
    const a = await artist();
    const id = await report(a, '2090-02');
    const sent = await runtime.delivery.send({ reportId: id }, actor);
    const count = mails.length;
    await db.monthlyReportDelivery.update({
      where: { id: sent.id },
      data: { status: 'SENDING', claimedAt: new Date(now.getTime() - 360000) },
    });
    await runtime.delivery.tick();
    expect((await runtime.delivery.list({ artistId: a }, actor)).items[0]!.status).toBe('unknown');
    expect(mails.length).toBe(count);
  });
});
