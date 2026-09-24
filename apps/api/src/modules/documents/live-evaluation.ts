export interface LiveOptions {
  mode: 'fixed-evidence' | 'end-to-end';
  maxCalls: number;
  suite: string;
}
export function liveOptions(args: string[]): LiveOptions {
  const value = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes('--allow-external'))
    throw new Error('External evaluation disabled: explicitly pass --allow-external.');
  const mode = value('--mode');
  if (mode !== 'fixed-evidence' && mode !== 'end-to-end')
    throw new Error('Choose fixed-evidence or end-to-end.');
  const maxCalls = Number(value('--max-model-calls'));
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 40)
    throw new Error('Explicit model call budget must be 1..40 per mode.');
  const suite = args.includes('--suite') ? value('--suite') : 'fixtures/rag/answer-quality.json';
  if (!suite) throw new Error('Missing suite');
  return { mode, maxCalls, suite };
}
export class ModelCallBudget {
  calls = 0;
  constructor(
    readonly limit: number,
    private readonly transport: typeof fetch = fetch,
  ) {}
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.calls >= this.limit) throw new Error('MODEL_CALL_BUDGET_EXHAUSTED');
    this.calls++;
    // Count attempted calls, including failures. Never retry and never log bodies or credentials.
    return this.transport(input, init);
  };
}
