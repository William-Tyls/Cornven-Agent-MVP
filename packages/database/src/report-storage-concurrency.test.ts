import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { database } from './index.js';

describe.skipIf(process.env.RUN_REPORT_INTEGRATION !== 'true')(
  'monthly report storage: unique constraints under concurrency (M1-02)',
  () => {
    beforeAll(() => {
      if (!process.env.DATABASE_URL?.includes('/cornven_planb_test?'))
        throw new Error('Use the isolated cornven_planb_test database.');
    });
    it('rejects a duplicate idempotencyKey when two requests race to create the same task', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist)
        throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');

      const idempotencyKey = `test-idem-${randomUUID()}`;

      const createTask = () =>
        database.reportGenerationTask.create({
          data: {
            artistId: artist.id,
            settlementMonth: '2026-09',
            asOf: new Date(),
            trigger: 'manual',
            idempotencyKey,
          },
        });

      // Fire two "concurrent" requests with the same idempotency key.
      const results = await Promise.allSettled([createTask(), createTask()]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      // Exactly one should win; the database's unique constraint on
      // idempotencyKey must reject the racing duplicate, not silently create
      // two tasks for the same request.
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });

    it('rejects a duplicate scheduled task for the same artist+month racing concurrently, via ScheduledReportLock', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist)
        throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');

      const settlementMonth = '2099-01'; // far-future month, guaranteed unused by other tests

      // Clean up any lock/task a previous run left behind.
      await database.scheduledReportLock.deleteMany({
        where: { artistId: artist.id, settlementMonth },
      });
      await database.reportGenerationTask.deleteMany({
        where: { artistId: artist.id, settlementMonth, trigger: 'scheduled' },
      });

      const createScheduledTaskWithLock = async () => {
        const task = await database.reportGenerationTask.create({
          data: {
            artistId: artist.id,
            settlementMonth,
            asOf: new Date(),
            trigger: 'scheduled',
          },
        });
        // The lock insert is what actually enforces "one scheduled task per
        // artist+month" -- it's expected to fail for the losing request.
        await database.scheduledReportLock.create({
          data: { artistId: artist.id, settlementMonth, taskId: task.id },
        });
        return task;
      };

      const results = await Promise.allSettled([
        createScheduledTaskWithLock(),
        createScheduledTaskWithLock(),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });

    it('allows two manual requests for the same artist+month with different idempotencyKeys', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist)
        throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');

      const settlementMonth = '2099-03'; // distinct far-future month from the other tests

      const first = await database.reportGenerationTask.create({
        data: {
          artistId: artist.id,
          settlementMonth,
          asOf: new Date(),
          trigger: 'manual',
          idempotencyKey: `manual-a-${randomUUID()}`,
        },
      });
      const second = await database.reportGenerationTask.create({
        data: {
          artistId: artist.id,
          settlementMonth,
          asOf: new Date(),
          trigger: 'manual',
          idempotencyKey: `manual-b-${randomUUID()}`,
        },
      });

      expect(first.id).not.toBe(second.id);
    });

    it('rejects a duplicate report version when two requests race for the same artist+month+version', async () => {
      const artist = await database.artist.findFirst({ where: { externalRef: 'ART-001' } });
      if (!artist)
        throw new Error('Expected seeded artist ART-001 to exist. Run pnpm db:seed first.');

      const settlementMonth = '2099-02'; // distinct far-future month from the test above

      // Clean up any row a previous test run left behind, so this test's
      // "exactly one succeeds" assertion isn't confused by pre-existing data.
      await database.artistMonthlyReport.deleteMany({
        where: { artistId: artist.id, settlementMonth },
      });

      const createReport = () =>
        database.artistMonthlyReport.create({
          data: {
            artistId: artist.id,
            settlementMonth,
            asOf: new Date(),
            trigger: 'manual',
            version: 1,
            isProvisional: false,
            schemaVersion: 'v1',
            reportJson: {},
          },
        });

      const results = await Promise.allSettled([createReport(), createReport()]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      // Two "concurrent" report-generation attempts for the same
      // artist+month+version must not both succeed -- exactly one version 1
      // record can exist.
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });
  },
);
