import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55449' || url.pathname !== '/cornven_planb')
  throw new Error('Only the isolated Plan B demo database is allowed.');
const { createReportRuntime } = await import(
  '../apps/api/dist/modules/reporting/report-runtime.js'
);
const runtime = createReportRuntime();
const actor = { id: 'planb-demo-setup', artistIds: '*' };
try {
  const { monthAt } = await import('../apps/api/dist/shared/report-time.js');
  const month = monthAt(new Date());
  const artists = await runtime.data.listArtists({ limit: 100 }, actor);
  const reports = [];
  for (const artist of artists.items) {
    const result = await runtime.service.generate(
      { artistId: artist.artistId, period: 'current_month', format: 'pdf' },
      `planb-initial-${month}-${artist.artistId}`,
      actor,
    );
    const artifact = await runtime.service.download(result.body.reportId, actor);
    assert.ok(artifact.bytes.length > 5000);
    reports.push({ ...result.body, pdfBytes: artifact.bytes.length });
  }
  // The same scheduler used at startup creates any due previous-month reports.
  await runtime.scheduler.tick();
  await mkdir('.local/evidence', { recursive: true });
  await writeFile(
    '.local/evidence/ready-demo.json',
    JSON.stringify({ month, reports }, null, 2) + '\n',
  );
  console.log(
    `Plan B ready: ${reports.length} saved current-month reports with verified PDF downloads.`,
  );
} finally {
  await runtime.repository.db.$disconnect();
}
