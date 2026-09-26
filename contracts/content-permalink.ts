import { z } from 'zod';
import { apiErrorSchema } from './api';

export const contentPermalinkSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{32}$/),
  status: z.enum(['draft', 'published', 'trash']),
  url: z.url({ protocol: /^https?$/ }).nullable(),
});
export const contentPermalinkSuccessSchema = z.object({
  success: z.literal(true), data: contentPermalinkSchema,
});
export const contentPermalinkResponseSchema = z.discriminatedUnion('success', [
  contentPermalinkSuccessSchema, apiErrorSchema,
]);
export type ContentPermalink = z.infer<typeof contentPermalinkSchema>;
