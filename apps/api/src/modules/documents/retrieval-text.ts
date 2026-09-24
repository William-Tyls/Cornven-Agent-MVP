import { Converter } from 'opencc-js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RagError } from './rag-errors.js';
const toSimplified = Converter({ from: 'tw', to: 'cn' });
export const NORMALIZER_VERSION = `opencc-js-1.4.2-tw-cn-nfkc-segmenter-trilingual-v3-icu-${process.versions.icu}`;
const normalizedCache = new Map<string, string>();
export function normalizeRetrievalText(value: string): string {
  const cached = normalizedCache.get(value);
  if (cached !== undefined) return cached;
  if (normalizedCache.size > 4096) normalizedCache.clear();
  const result = toSimplified(value.normalize('NFKC'))
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim();
  normalizedCache.set(value, result);
  return result;
}
const entrySchema = z
  .object({
    topic: z.string().min(1),
    canonical: z.string().min(1),
    aliases: z.array(z.string().min(1)).min(1),
    context: z.array(z.string()).default([]),
    sourceId: z.string().min(1),
    locator: z.string().min(1),
    note: z.string().min(1),
  })
  .strict();
export const SynonymSchema = z
  .object({ schemaVersion: z.literal(1), entries: z.array(entrySchema) })
  .strict();
export type SynonymConfig = z.infer<typeof SynonymSchema>;
let cachedSynonyms: { raw: string; config: SynonymConfig } | undefined;
export function loadSynonyms(): SynonymConfig {
  try {
    const raw = readFileSync(
      new URL('../../../../../data/rag/retrieval-synonyms.json', import.meta.url),
      'utf8',
    );
    if (cachedSynonyms?.raw === raw) return cachedSynonyms.config;
    const config = SynonymSchema.parse(JSON.parse(raw));
    cachedSynonyms = { raw, config };
    return config;
  } catch {
    throw new RagError('RAG_CONFIG_INVALID');
  }
}
export const synonymHash = (config: SynonymConfig) =>
  createHash('sha256').update(JSON.stringify(config)).digest('hex');
const stopPhrases =
  /应该|应当|应如何|如何|怎么|什么|哪些|是否|需要|请问|请告诉我|请说明|想确认|可以|时候|之后|之前|多少|多久|哪里|什么样|有关|的要求|的规则|cornven/gu;
const stopTokens = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '一个',
  '相关',
  '进行',
  '使用',
  '这样',
  '怎样',
  'the',
  'how',
  'what',
  'is',
  'to',
  'a',
  'and',
  'for',
  'are',
  'of',
  'in',
  'on',
  'it',
  'be',
  'should',
  'can',
  'do',
  'does',
  'i',
  'my',
  'at',
  'which',
  'when',
  'where',
  'there',
  'their',
  'after',
  'each',
]);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const functionWords = new Set(
  '的 了 吗 呢 在 上 下 里 中 要 会 能 有 应该 该 可以 需要 应 如何 什么 哪些 哪个 哪里 怎么 多久 多少 为什么 是 与 和 或 或者 及 并 也 就 才 都 到 去 来 看 写 填 做 先 后 最 为 被 把 请 是否 谁 由 按 安排 执行 满足 才算'.split(
    ' ',
  ),
);
const tokenCache = new Map<string, string[]>();
let tokenConfig: SynonymConfig | undefined;
export function retrievalTokens(value: string, canonicalize = true): string[] {
  const config = loadSynonyms();
  if (tokenConfig !== config) {
    tokenCache.clear();
    tokenConfig = config;
  }
  const cacheKey = String(canonicalize) + ':' + value;
  const cached = tokenCache.get(cacheKey);
  if (cached) return [...cached];
  if (tokenCache.size > 4096) tokenCache.clear();
  const normalized = normalizeRetrievalText(value).replaceAll('_', ' ');
  const text = (canonicalize ? canonicalView(normalized, config, Infinity) : normalized).replace(
    stopPhrases,
    ' ',
  );
  const tokens: string[] = [...text.matchAll(/\b[a-z]-[0-9]+\b/gi)].map((m) => m[0]);
  for (const part of segmenter.segment(text)) {
    const word = part.segment;
    if (!part.isWordLike || functionWords.has(word) || stopTokens.has(word)) continue;
    tokens.push(word);
    if (/^\p{Script=Han}{4,}$/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
    }
  }
  tokenCache.set(cacheKey, tokens);
  return [...tokens];
}
export function canonicalView(text: string, config: SynonymConfig, maximum = 8): string {
  const active = config.entries.filter(
    (e) => !e.context.length || e.context.some((c) => text.includes(normalizeRetrievalText(c))),
  );
  const replacements = new Map<string, string>();
  // Longest phrases win before shorter substring aliases, independently of file order.
  for (const e of active)
    for (const phrase of [e.canonical, ...e.aliases])
      replacements.set(normalizeRetrievalText(phrase), normalizeRetrievalText(e.canonical));
  const phrases = [...replacements.keys()].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  let result = '';
  const concepts = new Set<string>();
  for (let i = 0; i < text.length; ) {
    const phrase = phrases.find(
      (p) =>
        text.startsWith(p, i) &&
        (!/^[a-z0-9]/i.test(p) || !/[a-z0-9_]/i.test(text[i - 1] ?? '')) &&
        (!/[a-z0-9]$/i.test(p) || !/[a-z0-9_]/i.test(text[i + p.length] ?? '')),
    );
    if (phrase) {
      const canonical = replacements.get(phrase)!;
      if (phrase === canonical || concepts.has(canonical) || concepts.size < maximum) {
        result += canonical;
        if (phrase !== canonical) concepts.add(canonical);
      } else result += phrase;
      i += phrase.length;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}
export function queryViews(
  original: string,
  keywords: string | undefined,
  config: SynonymConfig,
): string[] {
  const first = normalizeRetrievalText(original),
    second = normalizeRetrievalText(keywords ?? original);
  return [...new Set([first, second, canonicalView(first, config)])].slice(0, 3);
}
