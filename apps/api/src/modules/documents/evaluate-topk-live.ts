import type { AssistantModel, KnowledgeAnswer } from '../assistant/assistant-model.js';
import { AssistantService, type AssistantTools } from '../assistant/assistant.service.js';
import type { DocumentSearchOutput } from '@cornven/contracts';

export function topKLiveOptions(args: string[]) {
  const clean = args.filter((x) => x !== '--');
  if (clean.length !== 3 || !clean.includes('--allow-external'))
    throw new Error('Explicit --allow-external and --max-model-calls 80 required.');
  const index = clean.indexOf('--max-model-calls');
  if (index < 0 || clean[index + 1] !== '80')
    throw new Error('This frozen comparison requires an explicit maximum of 80 calls.');
  return { maximum: 80 };
}
/** Fix intent in all arms to isolate retrieval k, while retaining the production finalizer. */
export async function answerWithSelectedEvidence(
  question: string,
  evidence: DocumentSearchOutput,
  model: Pick<AssistantModel, 'answerKnowledge'>,
) {
  let raw: KnowledgeAnswer | undefined;
  const adapter: AssistantModel = {
    configured: true,
    classify: async () => ({
      intent: 'documents.search',
      slots: { artistQuery: null, settlementMonth: null, knowledgeQuery: question },
      clarification: null,
    }),
    answerKnowledge: async (...args) => {
      raw = await model.answerKnowledge(...args);
      return raw;
    },
  };
  const forbidden = async () => {
    throw new Error('No business data in SOP comparison');
  };
  const tools: AssistantTools = {
    resolveArtists: forbidden,
    searchSales: forbidden,
    preview: forbidden,
    getReport: forbidden,
    searchDocuments: async () => evidence,
  };
  const response = await new AssistantService(adapter).answer(
    { message: question },
    'topk-evaluation',
    tools,
  );
  return { raw, response };
}
