// Explicit opt-in; makes paid requests. Prompt overrides exist only in this eval CLI.
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try {
  loadEnvFile('.env');
} catch {
  /* Existing environment variables are also supported. */
}
if (!process.argv.includes('--live'))
  throw new Error('Pass --live to evaluate real gpt-5.4-nano calls.');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}
const promptFile = option('--prompt-file', null);
const promptOverride = promptFile ? await readFile(promptFile, 'utf8') : null;
const outputPath = option('--output', '.local/chatbot/live-intent-evaluation.json');
const { OpenAiAssistantModel } = await import(
  '../apps/api/dist/modules/assistant/assistant-model.js'
);
const cases = JSON.parse(await readFile('fixtures/assistant/intent-evaluation.json', 'utf8'));
const results = [];
let actualPrompt = '';
function matches(output, expected) {
  if (!output) return false;
  return (
    output.intent === expected.intent &&
    Object.entries(expected.slots ?? {}).every(([key, value]) => output.slots?.[key] === value) &&
    (expected.needsClarification === undefined ||
      (output.clarification !== null) === expected.needsClarification)
  );
}
for (const item of cases) {
  const start = Date.now();
  let rawOutput = null;
  const model = new OpenAiAssistantModel(process.env, async (url, init) => {
    const body = JSON.parse(init.body);
    if (promptOverride !== null) body.instructions = promptOverride;
    actualPrompt = body.instructions;
    const response = await fetch(url, { ...init, body: JSON.stringify(body) });
    if (response.ok) {
      try {
        const payload = await response.clone().json();
        const text = (payload.output ?? [])
          .filter((part) => part.type === 'message')
          .flatMap((part) => part.content ?? [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('');
        rawOutput = JSON.parse(text);
      } catch {
        /* The adapter reports invalid model output below. */
      }
    }
    return response;
  });
  if (!model.configured) throw new Error('Configure OPENAI_API_KEY in the server .env first.');
  try {
    const output = await model.classify(
      { message: item.message, ...(item.history ? { history: item.history } : {}) },
      item.today,
    );
    results.push({
      message: item.message,
      passed: matches(output, item.expected),
      rawPassed: matches(rawOutput, item.expected),
      expected: item.expected,
      output,
      rawOutput,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    results.push({
      message: item.message,
      passed: false,
      rawPassed: false,
      error: error.code ?? 'FAILED',
      durationMs: Date.now() - start,
    });
  }
  console.log(
    `${results.length}/${cases.length}: ${results.at(-1).passed ? 'PASS' : 'FAIL'} ${item.message}`,
  );
}
const durations = results.map((item) => item.durationMs).sort((a, b) => a - b);
const summary = {
  model: 'gpt-5.4-nano',
  reasoningEffort: 'low',
  ranAt: new Date().toISOString(),
  promptSha256: createHash('sha256').update(actualPrompt).digest('hex'),
  promptCharacters: actualPrompt.length,
  suiteSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  passed: results.filter((item) => item.passed).length,
  rawPassed: results.filter((item) => item.rawPassed).length,
  total: results.length,
  medianDurationMs: durations[Math.floor(durations.length / 2)],
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n');
console.log(
  `Validated ${summary.passed}/${summary.total}; raw model ${summary.rawPassed}/${summary.total}.`,
);
if (results.some((item) => !item.passed)) process.exitCode = 1;
