import { loadEnvFile } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
loadEnvFile('.env');
if (process.env.DELIVERY_MODE === 'local') {
  const mailbox = spawnSync(
    'docker',
    ['compose', '-f', 'compose.local.yaml', 'up', '-d', 'mailpit'],
    {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (mailbox.status !== 0) process.exit(mailbox.status ?? 1);
}

process.env.REPORT_STORAGE_PATH = resolve(
  root,
  process.env.REPORT_STORAGE_PATH ?? '.local/reports',
);
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${process.env.API_PORT ?? 3119}`;
const build = spawnSync('pnpm', ['build'], { cwd: root, env: process.env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const processes = [
  spawn('pnpm', ['--filter', '@cornven/api', 'exec', 'tsx', 'src/server.ts'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(
    'pnpm',
    [
      '--filter',
      '@cornven/web',
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      process.env.WEB_PORT ?? '5190',
      '--strictPort',
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  ),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
}
for (const child of processes)
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
