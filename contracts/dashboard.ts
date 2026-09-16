import { z } from 'zod';
import { apiErrorSchema } from './api';
import { postAccessSchema } from './posts';

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime({ offset: true });

const contentStatusCountsSchema = z.object({
  total: countSchema,
  draft: countSchema,
  published: countSchema,
  trash: countSchema,
}).strict().superRefine((value, context) => {
  if (value.total !== value.draft + value.published + value.trash) {
    context.addIssue({
      code: 'custom',
      path: ['total'],
      message: 'Content status counts must add up to the total.',
    });
  }
});

const dashboardPostOverviewSchema = contentStatusCountsSchema.extend({
  access: postAccessSchema,
}).strict();

const mediaCountsSchema = z.object({
  total: countSchema,
  managed: countSchema,
  external: countSchema,
}).strict().superRefine((value, context) => {
  if (value.total !== value.managed + value.external) {
    context.addIssue({
      code: 'custom',
      path: ['total'],
      message: 'Media storage counts must add up to the total.',
    });
  }
});

export const dashboardContentSchema = z.object({
  posts: dashboardPostOverviewSchema.nullable(),
  pages: contentStatusCountsSchema.nullable(),
  media: mediaCountsSchema.nullable(),
}).strict();

const commentOverviewSchema = z.object({
  pending: countSchema,
  enabled: z.boolean(),
  api_configured: z.boolean(),
}).strict();

const formOverviewSchema = z.object({
  unread_submissions: countSchema,
}).strict();

const newsletterOverviewSchema = z.object({
  pending_confirmations: countSchema,
  confirmation_enabled: z.boolean(),
  confirmation_ready: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.confirmation_ready && !value.confirmation_enabled) {
    context.addIssue({
      code: 'custom',
      path: ['confirmation_ready'],
      message: 'Newsletter confirmation cannot be ready while disabled.',
    });
  }
});

const dashboardEdgeOverviewShape = {
  comments: commentOverviewSchema.nullable(),
  forms: formOverviewSchema.nullable(),
  newsletters: newsletterOverviewSchema.nullable(),
};

export const dashboardEdgeAvailableSchema = z.object({
  status: z.literal('available'),
  pending_target_events: countSchema,
  ...dashboardEdgeOverviewShape,
}).strict();

export const dashboardEdgeReconciliationRequiredSchema = z.object({
  status: z.literal('reconciliation_required'),
  pending_target_events: z.literal(0),
  ...dashboardEdgeOverviewShape,
}).strict();

export const dashboardEdgeSchema = z.discriminatedUnion('status', [
  dashboardEdgeAvailableSchema,
  dashboardEdgeReconciliationRequiredSchema,
  z.object({
    status: z.literal('disabled'),
    pending_target_events: countSchema,
  }).strict(),
  z.object({
    status: z.literal('projection_pending'),
    pending_target_events: countSchema.refine((value) => value > 0),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    pending_target_events: countSchema,
  }).strict(),
  z.object({ status: z.literal('not_requested') }).strict(),
]);

export const dashboardSummarySchema = z.object({
  generated_at_iso: timestampSchema,
  content: dashboardContentSchema,
  mail: z.object({ configured: z.boolean() }).strict().nullable(),
  edge: dashboardEdgeSchema,
  content_search_index: z.object({
    state: z.enum([
      'ready',
      'rebuild_required',
      'in_progress',
      'recovery_required',
      'unavailable',
    ]),
  }).strict().nullable(),
}).strict();

export const dashboardSummarySuccessSchema = z.object({
  success: z.literal(true),
  data: dashboardSummarySchema,
}).strict();

export const dashboardSummaryResponseSchema = z.union([
  dashboardSummarySuccessSchema,
  apiErrorSchema,
]);

export type DashboardContent = z.infer<typeof dashboardContentSchema>;
export type DashboardEdgeAvailable = z.infer<
  typeof dashboardEdgeAvailableSchema
>;
export type DashboardEdgeReconciliationRequired = z.infer<
  typeof dashboardEdgeReconciliationRequiredSchema
>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
