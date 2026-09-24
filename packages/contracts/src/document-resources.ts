import { z } from 'zod';
export const ResourceActionSchema = z
  .object({
    kind: z.enum(['visit', 'view', 'download']),
    label: z.string().min(1),
    url: z
      .string()
      .refine(
        (url) =>
          /^https:\/\//.test(url) ||
          /^\/api\/v1\/documents\/assets\/asset-[a-f0-9]{24}\?action=(view|download)$/.test(url),
      ),
  })
  .strict();
export const DocumentResourceSchema = z
  .object({
    resourceId: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['web', 'pdf', 'image']),
    citationChunkIds: z.array(z.string()).min(1),
    contentIndexed: z.boolean(),
    availability: z.enum(['external', 'local', 'missing']),
    actions: z.array(ResourceActionSchema).max(3),
  })
  .strict();
export type DocumentResource = z.infer<typeof DocumentResourceSchema>;
