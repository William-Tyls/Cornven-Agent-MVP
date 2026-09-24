import type { DocumentSearchResult } from '@cornven/contracts';
import {
  canonicalView,
  loadSynonyms,
  normalizeRetrievalText,
  retrievalTokens,
} from './retrieval-text.js';
export const RETRIEVAL_PROFILE = {
  version: 'hybrid-v11-contract-languages',
  coverageQueryModifiers: ['要求'],
  k1: 1.2,
  b: 0.75,
  titleWeight: 4,
  inheritedTitleWeight: 0.2,
  lexicalWeight: 4,
  vectorWeight: 1,
  semanticLexicalWeight: 0.25,
  semanticVectorWeight: 1,
  rrfK: 60,
  lexicalMinimum: 0.2,
  coverageMinimum: 0.33,
  semanticMinimum: 0.5,
  semanticEnglishMinimum: 0.35,
  rawViewRankPenalty: 4,
} as const;
export interface RetrievalCandidate extends Omit<DocumentSearchResult, 'excerpt'> {
  score: number;
}
const stableKey = (c: RetrievalCandidate) => `${c.documentId}\n${c.locator}\n${c.chunkId}`;
export function rankCandidates(
  candidates: RetrievalCandidate[],
  views: string[],
  mode: 'semantic' | 'lexical_hash',
  limit: number,
  minimumScore?: number,
  relations: Map<string, string[]> = new Map(),
  resourceChunkIds: Set<string> = new Set(),
  fitsContext: (selection: RetrievalCandidate[]) => boolean = () => true,
): RetrievalCandidate[] {
  if (!candidates.length) return [];
  const canonicalQuery = canonicalView(views[0] ?? '', loadSynonyms());
  const semanticMinimum =
    minimumScore ??
    (/\p{Script=Han}/u.test(views[0] ?? '')
      ? RETRIEVAL_PROFILE.semanticMinimum
      : RETRIEVAL_PROFILE.semanticEnglishMinimum);
  const contractLanguage = /合约/.test(canonicalQuery)
    ? /chinese version/.test(canonicalQuery) && !/english version/.test(canonicalQuery)
      ? 'chinese'
      : /english version/.test(canonicalQuery) && !/chinese version/.test(canonicalQuery)
        ? 'english'
        : undefined
    : undefined;
  const resourceQuery =
    !!contractLanguage || /链接|连结|下载|\blink\b|\blinks\b|\bdownload\b/.test(canonicalQuery);
  const exactIds = (views[0] ?? '').match(/\b[a-z]-[0-9]+\b/gi) ?? [];
  const unique = [...new Map(candidates.map((c) => [c.chunkId, c])).values()].filter((c) => {
    // A language qualifier identifies the requested file/version. Preserve generic
    // SOP passages, but do not replace it with an explicitly different language.
    const language = /\((chinese|english) version\)/i.exec(c.locator)?.[1]?.toLowerCase();
    return (
      (!contractLanguage || !language || language === contractLanguage) &&
      (!exactIds.length ||
        exactIds.every((id) => normalizeRetrievalText(c.content).includes(id.toLowerCase())))
    );
  });
  const docs = unique.map((c) => {
    const body = retrievalTokens(c.content.split('\n\n').slice(1).join('\n\n') || c.content);
    const title = retrievalTokens(c.locator.split(' > ').at(-1) ?? c.locator);
    const parents = retrievalTokens(c.locator.split(' > ').slice(0, -1).join(' '));
    const tf = new Map<string, number>();
    for (const token of body) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of title) tf.set(token, (tf.get(token) ?? 0) + RETRIEVAL_PROFILE.titleWeight);
    for (const token of parents)
      tf.set(token, (tf.get(token) ?? 0) + RETRIEVAL_PROFILE.inheritedTitleWeight);
    return { c, tf, title, length: body.length + title.length * 2 };
  });
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const frequencies = new Map<string, number>();
  for (const doc of docs)
    for (const token of doc.tf.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const lexicalRanks = new Map<string, number>();
  const eligible = new Set<string>();
  for (const view of views.slice(0, 3)) {
    const terms = [...new Set(retrievalTokens(view, false))];
    // A generic request for requirements is not itself a subject or a condition.
    // Keep it in BM25 ranking, but do not let its rarity veto matching topic sections.
    // Require two other terms; short/ambiguous queries keep their original gate.
    const topicTerms = terms.filter(
      (term) => !(RETRIEVAL_PROFILE.coverageQueryModifiers as readonly string[]).includes(term),
    );
    const coverageTerms = new Set(topicTerms.length >= 2 ? topicTerms : terms);
    const ranked = docs
      .map((doc) => {
        let score = 0,
          matched = 0,
          totalWeight = 0;
        for (const term of terms) {
          const tf = doc.tf.get(term) ?? 0;

          const df = frequencies.get(term) ?? 0;
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          const coverageIdf = docs.length < 10 ? Math.max(1, idf) : idf;
          if (coverageTerms.has(term)) {
            totalWeight += coverageIdf;
            if (tf) matched += coverageIdf;
          }
          score +=
            (idf * tf * (RETRIEVAL_PROFILE.k1 + 1)) /
            (tf +
              RETRIEVAL_PROFILE.k1 *
                (1 - RETRIEVAL_PROFILE.b + (RETRIEVAL_PROFILE.b * doc.length) / avg));
        }
        const coverage = totalWeight ? matched / totalWeight : 0;
        const relevance = coverage;
        const titleTerms = [...new Set(doc.title)];
        const titleMatches = titleTerms.filter((t) => terms.includes(t)).length;
        const anchored = titleMatches >= 2 && titleMatches / titleTerms.length >= 0.6;
        const identifierMatch = exactIds.length > 0;
        const accepted =
          identifierMatch ||
          (mode === 'semantic'
            ? doc.c.score >= semanticMinimum ||
              (resourceQuery &&
                resourceChunkIds.has(doc.c.chunkId) &&
                (coverage >= RETRIEVAL_PROFILE.coverageMinimum || anchored) &&
                score >= 3) ||
              (coverage >= 0.5 && score >= 3)
            : (coverage >= RETRIEVAL_PROFILE.coverageMinimum || anchored) &&
              (minimumScore === undefined ? true : relevance >= minimumScore));
        if (accepted) eligible.add(doc.c.chunkId);
        return {
          doc,
          lexicallyRelevant:
            identifierMatch || coverage >= RETRIEVAL_PROFILE.coverageMinimum || anchored,
          score: score * (1 + titleMatches / Math.max(titleTerms.length, 1)),
        };
      })
      .filter((x) => x.score > 0 && (mode !== 'semantic' || x.lexicallyRelevant))
      .sort((a, b) => b.score - a.score || stableKey(a.doc.c).localeCompare(stableKey(b.doc.c)))
      .slice(0, 20);
    ranked.forEach(({ doc }, i) =>
      lexicalRanks.set(
        doc.c.chunkId,
        Math.min(
          lexicalRanks.get(doc.c.chunkId) ?? Infinity,
          i + 1 + (view === canonicalQuery ? 0 : RETRIEVAL_PROFILE.rawViewRankPenalty),
        ),
      ),
    );
  }
  const vectorRanks = new Map(
    [...unique]
      .sort((a, b) => b.score - a.score || stableKey(a).localeCompare(stableKey(b)))
      .slice(0, 20)
      .map((c, i) => [c.chunkId, i + 1]),
  );
  const ranked = unique
    .filter(
      (c) => eligible.has(c.chunkId) && (lexicalRanks.has(c.chunkId) || vectorRanks.has(c.chunkId)),
    )
    .map((c) => ({
      c,
      score:
        (lexicalRanks.has(c.chunkId)
          ? (mode === 'semantic'
              ? RETRIEVAL_PROFILE.semanticLexicalWeight
              : RETRIEVAL_PROFILE.lexicalWeight) /
            (RETRIEVAL_PROFILE.rrfK + lexicalRanks.get(c.chunkId)!)
          : 0) +
        (vectorRanks.has(c.chunkId)
          ? (mode === 'semantic'
              ? RETRIEVAL_PROFILE.semanticVectorWeight
              : RETRIEVAL_PROFILE.vectorWeight) /
            (RETRIEVAL_PROFILE.rrfK + vectorRanks.get(c.chunkId)!)
          : 0),
    }))
    .map(({ c, score }) => ({
      c,
      score:
        score +
        (relations.has(c.chunkId)
          ? 1 /
            (RETRIEVAL_PROFILE.rrfK +
              Math.min(lexicalRanks.get(c.chunkId) ?? 20, vectorRanks.get(c.chunkId) ?? 20))
          : 0) +
        (resourceQuery && resourceChunkIds.has(c.chunkId) && lexicalRanks.has(c.chunkId)
          ? 1 / (RETRIEVAL_PROFILE.rrfK + lexicalRanks.get(c.chunkId)!)
          : 0),
    }))
    .sort((a, b) => b.score - a.score || stableKey(a.c).localeCompare(stableKey(b.c)));
  const selected: RetrievalCandidate[] = [];
  const body = (c: RetrievalCandidate) =>
    normalizeRetrievalText(c.content.split('\n\n').slice(1).join('\n\n') || c.content);
  const contrastKey = (c: RetrievalCandidate) =>
    body(c)
      .replace(/必须|不得|禁止|不能|不可|无需|不必|必要|应当|可以/gu, '')
      .replace(/[0-9一二三四五六七八九十百零]+/gu, '#')
      .replace(/[\s\p{Punctuation}]/gu, '');
  const contrast = (a: RetrievalCandidate, b: RetrievalCandidate) => {
    const x = body(a),
      y = body(b);
    return (
      x !== y &&
      contrastKey(a) === contrastKey(b) &&
      (/(不得|禁止|不能|不可|无需|不必)/u.test(x) !== /(不得|禁止|不能|不可|无需|不必)/u.test(y) ||
        JSON.stringify(x.match(/[0-9一二三四五六七八九十百零]+/gu)) !==
          JSON.stringify(y.match(/[0-9一二三四五六七八九十百零]+/gu)))
    );
  };
  // Compare only the <=80 candidates already admitted to either ranking channel.
  // Opposite mandatory/prohibited statements and differing numbers must travel together.
  const baseIds = new Set(
    [
      ...ranked.map((x) => x.c.chunkId),
      ...unique
        .filter((c) => lexicalRanks.has(c.chunkId) || vectorRanks.has(c.chunkId))
        .map((c) => c.chunkId),
    ].slice(0, relations.size ? 74 : 80),
  );
  const byId = new Map(unique.map((c) => [c.chunkId, c]));
  const companionsById = new Map<string, RetrievalCandidate[]>();
  const expansionIds = new Set<string>();
  for (const { c } of ranked.filter(({ c }) => relations.has(c.chunkId)).slice(0, 3)) {
    const related = (relations.get(c.chunkId) ?? [])
      .map((id) => byId.get(id))
      .filter((p): p is RetrievalCandidate => Boolean(p))
      .slice(0, 2);
    for (const p of related) expansionIds.add(p.chunkId);
    companionsById.set(c.chunkId, related);
  }
  const pool = unique.filter((c) => baseIds.has(c.chunkId) || expansionIds.has(c.chunkId));
  for (const { c } of ranked) {
    if (!baseIds.has(c.chunkId) || selected.some((p) => p.chunkId === c.chunkId)) continue;
    if (relations.has(c.chunkId) && !companionsById.has(c.chunkId)) continue;
    if (selected.some((p) => p.documentId === c.documentId && body(p).includes(body(c)))) continue;
    const companions = pool
      .filter(
        (p) =>
          p.chunkId !== c.chunkId &&
          (contrast(c, p) || companionsById.get(c.chunkId)?.some((x) => x.chunkId === p.chunkId)) &&
          !selected.some((s) => s.chunkId === p.chunkId),
      )
      .sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    // Do not cut a contradictory pair at the context boundary.
    if (selected.length + 1 + companions.length > limit) continue;
    if (!fitsContext([...selected, c, ...companions])) continue;
    selected.push(c, ...companions);
    if (selected.length === limit) break;
  }
  return selected;
}
