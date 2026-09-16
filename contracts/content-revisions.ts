import { z } from 'zod';
import { apiErrorSchema } from './api';
import { CONTENT_REVISION_RETENTION_LIMIT } from './content-snapshots';
import { settingsRevisionSchema } from './settings-revision';

export const contentRevisionIdSchema = settingsRevisionSchema;

export const contentRevisionSummarySchema = z.object({
  revision_id: contentRevisionIdSchema,
  saved_at_iso: z.iso.datetime({ offset: true }),
  current: z.boolean(),
  title: z.string().max(200),
  status: z.enum(['draft', 'published', 'trash']),
}).strict();

export const contentRevisionListSchema = z.object({
  current_revision: contentRevisionIdSchema,
  items: z.array(contentRevisionSummarySchema)
    .max(CONTENT_REVISION_RETENTION_LIMIT + 1),
}).strict().superRefine((value, context) => {
  const current = value.items.filter((item) => item.current);
  if (
    current.length !== 1
    || current[0]?.revision_id !== value.current_revision
    || value.items[0]?.revision_id !== value.current_revision
    || new Set(value.items.map((item) => item.revision_id)).size
      !== value.items.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Revision lists must contain one unique current revision first.',
    });
  }
});

export const restoreContentRevisionRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const contentRevisionErrorResponseSchema = apiErrorSchema;

export type ContentRevisionSummary = z.infer<
  typeof contentRevisionSummarySchema
>;
export type ContentRevisionList = z.infer<typeof contentRevisionListSchema>;
export type RestoreContentRevisionRequest = z.infer<
  typeof restoreContentRevisionRequestSchema
>;
