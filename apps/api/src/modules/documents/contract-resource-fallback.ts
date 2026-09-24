import type { AssistantAnswer } from '@cornven/contracts';
import type { AssistantEvidenceBundle } from './assistant-evidence.js';
import { enrichDocumentCitations } from './document-resources.js';

const contractTopic = /合同|合[約约]|\bcontracts?\b|\bagreements?\b/iu;
/** File metadata is useful even when it cannot substantiate the requested clauses.
 * Uses only this turn's validated evidence, never a catalogue-wide resource lookup.
 */
export async function contractResourceFallback(
  question: string,
  evidence: AssistantEvidenceBundle,
): Promise<AssistantAnswer['resourceFallback']> {
  if (!contractTopic.test(question.normalize('NFKC'))) return undefined;
  const verified = await enrichDocumentCitations(evidence.items.map((i) => i.citation));
  const resources = verified.resources.filter(
    (r) =>
      r.kind === 'pdf' &&
      !r.contentIndexed &&
      r.availability !== 'missing' &&
      r.actions.some((a) => a.kind === 'download') &&
      contractTopic.test(r.label.replaceAll('_', ' ')),
  );
  if (!resources.length) return undefined;
  const cited = new Set(resources.flatMap((r) => r.citationChunkIds));
  return { resources, citations: verified.citations.filter((c) => cited.has(c.chunkId)) };
}
export function contractFallbackMessage(question: string) {
  return /[\p{Script=Han}]/u.test(question)
    ? '已找到相关合同 PDF，可在下方查看或下载。合同正文尚未纳入问答资料，当前检索内容不足以说明合同条款。请打开文件查看；如果你想了解签署或提交合同的操作流程，请说明具体环节。'
    : 'Related contract PDFs are available below to view or download. Their contents have not been indexed, so the retrieved evidence cannot explain the contract clauses. Please open the files to review them, or specify which signing or submission step you need help with.';
}
