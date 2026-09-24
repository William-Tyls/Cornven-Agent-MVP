import { createHash } from 'node:crypto';

import {
  CitationSchema,
  DocumentSearchOutputSchema,
  type AgentToolErrorCode,
  type DocumentSearchOutput,
} from '@cornven/contracts';

export interface AssistantEvidenceItem {
  kind: 'untrusted_reference';
  citation: ReturnType<typeof CitationSchema.parse>;
  verbatimContent: string;
}

export interface AssistantEvidenceBundle {
  query: string;
  evidenceSufficient: boolean;
  items: AssistantEvidenceItem[];
}

export class RagEvidenceIntegrityError extends Error {
  readonly code: AgentToolErrorCode = 'TOOL_RESULT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RagEvidenceIntegrityError';
  }
}

function expectedChunkId(result: DocumentSearchOutput['results'][number]): string {
  return createHash('sha256')
    .update(`${result.documentId}\n${result.documentVersion}\n${result.locator}\n${result.content}`)
    .digest('hex');
}

export function buildAssistantEvidenceBundle(
  searchOutput: DocumentSearchOutput,
): AssistantEvidenceBundle {
  const parsed = DocumentSearchOutputSchema.parse(searchOutput);
  const items = parsed.results.map((result) => {
    if (result.chunkId !== expectedChunkId(result)) {
      throw new RagEvidenceIntegrityError(
        `RAG evidence integrity check failed for ${result.documentId}:${result.locator}.`,
      );
    }
    if (!result.content.includes(result.excerpt)) {
      throw new RagEvidenceIntegrityError(
        `RAG excerpt is not verbatim source text for ${result.documentId}:${result.locator}.`,
      );
    }

    return {
      kind: 'untrusted_reference' as const,
      citation: CitationSchema.parse({
        documentId: result.documentId,
        documentVersion: result.documentVersion,
        chunkId: result.chunkId,
        title: result.title,
        locator: result.locator,
        excerpt: result.excerpt,
      }),
      verbatimContent: result.content,
    };
  });

  return {
    query: parsed.query,
    evidenceSufficient: parsed.evidenceSufficient,
    items,
  };
}
