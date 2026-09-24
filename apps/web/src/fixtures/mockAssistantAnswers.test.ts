import { describe, expect, it } from 'vitest';
import { AssistantAnswerSchema } from '@cornven/contracts';
import { cannedQuestions } from './mockAssistantAnswers';

describe('demonstration answers against the latest Assistant contract', () => {
  it.each(cannedQuestions)('$id remains renderable after the M6 citation change', ({ answer }) => {
    expect(AssistantAnswerSchema.safeParse(answer).success).toBe(true);
  });
});
