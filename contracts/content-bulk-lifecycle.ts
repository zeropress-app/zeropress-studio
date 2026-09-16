import { z } from 'zod';

export const CONTENT_BULK_LIFECYCLE_MAX_ITEMS = 10;

export const contentBulkLifecycleTargetStatusSchema = z.enum([
  'draft',
  'published',
  'trash',
]);

export const contentBulkLifecycleSummarySchema = z.object({
  requested: z.number().int().positive()
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  updated: z.number().int().nonnegative()
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  unchanged: z.number().int().nonnegative()
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  conflict: z.number().int().nonnegative()
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  skipped: z.number().int().nonnegative()
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (
    value.updated + value.unchanged + value.conflict + value.skipped
      !== value.requested
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Bulk lifecycle summary counts must equal requested items.',
    });
  }
});

export type ContentBulkLifecycleTargetStatus = z.infer<
  typeof contentBulkLifecycleTargetStatusSchema
>;
export type ContentBulkLifecycleSummary = z.infer<
  typeof contentBulkLifecycleSummarySchema
>;
