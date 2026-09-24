import { createHash } from 'node:crypto';

import type { DocumentPermissionTag } from '@cornven/contracts';

import type { SourceDocument } from './source-loader.js';

export interface ChunkingOptions {
  maxChars: number;
  overlapChars: number;
}

export interface DocumentChunk {
  documentId: string;
  documentVersion: string;
  chunkId: string;
  title: string;
  sourceUrl: string;
  sourceVersion: string;
  contentStatus: string;
  audience: 'staff_internal' | 'creator_facing';
  permissionTags: DocumentPermissionTag[];
  ordinal: number;
  headingPath: string[];
  locator: string;
  content: string;
  checksum: string;
  blockIds?: string[];
  resourceIds?: string[];
}

interface MarkdownSection {
  headingPath: string[];
  body: string;
  blockIds?: string[];
  resourceIds?: string[];
}

const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
const preferredBreakCharacters = new Set([
  '\n',
  '。',
  '！',
  '？',
  '.',
  '!',
  '?',
  '；',
  ';',
  '，',
  ',',
]);

export const defaultChunkingOptions: ChunkingOptions = {
  maxChars: 1_600,
  overlapChars: 240,
};

function validateOptions(options: ChunkingOptions): void {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 400) {
    throw new Error('maxChars must be an integer of at least 400.');
  }
  if (
    !Number.isInteger(options.overlapChars) ||
    options.overlapChars < 0 ||
    options.overlapChars >= options.maxChars / 2
  ) {
    throw new Error('overlapChars must be a non-negative integer smaller than half maxChars.');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const headings: string[] = [];
  let activeHeadingPath: string[] = [];
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join('\n').trim();
    if (body) {
      sections.push({ headingPath: [...activeHeadingPath], body });
    }
    bodyLines = [];
  };

  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const heading = headingPattern.exec(line);
    if (!heading) {
      bodyLines.push(line);
      continue;
    }

    flush();
    const level = heading[1]?.length ?? 1;
    const title = heading[2]?.trim() ?? '';
    headings.length = level - 1;
    headings[level - 1] = title;
    activeHeadingPath = headings.filter(Boolean);
  }
  flush();
  return sections;
}

function headingPrefix(headingPath: string[]): string {
  return headingPath
    .map((heading, index) => `${'#'.repeat(Math.min(index + 1, 6))} ${heading}`)
    .join('\n');
}

function chooseBreak(text: string, idealEnd: number, minimumEnd: number): number {
  for (let index = idealEnd; index >= minimumEnd; index -= 1) {
    const character = text[index - 1];
    if (character && preferredBreakCharacters.has(character)) {
      return index;
    }
  }
  return idealEnd;
}

function chooseOverlapStart(text: string, idealStart: number, minimumStart: number): number {
  for (let index = idealStart; index >= minimumStart; index -= 1) {
    const character = text[index - 1];
    if (character && preferredBreakCharacters.has(character)) {
      return index;
    }
  }
  return idealStart;
}

function splitTextWithOverlap(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text.trim()];
  }

  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const idealEnd = Math.min(start + maxChars, text.length);
    const end =
      idealEnd === text.length
        ? idealEnd
        : chooseBreak(text, idealEnd, start + Math.floor(maxChars * 0.65));
    const part = text.slice(start, end).trim();
    if (part) {
      parts.push(part);
    }
    if (end >= text.length) {
      break;
    }

    const idealStart = Math.max(start + 1, end - overlapChars);
    const nextStart = chooseOverlapStart(text, idealStart, Math.max(start + 1, idealStart - 80));
    start = nextStart < end ? nextStart : end;
  }
  return parts;
}

