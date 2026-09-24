// Explicit offline-build/evaluation helper. Never used implicitly by the request path.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiEmbeddingProvider, type EmbeddingProvider } from './embeddings.js';
const directory = fileURLToPath(new URL('../../../../../.local/rag-semantic-v1/', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface Ledger {
  version: 1;
  provider: string;
  requests: number;
  inputHashes: string[];
  inputByteUpperBound: number;
  actualInputTokens: number;
  failedRequests: number;
}
export class CachedSemanticProvider implements EmbeddingProvider {
  readonly id = 'openai:text-embedding-3-large:1024';
  readonly dimensions = 1024;
  readonly mode = 'semantic' as const;
  private constructor(
    private readonly allowExternal: boolean,
    private readonly ledger: Ledger,
    private readonly cache: Record<string, number[]>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}
  static async create(allowExternal = false, environment: NodeJS.ProcessEnv = {}) {
    await mkdir(directory, { recursive: true });
    let ledger: Ledger = {
      version: 1,
      provider: 'openai:text-embedding-3-large:1024',
      requests: 0,
      inputHashes: [],
      inputByteUpperBound: 0,
      actualInputTokens: 0,
      failedRequests: 0,
    };
    let cache: Record<string, number[]> = {};
    try {
      ledger = JSON.parse(await readFile(resolve(directory, 'ledger.json'), 'utf8')) as Ledger;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      cache = JSON.parse(await readFile(resolve(directory, 'vectors.json'), 'utf8')) as Record<
        string,
        number[]
      >;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (ledger.version !== 1 || ledger.provider !== 'openai:text-embedding-3-large:1024')
      throw new Error('Invalid semantic cache identity');
    for (const v of Object.values(cache))
      if (
        v.length !== 1024 ||
        v.some((x) => !Number.isFinite(x)) ||
        Math.abs(v.reduce((s, x) => s + x * x, 0) - 1) > 0.001
      )
        throw new Error('Invalid cached vector');
    return new CachedSemanticProvider(allowExternal, ledger, cache, environment);
  }
  private key(text: string) {
    return hash(this.id + '\n' + text);
  }
  async save() {
    for (const [name, value] of [
      ['ledger', this.ledger],
      ['vectors', this.cache],
    ] as const) {
      const file = resolve(directory, name + '.json');
      const temp = file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, file);
    }
  }
  summary() {
    return {
      ...this.ledger,
      inputHashes: undefined,
      uniqueInputs: this.ledger.inputHashes.length,
      cachedInputs: Object.keys(this.cache).length,
    };
  }
  async embed(texts: string[], options?: { signal?: AbortSignal | undefined }) {
    options?.signal?.throwIfAborted();
    const missing = [
      ...new Map(
        texts.filter((t) => !this.cache[this.key(t)]).map((t) => [this.key(t), t]),
      ).values(),
    ];
    if (missing.length && !this.allowExternal)
      throw new Error('Semantic cache miss: explicit --allow-external prefetch required');
    const newHashes = missing
      .map((t) => this.key(t))
      .filter((h) => !this.ledger.inputHashes.includes(h));
    const bytes = missing.reduce((n, t) => n + Buffer.byteLength(t), 0);
    if (
      this.ledger.inputHashes.length + newHashes.length > 1000 ||
      this.ledger.inputByteUpperBound + bytes > 1_000_000 ||
      this.ledger.requests + Math.ceil(missing.length / 16) > 100
    )
      throw new Error('EMBEDDING_BUDGET_EXHAUSTED');
    if (missing.length) {
      const provider = new OpenAiEmbeddingProvider({
        apiKey:
          this.environment.RAG_EMBEDDING_API_KEY?.trim() ||
          this.environment.OPENAI_API_KEY?.trim() ||
          '',
        fetcher: async (input, init) => {
          this.ledger.requests++;
          await this.save();
          try {
            const response = await fetch(input, init);
            if (!response.ok) this.ledger.failedRequests++;
            const payload = (await response.clone().json()) as {
              usage?: { prompt_tokens?: number };
            };
            this.ledger.actualInputTokens += payload.usage?.prompt_tokens ?? 0;
            await this.save();
            return response;
          } catch (error) {
            this.ledger.failedRequests++;
            await this.save();
            throw error;
          }
        },
      });
      for (let i = 0; i < missing.length; i += 16) {
        options?.signal?.throwIfAborted();
        const batch = missing.slice(i, i + 16);
        this.ledger.inputHashes = [
          ...new Set([...this.ledger.inputHashes, ...batch.map((t) => this.key(t))]),
        ];
        this.ledger.inputByteUpperBound += batch.reduce((n, t) => n + Buffer.byteLength(t), 0);
        await this.save();
        const vectors = await provider.embed(batch, options);
        batch.forEach((t, j) => {
          this.cache[this.key(t)] = vectors[j]!;
        });
        await this.save();
        console.log(
          JSON.stringify({
            embeddingBatch: Math.floor(i / 16) + 1,
            cached: Object.keys(this.cache).length,
            requests: this.ledger.requests,
            inputTokens: this.ledger.actualInputTokens,
          }),
        );
      }
    }
    return texts.map((t) => [...this.cache[this.key(t)]!]);
  }
}
