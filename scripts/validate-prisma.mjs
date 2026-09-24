import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(command, ['--filter', '@cornven/database', 'prisma:validate'], {
  env: {
    ...process.env,
    // Prisma only validates the schema here, but still requires a syntactically valid URL.
    // Preserve a developer-provided URL; otherwise use a non-secret local placeholder.
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://cornven:cornven_local@localhost:5432/cornven?schema=public',
  },
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