function splitMarkdownTable(table: string, maxChars: number, overlapChars: number): string[] {
  const lines = table.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|'));
  let end = start;
  while (end < lines.length && lines[end]!.startsWith('|')) end++;
  const rows = lines.slice(start, end).filter(Boolean);
  const prefix = lines.slice(0, start).join('\n').trim();
  const suffix = lines.slice(end).join('\n').trim();
  if (suffix.split('\n').some((line) => line.startsWith('|')))
    throw new Error('Multiple tables exceed chunk budget; review required.');
  const render = (rows: string[]) => [prefix, rows.join('\n'), suffix].filter(Boolean).join('\n\n');
  if (rows.length <= 2 || table.length <= maxChars) {
    return [table.trim()];
  }

  const header = rows.slice(0, 2);
  const dataRows = rows.slice(2);
  const parts: string[] = [];
  let currentRows: string[] = [];

  const flush = () => {
    if (currentRows.length > 0) {
      parts.push(render([...header, ...currentRows]));
    }
  };

  for (const row of dataRows) {
    if (render([...header, row]).length > maxChars)
      throw new Error('Table row exceeds chunk budget; review required.');
    const candidate = render([...header, ...currentRows, row]);
    if (candidate.length <= maxChars || currentRows.length === 0) {
      currentRows.push(row);
      continue;
    }

    flush();
    const overlapRows: string[] = [];
    let overlapLength = 0;
    for (let index = currentRows.length - 1; index >= 0; index -= 1) {
      const priorRow = currentRows[index];
      if (!priorRow || (overlapLength >= overlapChars && overlapRows.length > 0)) {
        break;
      }
      overlapRows.unshift(priorRow);
      overlapLength += priorRow.length;
    }
    while (overlapRows.length && render([...header, ...overlapRows, row]).length > maxChars)
      overlapRows.shift();
    currentRows = [...overlapRows, row];
  }
  flush();
  return parts;
}

function splitSectionBody(body: string, maxChars: number, overlapChars: number): string[] {
  if (body.length <= maxChars) {
    return [body.trim()];
  }
  if (body.includes('\n| ---')) {
    return splitMarkdownTable(body, maxChars, overlapChars);
  }
  return splitTextWithOverlap(body, maxChars, overlapChars);
}

function sectionLocator(
  headingPath: string[],
  occurrence: number,
  occurrenceCount: number,
  part: number,
  partCount: number,
): string {
  const base = headingPath.join(' > ');
  const qualifiers: string[] = [];
  if (occurrenceCount > 1) {
    qualifiers.push(`occurrence ${occurrence}/${occurrenceCount}`);
  }
  if (partCount > 1) {
    qualifiers.push(`part ${part}/${partCount}`);
  }
  return qualifiers.length > 0 ? `${base} (${qualifiers.join(', ')})` : base;
}

export function chunkMarkdownDocument(
  document: SourceDocument,
  options: ChunkingOptions = defaultChunkingOptions,
): DocumentChunk[] {
  validateOptions(options);
  const chunks: DocumentChunk[] = [];
  let ordinal = 0;
  const sections: MarkdownSection[] =
    document.structure?.sections ?? parseSections(document.markdown);
  const sectionCounts = new Map<string, number>();
  const sectionOccurrences = new Map<string, number>();
  for (const section of sections) {
    const key = section.headingPath.join(' > ');
    sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
  }

  for (const section of sections) {
    const prefix = headingPrefix(section.headingPath);
    const sectionKey = section.headingPath.join(' > ');
    const occurrence = (sectionOccurrences.get(sectionKey) ?? 0) + 1;
    sectionOccurrences.set(sectionKey, occurrence);
    const bodyLimit = Math.max(256, options.maxChars - prefix.length - 2);
    const bodyParts = splitSectionBody(section.body, bodyLimit, options.overlapChars);

    bodyParts.forEach((body, partIndex) => {
      const content = `${prefix}\n\n${body}`.trim();
      if (content.length > options.maxChars) throw new Error('Section exceeds chunk budget');
      const locator = sectionLocator(
        section.headingPath,
        occurrence,
        sectionCounts.get(sectionKey) ?? 1,
        partIndex + 1,
        bodyParts.length,
      );
      const checksum = sha256(
        `${document.sourceId}\n${document.sourceVersion}\n${locator}\n${content}`,
      );
      chunks.push({
        documentId: document.sourceId,
        documentVersion: document.sourceVersion,
        chunkId: checksum,
        title: document.title,
        sourceUrl: document.sourceUrl,
        sourceVersion: document.sourceVersion,
        contentStatus: document.contentStatus,
        audience: document.audience,
        permissionTags: [...document.permissionTags],
        ordinal,
        headingPath: [...section.headingPath],
        locator,
        content,
        checksum,
        ...(section.blockIds
          ? {
              blockIds: section.blockIds,
              resourceIds: (section.resourceIds ?? []).filter((id) =>
                document.structure?.resources.some(
                  (r) =>
                    r.resourceId === id &&
                    (body.includes(r.label) ||
                      (r.originalUrl && body.includes(r.originalUrl)) ||
                      (r.assetId && body.includes(r.assetId))),
                ),
              ),
            }
          : {}),
      });
      ordinal += 1;
    });
  }

  return chunks;
}
