import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { DocumentsService } from './documents.service.js';
import { DocumentsService as LegacyService } from './legacy/documents.service.js';
import { loadQualitySuite, evaluateQuality, qualityPass } from './evaluate-quality.js';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const value = (flag: string) =>
  args.find((a) => a.startsWith(flag + '='))?.slice(flag.length + 1) ??
  (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const tuning = args.includes('--calibration-v2') ? 'v2' : args.includes('--tuning');
const profile = value('--profile') === 'legacy' ? 'legacy' : 'enhanced';
const suite = await loadQualitySuite(tuning);
const legacy = await evaluateQuality(new LegacyService({ environment: {} }), suite);
const baseline = value('--baseline');
if (baseline) {
  const saved = JSON.parse(await readFile(resolve(root, baseline), 'utf8')) as {
    profile: string;
    summary: { mrr: number };
  };
  if (saved.profile !== 'legacy' || saved.summary.mrr !== legacy.summary.mrr)
    throw new Error('Baseline does not match the current frozen evaluation suite');
}
const report =
  profile === 'legacy'
    ? legacy
    : await evaluateQuality(new DocumentsService({ environment: {} }), suite);
const output = resolve(
  root,
  value('--output') ?? `.local/evidence/rag-${profile}${tuning ? '-tuning' : ''}.json`,
);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceState = createHash('sha256');
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
].sort();
for (const file of files) {
  sourceState.update(file).update('\0');
  try {
    sourceState.update(await readFile(resolve(root, file)));
  } catch {
    sourceState.update('<missing>');
  }
}
const metadata = {
  sourceFilesHash: sourceState.digest('hex'),
  timestamp: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeHash: hash(execFileSync('git', ['diff', '--binary'], { cwd: root })),
  sources: hash(await readFile(resolve(root, 'data/rag/sources.json'))),
  synonyms: hash(await readFile(resolve(root, 'data/rag/retrieval-synonyms.json'))),
  fixtures: JSON.parse(
    await readFile(resolve(root, 'fixtures/rag/evaluation-manifest.json'), 'utf8'),
  ),
  prompt: hash(await readFile(resolve(root, 'apps/api/src/modules/assistant/knowledge-prompt.ts'))),
  provider: 'deterministic-hash:1024',
  node: process.version,
  icu: process.versions.icu,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify({ metadata, profile, tuning, legacySummary: legacy.summary, ...report }, null, 2) +
    '\n',
);
console.log(
  JSON.stringify(
    {
      profile,
      tuning,
      summary: report.summary,
      legacySummary: legacy.summary,
      failures: report.failures,
      output,
    },
    null,
    2,
  ),
);
if (!tuning && profile === 'enhanced' && !qualityPass(report, legacy.summary.mrr))
  process.exitCode = 1;
