import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
loadEnvFile('.env');
const importTest = process.argv.includes('--import-test');
const test = process.argv.includes('--test') || importTest;
const dbName = importTest
  ? 'cornven_planb_import_test'
  : test
    ? 'cornven_planb_test'
    : 'cornven_planb';
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
// This script deliberately cannot migrate a caller-supplied shared/production database.
process.env.DATABASE_URL = `postgresql://cornven_planb:mock_only_local@127.0.0.1:55449/${dbName}?schema=public`;
run('docker', ['compose', '-f', 'compose.local.yaml', 'up', '-d', '--wait']);
if (test) {
  run(
    'docker',
    [
      'compose',
      '-f',
      'compose.local.yaml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'cornven_planb',
      '-d',
      'postgres',
    ],
    {
      input: `SELECT 'CREATE DATABASE ${dbName}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${dbName}')\\gexec\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
}
run('docker', [
  'compose',
  '-f',
  'compose.local.yaml',
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'cornven_planb',
  '-d',
  dbName,
  '-c',
  'CREATE EXTENSION IF NOT EXISTS vector;',
]);
run('pnpm', ['db:generate']);
run('pnpm', ['db:migrate:deploy']);
run('pnpm', ['db:seed']);
if (test) {
  process.env.RUN_REPORT_INTEGRATION = 'true';
  run('pnpm', ['build']);
  if (importTest) {
    run('pnpm', [
      '--filter',
      '@cornven/api',
      'exec',
      'vitest',
      'run',
      'test/import-persistence.service.test.ts',
      'test/csv-batch.integration.test.ts',
    ]);
    process.exit(0);
  }
  run('pnpm', ['--filter', '@cornven/database', 'test']);
  run('pnpm', [
    '--filter',
    '@cornven/api',
    'exec',
    'vitest',
    'run',
    'test/report-integration.test.ts',
    'test/sales.service.test.ts',
  ]);
  run('pnpm', [
    '--filter',
    '@cornven/api',
    'exec',
    'vitest',
    'run',
    'test/approvals.integration.test.ts',
  ]);
  run('pnpm', [
    '--filter',
    '@cornven/api',
    'exec',
    'vitest',
    'run',
    'test/delivery.integration.test.ts',
  ]);
  // Run separately: report integration tests clean shared report tables.
  run('pnpm', [
    '--filter',
    '@cornven/api',
    'exec',
    'vitest',
    'run',
    'test/monthly-preview.integration.test.ts',
  ]);
}
