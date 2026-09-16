import { z } from 'zod';
import { apiErrorSchema } from './api';

export const CONTENT_SEARCH_REBUILD_CONFIRMATION =
  'REBUILD CONTENT SEARCH';

const countSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const operationIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const contentSearchIndexStateSchema = z.enum([
  'ready',
  'rebuild_required',
  'in_progress',
  'recovery_required',
  'unavailable',
]);

export const contentSearchIndexPhaseSchema = z.enum([
  'posts',
  'pages',
  'verify',
]);

export const contentSearchIndexReasonSchema = z.enum([
  'schema_upgrade',
  'database_restore',
  'manual_rebuild',
  'integrity_failure',
]);

export const contentSearchIndexStatusSchema = z.object({
  state: contentSearchIndexStateSchema,
  reason: contentSearchIndexReasonSchema.nullable(),
  phase: contentSearchIndexPhaseSchema.nullable(),
  operation_id: operationIdSchema.nullable(),
  post_public_id_cursor: countSchema,
  page_public_id_cursor: countSchema,
  processed_posts: countSchema,
  processed_pages: countSchema,
  total_posts: countSchema,
  total_pages: countSchema,
  available: z.boolean(),
}).strict();

const administratorCredentialsShape = {
  administrator_email: z.string().trim().toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
};

export const contentSearchIndexRebuildStartRequestSchema = z.object({
  ...administratorCredentialsShape,
  confirmation: z.literal(CONTENT_SEARCH_REBUILD_CONFIRMATION),
}).strict();

export const contentSearchIndexRebuildStepRequestSchema = z.object({
  operation_id: operationIdSchema,
  expected_phase: contentSearchIndexPhaseSchema,
  expected_post_public_id_cursor: countSchema,
  expected_page_public_id_cursor: countSchema,
}).strict();

export const contentSearchIndexRebuildMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('rebuild_content_search_index'),
    status: z.enum(['started', 'in_progress', 'completed']),
    content_search_index: contentSearchIndexStatusSchema,
  }).strict(),
}).strict();

export const contentSearchIndexRebuildMutationResponseSchema = z.union([
  contentSearchIndexRebuildMutationSuccessSchema,
  apiErrorSchema,
]);

export type ContentSearchIndexStatus = z.infer<
  typeof contentSearchIndexStatusSchema
>;
export type ContentSearchIndexRebuildStepRequest = z.infer<
  typeof contentSearchIndexRebuildStepRequestSchema
>;
export type ContentSearchIndexRebuildMutationResponse = z.infer<
  typeof contentSearchIndexRebuildMutationResponseSchema
>;
