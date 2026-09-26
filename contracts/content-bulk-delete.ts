import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';
import {
  CONTENT_BULK_LIFECYCLE_MAX_ITEMS,
  contentBulkLifecycleSummarySchema,
} from './content-bulk-lifecycle';

const idSchema = z.string().regex(/^[a-f0-9]{32}$/u);

export const contentBulkDeleteRequestSchema = z.object({
  items: z.array(z.object({
    id: idSchema,
    expected_revision: settingsRevisionSchema,
  }).strict()).min(1).max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
}).strict().superRefine(({ items }, context) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Document IDs must be unique.' });
  }
});

export const contentBulkDeleteDataSchema = z.object({
  results: z.array(z.union([
    z.object({ id: idSchema, outcome: z.literal('deleted') }).strict(),
    z.object({ id: idSchema, outcome: z.literal('conflict') }).strict(),
    z.object({
      id: idSchema,
      outcome: z.literal('skipped'),
      reason: z.enum(['not_found', 'not_in_trash', 'front_page_protected', 'has_children']),
    }).strict(),
  ])).min(1).max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  summary: contentBulkLifecycleSummarySchema,
}).strict().superRefine(({ results, summary }, context) => {
  const counts = { requested: results.length, updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  for (const result of results) counts[result.outcome === 'deleted' ? 'updated' : result.outcome] += 1;
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[key] !== summary[key]) {
      context.addIssue({ code: 'custom', path: ['summary', key], message: 'Deletion counts must match results.' });
    }
  }
});
export const contentBulkDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: contentBulkDeleteDataSchema,
}).strict();
export const contentBulkDeleteResponseSchema = z.union([contentBulkDeleteSuccessSchema, apiErrorSchema]);
export type ContentBulkDeleteRequest = z.infer<typeof contentBulkDeleteRequestSchema>;
export type ContentBulkDeleteData = z.infer<typeof contentBulkDeleteDataSchema>;
export type ContentBulkDeleteResponse = z.infer<typeof contentBulkDeleteResponseSchema>;
