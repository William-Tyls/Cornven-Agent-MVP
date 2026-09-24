import {
  normalizeRetrievalText,
  retrievalTokens,
  queryViews,
  loadSynonyms,
} from './retrieval-text.js';

export const maximumExcerptCharacters = 480;

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

function sourceBody(content: string): string {
  const separator = content.indexOf('\n\n');
  return (separator === -1 ? content : content.slice(separator + 2)).trim();
}

function sentenceSpans(content: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (!character || !'。！？.!?；;\n'.includes(character)) {
      continue;
    }
    const end = index + 1;
    const text = content.slice(start, end).trim();
    if (text) {
      const leadingWhitespace = content.slice(start, end).search(/\S/u);
      spans.push({
        start: start + Math.max(leadingWhitespace, 0),
        end: start + Math.max(leadingWhitespace, 0) + text.length,
        text,
      });
    }
    start = end;
  }

  const tail = content.slice(start).trim();
  if (tail) {
    const leadingWhitespace = content.slice(start).search(/\S/u);
    spans.push({
      start: start + Math.max(leadingWhitespace, 0),
      end: start + Math.max(leadingWhitespace, 0) + tail.length,
      text: tail,
    });
  }
  return spans;
}

function normalized(value: string): string {
  return normalizeRetrievalText(value);
}

function relevanceScore(span: TextSpan, queryTokens: string[]): number {
  const candidate = normalized(span.text);
  return queryTokens.reduce(
    (score, token) => score + (candidate.includes(token) ? Math.max(token.length, 1) : 0),
    0,
  );
}

function cropLongSpan(
  span: TextSpan,
  body: string,
  queryTokens: string[],
  maxChars: number,
): string {
  // Score original-coordinate windows; conversion can change string length.
  let best = body.slice(span.start, Math.min(span.start + maxChars, span.end)).trim();
  let score = -1;
  for (
    let offset = span.start;
    offset < span.end;
    offset += Math.max(1, Math.floor(maxChars / 4))
  ) {
    const end = Math.min(offset + maxChars, span.end);
    const text = body.slice(offset, end).trim();
    const current = relevanceScore({ start: offset, end, text }, queryTokens);
    if (current > score) {
      score = current;
      best = text;
    }
  }
  return best;
}

export function extractVerbatimExcerpt(
  chunkContent: string,
  query: string,
  maxChars = maximumExcerptCharacters,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 80 || maxChars > maximumExcerptCharacters) {
    throw new Error(
      `Excerpt length must be an integer between 80 and ${maximumExcerptCharacters}.`,
    );
  }

  const body = sourceBody(chunkContent);
  if (!body) {
    throw new Error('Cannot extract an excerpt from empty chunk content.');
  }
  if (body.length <= maxChars) {
    return body;
  }

  const spans = sentenceSpans(body);
  const queryTokens = [
    ...new Set(
      queryViews(query, undefined, loadSynonyms()).flatMap((view) => retrievalTokens(view, false)),
    ),
  ].sort((left, right) => right.length - left.length);
  let bestIndex = 0;
  let bestScore = -1;
  spans.forEach((span, index) => {
    const score = relevanceScore(span, queryTokens);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });

  const best = spans[bestIndex];
  if (!best) {
    return body.slice(0, maxChars).trim();
  }
  if (best.end - best.start > maxChars) {
    return cropLongSpan(best, body, queryTokens, maxChars);
  }

  let startIndex = bestIndex;
  let endIndex = bestIndex;
  let start = best.start;
  let end = best.end;
  while (true) {
    const before = spans[startIndex - 1];
    const after = spans[endIndex + 1];
    const canAddAfter = Boolean(after && after.end - start <= maxChars);
    const canAddBefore = Boolean(before && end - before.start <= maxChars);
    if (!canAddAfter && !canAddBefore) {
      break;
    }
    const addAfterFirst =
      canAddAfter &&
      (!canAddBefore || (after?.end ?? end) - end <= start - (before?.start ?? start));
    if (addAfterFirst) {
      endIndex += 1;
      end = spans[endIndex]?.end ?? end;
    } else {
      startIndex -= 1;
      start = spans[startIndex]?.start ?? start;
    }
  }

  return body.slice(start, end).trim();
}
