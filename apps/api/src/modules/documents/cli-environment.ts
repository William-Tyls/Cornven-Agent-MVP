import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const path = fileURLToPath(new URL('../../../../../.env', import.meta.url));
if (existsSync(path)) loadEnvFile(path);
