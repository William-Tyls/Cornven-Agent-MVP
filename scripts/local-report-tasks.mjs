import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55449' || url.pathname !== '/cornven_planb')
  throw new Error('Local database required.');
const { database } = await import('../packages/database/dist/index.js');
try {
  const taskId = process.argv[2];
  if (taskId) {
    const updated = await database.reportGenerationTask.updateMany({
      where: { id: taskId, status: 'FAILED' },
      data: {
        status: 'QUEUED',
        attemptCount: 0,
        nextRetryAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    console.log(
      `Requeued ${updated.count} failed task(s), preserving the original cutoff and snapshot.`,
    );
  } else {
    console.table(
      await database.reportGenerationTask.findMany({
        select: {
          id: true,
          artistId: true,
          settlementMonth: true,
          status: true,
          attemptCount: true,
          nextRetryAt: true,
          errorCode: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }
} finally {
  await database.$disconnect();
}
