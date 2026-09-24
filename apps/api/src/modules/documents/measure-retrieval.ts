import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { DocumentsService } from './documents.service.js';
import { loadQualitySuite } from './evaluate-quality.js';
const suite = await loadQualitySuite();
const service = new DocumentsService({ environment: {} });
const start = performance.now();
const index = await service.getIndex();
const coldMs = performance.now() - start;
for (const c of suite.positive)
  await service.search({ query: c.query, limit: 5 }, { permissionTags: c.permissionTags });
const values = [];
for (let i = 0; i < 100; i++) {
  const c = suite.positive[i % suite.positive.length]!;
  const started = performance.now();
  await service.search({ query: c.query, limit: 5 }, { permissionTags: c.permissionTags });
  values.push(performance.now() - started);
}
values.sort((a, b) => a - b);
const report = {
  chunks: index.chunks.length,
  queries: 100,
  coldMs,
  p50: values[49],
  p95: values[94],
  maximum: values[99],
  node: process.version,
  icu: process.versions.icu,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  modelCalls: 0,
};
await mkdir('../../.local/evidence', { recursive: true });
await writeFile(
  '../../.local/evidence/rag-performance.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(report);
if (report.p95! > 300) process.exitCode = 1;
