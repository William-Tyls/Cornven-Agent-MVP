import { z } from 'zod';

import { IdentifierSchema, VerbatimExcerptSchema } from './common.js';

export const RAG_EMBEDDING_DIMENSIONS = 1_024;
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large';

export const DocumentPermissionTagSchema = z.enum(['staff', 'creator']);

export const DocumentSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    limit: z.number().int().min(1).max(15).default(5),
  })
  .strict();

export const DocumentSearchResultSchema = z
  .object({
    documentId: IdentifierSchema,
    documentVersion: IdentifierSchema,
    chunkId: IdentifierSchema,
    title: z.string().trim().min(1),
    locator: z.string().trim().min(1),
    excerpt: VerbatimExcerptSchema,
    content: z.string().trim().min(1),
  })
  .strict();

export const DocumentSearchOutputSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    evidenceSufficient: z.boolean(),
    results: z.array(DocumentSearchResultSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evidenceSufficient !== value.results.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceSufficient'],
        message: 'evidenceSufficient must be true exactly when at least one result is returned.',
      });
    }
  });

export const DocumentModuleStatusSchema = z.object({
  status: z.enum(['not_configured', 'ready']),
  indexedDocuments: z.number().int().nonnegative(),
  indexedChunks: z.number().int().nonnegative(),
  embeddingProvider: z.string().trim().min(1),
  message: z.string().trim().min(1),
});

export type DocumentPermissionTag = z.infer<typeof DocumentPermissionTagSchema>;
export type DocumentSearchInput = z.infer<typeof DocumentSearchInputSchema>;
export type DocumentSearchResult = z.infer<typeof DocumentSearchResultSchema>;
export type DocumentSearchOutput = z.infer<typeof DocumentSearchOutputSchema>;
export type DocumentModuleStatus = z.infer<typeof DocumentModuleStatusSchema>;
