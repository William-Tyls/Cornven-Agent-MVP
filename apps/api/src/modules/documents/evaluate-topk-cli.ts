import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateTopK, topKDirectory, topKMarkdown } from './evaluate-topk.js';

const args = process.argv.slice(2).filter((x) => x !== '--');
if (args.length)
  throw new Error(
    'Offline evaluator takes no arguments; use rag:evaluate:topk:live for explicitly authorized generation.',
  );
await mkdir(topKDirectory, { recursive: true });
const report = await evaluateTopK();
await writeFile(resolve(topKDirectory, 'offline.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
await writeFile(resolve(topKDirectory, 'offline.md'), topKMarkdown(report), { mode: 0o600 });
console.log(
  JSON.stringify({
    offlineCandidate: report.offlineCandidate,
    baselinePassed: report.baselinePassed,
    output: topKDirectory,
    humanReview: 'pending',
  }),
);
if (!report.baselinePassed || !report.offlineCandidate) process.exitCode = 1;
