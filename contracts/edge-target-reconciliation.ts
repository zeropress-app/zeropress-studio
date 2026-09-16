import { z } from 'zod';
import { apiErrorSchema } from './api';

export const EDGE_TARGET_RECONCILIATION_CONFIRMATION =
  'RECONCILE EDGE TARGETS';
export const EDGE_TARGET_ORPHAN_PURGE_CONFIRMATION =
  'PURGE EDGE ORPHANS';
export const EDGE_TARGET_RECONCILIATION_CANCEL_CONFIRMATION =
  'CANCEL EDGE RECONCILIATION';

const operationIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const countSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const edgeTargetReconciliationStateSchema = z.enum([
  'not_required',
  'required',
  'in_progress',
  'orphan_review',
  'unavailable',
]);

export const edgeTargetReconciliationPhaseSchema = z.enum([
  'drain_outbox',
  'sync_posts',
  'sync_pages',
  'scan_orphans',
  'orphan_review',
]);

export const edgeTargetReconciliationStatusSchema = z.object({
  state: edgeTargetReconciliationStateSchema,
  operation_id: operationIdSchema.nullable(),
  phase: edgeTargetReconciliationPhaseSchema.nullable(),
  processed_posts: countSchema,
  processed_pages: countSchema,
  scanned_edge_targets: countSchema,
  orphan_targets: countSchema,
  orphan_comments: countSchema,
  available: z.boolean(),
}).strict();

const administratorCredentialsShape = {
  administrator_email: z.string().trim().toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
};

export const edgeTargetReconciliationStartRequestSchema = z.object({
  ...administratorCredentialsShape,
  backup_acknowledged: z.literal(true),
  public_edge_writes_disabled: z.literal(true),
  confirmation: z.literal(EDGE_TARGET_RECONCILIATION_CONFIRMATION),
}).strict();

export const edgeTargetReconciliationStepRequestSchema = z.object({
  operation_id: operationIdSchema,
}).strict();

export const edgeTargetReconciliationFinalizeRequestSchema =
  edgeTargetReconciliationStepRequestSchema;

export const edgeTargetReconciliationCancelRequestSchema = z.object({
  operation_id: operationIdSchema,
  confirmation: z.literal(EDGE_TARGET_RECONCILIATION_CANCEL_CONFIRMATION),
}).strict();

export const edgeTargetOrphanSchema = z.object({
  target_id: countSchema.refine((value) => value > 0),
  target_type: z.enum(['post', 'page']),
  target_public_id: countSchema.refine((value) => value > 0),
  status: z.enum(['draft', 'published', 'scheduled', 'trash', 'archived']),
  allow_comments: z.boolean(),
  comment_count: countSchema,
}).strict();

export const edgeTargetOrphanListRequestSchema = z.object({
  operation_id: operationIdSchema,
  cursor: countSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

export const edgeTargetOrphanListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(edgeTargetOrphanSchema),
    next_cursor: countSchema.nullable(),
  }).strict(),
}).strict();

export const edgeTargetOrphanPurgeRequestSchema = z.object({
  operation_id: operationIdSchema,
  target_ids: z.array(countSchema.refine((value) => value > 0))
    .min(1).max(100),
  confirmation: z.literal(EDGE_TARGET_ORPHAN_PURGE_CONFIRMATION),
}).strict();

export const edgeTargetOrphanPurgeResultSchema = z.object({
  target_id: countSchema.refine((value) => value > 0),
  result: z.enum(['deleted', 'not_found', 'no_longer_orphan', 'changed']),
  deleted_comments: countSchema,
}).strict();

export const edgeTargetReconciliationMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('reconcile_edge_comment_targets'),
    status: z.enum(['started', 'in_progress', 'orphan_review', 'completed', 'cancelled']),
    reconciliation: edgeTargetReconciliationStatusSchema,
    purge_results: z.array(edgeTargetOrphanPurgeResultSchema).optional(),
  }).strict(),
}).strict();

export const edgeTargetReconciliationMutationResponseSchema = z.union([
  edgeTargetReconciliationMutationSuccessSchema,
  apiErrorSchema,
]);

export type EdgeTargetReconciliationStatus = z.infer<
  typeof edgeTargetReconciliationStatusSchema
>;
export type EdgeTargetReconciliationStartRequest = z.infer<
  typeof edgeTargetReconciliationStartRequestSchema
>;
export type EdgeTargetReconciliationMutationResponse = z.infer<
  typeof edgeTargetReconciliationMutationResponseSchema
>;
export type EdgeTargetOrphan = z.infer<typeof edgeTargetOrphanSchema>;
