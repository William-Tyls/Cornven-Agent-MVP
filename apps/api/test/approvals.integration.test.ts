import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@cornven/database';
import { createApp } from '../src/app.js';
import { createReportRuntime } from '../src/modules/reporting/report-runtime.js';
const enabled = process.env.RUN_REPORT_INTEGRATION === 'true';
const db = new PrismaClient();
describe.skipIf(!enabled)('version-specific report approval with PostgreSQL', () => {
  let artistId: string, root: string;
  let runtime: ReturnType<typeof createReportRuntime>;
  const actor = { id: 'approval-integration-reviewer', artistIds: '*' as const };
  const command = (action: string, reason = '') => ({ action, reason, requestId: randomUUID() });
  const app = () => createApp(runtime);
  const act = (id: string, body: object) =>
    request(app()).post(`/api/v1/approvals/${id}/actions`).send(body);
  async function generate() {
    return (
      await runtime.service.generate(
        { artistId, period: 'current_month', format: 'pdf' },
        randomUUID(),
        actor,
      )
    ).body.reportId;
  }
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('/cornven_planb_test?'))
      throw new Error('Use isolated test database.');
    root = await mkdtemp(join(tmpdir(), 'cornven-approval-'));
    artistId = (
      await db.artist.create({ data: { name: 'Approval test', externalRef: randomUUID() } })
    ).id;
    runtime = createReportRuntime({
      db,
      now: () => new Date('2026-09-20T04:00:00Z'),
      storagePath: root,
      renderer: { render: async () => new TextEncoder().encode('%PDF-1.7\nTest renderer') },
      resolveActor: () => actor,
    });
  });
  afterAll(async () => {
    if (artistId) {
      const reports = await db.artistMonthlyReport.findMany({
        where: { artistId },
        select: { id: true },
      });
      const ids = reports.map((r) => r.id);
      await db.monthlyReportApprovalEvent.deleteMany({ where: { reportId: { in: ids } } });
      await db.monthlyReportApproval.deleteMany({ where: { reportId: { in: ids } } });
      await db.reportArtifact.deleteMany({ where: { reportId: { in: ids } } });
      await db.settlementInputSnapshot.deleteMany({ where: { reportId: { in: ids } } });
      await db.reportGenerationTask.deleteMany({ where: { artistId } });
      await db.artistMonthlyReport.deleteMany({ where: { artistId } });
      await db.artist.delete({ where: { id: artistId } });
    }
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('submits and approves an immutable version, persists history and leaves later versions draft', async () => {
    const id = await generate();
    const before = await db.artistMonthlyReport.findUniqueOrThrow({
      where: { id },
      include: { artifacts: true, inputSnapshot: true },
    });
    expect((await act(id, command('submit'))).body.summary.approvalStatus).toBe('pending');
    const approved = await act(id, command('approve', 'Amounts checked'));
    expect(approved.status).toBe(200);
    expect(approved.body.summary.approvalStatus).toBe('approved');
    expect(approved.body.events.map((e: { action: string }) => e.action)).toEqual([
      'submit',
      'approve',
    ]);
    expect(approved.body.events[1]).toMatchObject({ actorId: actor.id, reason: 'Amounts checked' });
    const after = await db.artistMonthlyReport.findUniqueOrThrow({
      where: { id },
      include: { artifacts: true, inputSnapshot: true },
    });
    expect(after).toEqual(before);
    const next = await generate();
    const detail = await runtime.approvals.detail(next, actor);
    expect(detail.summary.version).toBe(before.version + 1);
    expect(detail.summary.approvalStatus).toBe('draft');
    expect(detail.events).toEqual([]);
    expect((await request(app()).get(`/api/v1/approvals/${id}`)).body.summary.approvalStatus).toBe(
      'approved',
    );
  });
  it('requires a rejection reason, forbids reopening old versions, and permits a new version submission', async () => {
    const id = await generate();
    expect((await act(id, command('approve'))).status).toBe(409);
    await act(id, command('submit'));
    expect((await act(id, command('reject', '  '))).status).toBe(400);
    expect(
      (await act(id, command('reject', 'Correct the source data'))).body.summary.approvalStatus,
    ).toBe('rejected');
    expect((await act(id, command('submit'))).status).toBe(409);
    expect((await act(id, command('approve'))).status).toBe(409);
    const next = await generate();
    expect((await act(next, command('submit'))).body.summary.approvalStatus).toBe('pending');
  });
  it('deduplicates concurrent retries and rejects reuse with changed content', async () => {
    const id = await generate();
    const submit = command('submit');
    const responses = await Promise.all([act(id, submit), act(id, submit), act(id, submit)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await db.monthlyReportApprovalEvent.count({ where: { reportId: id } })).toBe(1);
    expect((await act(id, { ...submit, action: 'approve' })).status).toBe(409);
    const approve = command('approve', 'Checked');
    await act(id, approve);
    expect((await act(id, approve)).status).toBe(200);
    expect((await act(id, { ...approve, reason: 'Different' })).status).toBe(409);
    expect(await db.monthlyReportApprovalEvent.count({ where: { reportId: id } })).toBe(2);
  });
  it('allows exactly one winner when approval and rejection race', async () => {
    const id = await generate();
    await act(id, command('submit'));
    const results = await Promise.all([
      act(id, command('approve')),
      act(id, command('reject', 'Mismatch')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const detail = await runtime.approvals.detail(id, actor);
    expect(detail.events).toHaveLength(2);
    expect(detail.summary.approvalStatus).toBe(
      detail.events[1]!.action === 'approve' ? 'approved' : 'rejected',
    );
  });
  it('filters and paginates the queue without duplicating versions, and binds cursors to filters', async () => {
    const first = await runtime.approvals.list(
      { artistQuery: 'Approval test', settlementMonth: '2026-09', limit: 1 },
      actor,
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await runtime.approvals.list(
      {
        artistQuery: 'Approval test',
        settlementMonth: '2026-09',
        limit: 1,
        cursor: first.nextCursor,
      },
      actor,
    );
    expect(second.items[0]!.reportId).not.toBe(first.items[0]!.reportId);
    await expect(
      runtime.approvals.list({ status: 'pending', cursor: first.nextCursor }, actor),
    ).rejects.toMatchObject({ status: 400 });
    const approved = await runtime.approvals.list(
      { status: 'approved', artistQuery: 'Approval test' },
      actor,
    );
    expect(approved.items.length).toBeGreaterThan(0);
    expect(approved.items.every((r) => r.approvalStatus === 'approved')).toBe(true);
    expect((await runtime.approvals.list({ settlementMonth: '2000-01' }, actor)).items).toEqual([]);
  });
  it('does not accept client identity and enforces existing artist access and ready-report rules', async () => {
    const id = await generate();
    expect((await act(id, { ...command('submit'), actorId: 'admin' })).status).toBe(400);
    await expect(
      runtime.approvals.act(id, command('submit'), { id: 'other', artistIds: [] }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await runtime.approvals.list({}, { id: 'other', artistIds: [] })).items).toEqual([]);
    expect((await act(randomUUID(), command('submit'))).status).toBe(404);
    const anonymous = createApp({ ...runtime, resolveActor: () => null });
    expect(
      (await request(anonymous).post(`/api/v1/approvals/${id}/actions`).send(command('submit')))
        .status,
    ).toBe(401);
    await db.reportGenerationTask.updateMany({
      where: { reportId: id },
      data: { status: 'FAILED' },
    });
    expect((await act(id, command('submit'))).status).toBe(404);
    expect(await db.monthlyReportApproval.count({ where: { reportId: id } })).toBe(0);
  });
});
