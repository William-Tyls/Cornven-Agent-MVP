import type { AssistantEvidenceBundle } from './assistant-evidence.js';
import { RagError } from './rag-errors.js';

export const CONTEXT_POLICY_VERSION = 'bounded-bundles-v1';
export const MAX_RAG_PASSAGES = 15;
// User-selected Plan B default (2026-09-24); k remains an upper bound.
export const DEFAULT_RAG_TOP_K = 8;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 16000;
export function contextPolicy(environment: NodeJS.ProcessEnv = process.env) {
  const integer = (raw: string | undefined, fallback: number, min: number, max: number) => {
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new RagError('RAG_CONFIG_INVALID');
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new RagError('RAG_CONFIG_INVALID');
    return n;
  };
  return {
    version: CONTEXT_POLICY_VERSION,
    topK: integer(environment.RAG_TOP_K, DEFAULT_RAG_TOP_K, 1, MAX_RAG_PASSAGES),
    tokenBudget: integer(
      environment.RAG_CONTEXT_TOKEN_BUDGET,
      DEFAULT_CONTEXT_TOKEN_BUDGET,
      1024,
      64000,
    ),
  };
}
export function modelReferences(items: AssistantEvidenceBundle['items']) {
  return items.map((item, index) => ({ sourceNumber: index + 1, ...item }));
}
/** Conservative byte-level text-token upper bound, NOT exact or billable token usage.
 * Includes the serialized references key/array, metadata, excerpts and full text.
 * Does not include system instructions, the question or output tokens.
 */
export function evidenceTokenUpperBound(items: AssistantEvidenceBundle['items']): number {
  return Buffer.byteLength(JSON.stringify({ references: modelReferences(items) }), 'utf8');
}
export function assertEvidenceBudget(items: AssistantEvidenceBundle['items'], budget: number) {
  if (items.length > MAX_RAG_PASSAGES || evidenceTokenUpperBound(items) > budget)
    throw new RagError('RAG_EVIDENCE_INVALID');
}
