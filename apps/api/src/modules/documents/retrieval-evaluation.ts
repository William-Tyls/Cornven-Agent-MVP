import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { DocumentPermissionTagSchema } from '@cornven/contracts';

import type { DocumentsService } from './documents.service.js';

const GoldenPositiveQuestionSchema = z
  .object({
    query: z.string().trim().min(1),
    permissionTags: z.array(DocumentPermissionTagSchema).min(1),
    expectedDocumentId: z.string().trim().min(1),
    expectedLocatorText: z.string().trim().min(1),
    expectedExcerptText: z.string().trim().min(1),
    maxRank: z.number().int().min(1).max(10),
  })
  .strict();

const GoldenNegativeQuestionSchema = z
  .object({
    query: z.string().trim().min(1),
    permissionTags: z.array(DocumentPermissionTagSchema).min(1),
  })
  .strict();

export const RetrievalEvaluationSuiteSchema = z
  .object({
    positive: z.array(GoldenPositiveQuestionSchema).min(1),
    negative: z.array(GoldenNegativeQuestionSchema).min(1),
  })
  .strict();

export type RetrievalEvaluationSuite = z.infer<typeof RetrievalEvaluationSuiteSchema>;

export interface RetrievalEvaluationReport {
  positiveCases: number;
  negativeCases: number;
  maximumObservedRank: number;
  coveredDocumentIds: string[];
}

const defaultSuiteUrl = new URL(
  '../../../../../fixtures/rag/golden-questions.json',
  import.meta.url,
);

export async function loadRetrievalEvaluationSuite(
  url: URL = defaultSuiteUrl,
): Promise<RetrievalEvaluationSuite> {
  return RetrievalEvaluationSuiteSchema.parse(JSON.parse(await readFile(url, 'utf8')));
}

export async function evaluateRetrieval(
  service: Pick<DocumentsService, 'search'>,
  suite: RetrievalEvaluationSuite,
): Promise<RetrievalEvaluationReport> {
  let maximumObservedRank = 0;

  for (const testCase of suite.positive) {
    const output = await service.search(
      { query: testCase.query, limit: testCase.maxRank },
      { permissionTags: testCase.permissionTags },
    );
    const sourceMatchIndex = output.results.findIndex(
      (result) =>
        result.documentId === testCase.expectedDocumentId &&
        result.locator.includes(testCase.expectedLocatorText),
    );
    if (!output.evidenceSufficient || sourceMatchIndex === -1) {
      throw new Error(`RAG positive evaluation missed the expected source for: ${testCase.query}`);
    }

    const matchIndex = output.results.findIndex(
      (result) =>
        result.documentId === testCase.expectedDocumentId &&
        result.locator.includes(testCase.expectedLocatorText) &&
        result.excerpt.includes(testCase.expectedExcerptText),
    );
    const match = output.results[matchIndex];
    if (!match) {
      throw new Error(`RAG positive evaluation returned the wrong excerpt for: ${testCase.query}`);
    }
    if (!match.content.includes(match.excerpt)) {
      throw new Error(`RAG evaluation excerpt is not verbatim for: ${testCase.query}`);
    }
    maximumObservedRank = Math.max(maximumObservedRank, matchIndex + 1);
  }

  for (const testCase of suite.negative) {
    const output = await service.search(
      { query: testCase.query, limit: 5 },
      { permissionTags: testCase.permissionTags },
    );
    if (output.evidenceSufficient || output.results.length > 0) {
      throw new Error(
        `RAG negative evaluation produced unsupported evidence for: ${testCase.query}`,
      );
    }
  }

  return {
    positiveCases: suite.positive.length,
    negativeCases: suite.negative.length,
    maximumObservedRank,
    coveredDocumentIds: [
      ...new Set(suite.positive.map((testCase) => testCase.expectedDocumentId)),
    ].sort(),
  };
}
