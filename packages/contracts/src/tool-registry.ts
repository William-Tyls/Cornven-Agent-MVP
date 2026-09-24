import { z } from 'zod';

import rawAgentToolDefinitions from './tool-schemas/tools.json' with { type: 'json' };

import { AgentToolNameSchema } from './assistant.js';

const JsonObjectSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()).default([]),
  properties: z.record(z.unknown()),
  additionalProperties: z.boolean().optional(),
});

export const AgentToolDefinitionSchema = z.object({
  name: AgentToolNameSchema,
  description: z.string().trim().min(1),
  readOnly: z.literal(true),
  owner: z.string().trim().min(1),
  input: JsonObjectSchema,
  output: JsonObjectSchema,
});

export const AgentToolDefinitionsSchema = z.array(AgentToolDefinitionSchema);

export const agentToolDefinitions = AgentToolDefinitionsSchema.parse(rawAgentToolDefinitions);

export type AgentToolDefinition = z.infer<typeof AgentToolDefinitionSchema>;
