import type { AssistantAnswer } from '@cornven/contracts';

/** Hand-written UI examples only. Citation fields follow the latest main contract.
 * No document retrieval or Assistant execution takes place for these buttons.
 */
export interface CannedQuestion {
  id: string;
  label: string;
  message: string;
  answer: AssistantAnswer;
}

export const cannedQuestions: CannedQuestion[] = [
  {
    id: 'refund-sop',
    label: 'How do I process a refund?',
    message: 'How do I process a refund?',
    answer: {
      requestId: 'REQ-DEMO-001',
      answer:
        'Keep the original sale record and log the approved refund as an independent, linked adjustment — do not edit the original sale.',
      citations: [
        {
          documentId: 'DOC-SOP-001',
          documentVersion: 'VERSION-003',
          chunkId: 'CHUNK-REFUNDS-002',
          title: 'Sample Refund Procedure',
          locator: 'Section 2',
          excerpt: 'Sample only: record an approved refund as a linked adjustment.',
        },
      ],
      toolCalls: [
        {
          requestId: 'REQ-DEMO-001',
          tool: 'documents.search',
          execution: {
            status: 'succeeded',
            argumentsSummary: 'Approved SOP search; query text redacted',
            resultSummary: '1 approved SOP result',
            durationMs: 14,
          },
        },
      ],
      outcome: 'answered',
    },
  },
  {
    id: 'sales-lookup',
    label: "What were ART-001's sales this month?",
    message: "What were ART-001's sales this month?",
    answer: {
      requestId: 'REQ-DEMO-002',
      answer:
        'ART-001 has one recorded sale of 4 units of Sample Ceramic Cup this month, with one matching refund.',
      citations: [],
      toolCalls: [
        {
          requestId: 'REQ-DEMO-002',
          tool: 'sales.search',
          execution: {
            status: 'succeeded',
            argumentsSummary: 'artistId=ART-001',
            resultSummary: '2 canonical record(s) found',
            durationMs: 9,
          },
        },
      ],
      outcome: 'answered',
    },
  },
  {
    id: 'approval-refused',
    label: 'Can you approve this settlement for me?',
    message: 'Can you approve this settlement for me?',
    answer: {
      requestId: 'REQ-DEMO-003',
      answer:
        'I cannot approve or reject a settlement. Approval requires a human decision on the Approvals page.',
      citations: [],
      toolCalls: [],
      outcome: 'refused',
    },
  },
  {
    id: 'no-sop-match',
    label: 'What is the office WiFi password?',
    message: 'What is the office WiFi password?',
    answer: {
      requestId: 'REQ-DEMO-004',
      answer: "I don't have enough approved documentation to answer that with confidence.",
      citations: [],
      toolCalls: [
        {
          requestId: 'REQ-DEMO-004',
          tool: 'documents.search',
          execution: {
            status: 'succeeded',
            argumentsSummary: 'Approved SOP search; query text redacted',
            resultSummary: '0 approved SOP results',
            durationMs: 11,
          },
        },
      ],
      outcome: 'insufficient_evidence',
    },
  },
  {
    id: 'tool-error',
    label: "Look up an artist that doesn't exist",
    message: 'Look up artist ART-999.',
    answer: {
      requestId: 'REQ-DEMO-005',
      answer: 'I ran into a problem looking that up and cannot answer right now.',
      citations: [],
      toolCalls: [
        {
          requestId: 'REQ-DEMO-005',
          tool: 'artist.get',
          execution: {
            status: 'failed',
            argumentsSummary: 'artistId=ART-999',
            errorCode: 'TOOL_RESULT_INVALID',
            durationMs: 6,
          },
        },
      ],
      outcome: 'tool_error',
    },
  },
];
