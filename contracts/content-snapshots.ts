import { z } from 'zod';

/**
 * Post and Page snapshots deliberately share one versioned envelope. Mutable
 * autosaves and immutable saved revisions use the same representation of
 * authored content.
 */
export const CONTENT_SNAPSHOT_VERSION = 2 as const;
export const LEGACY_CONTENT_SNAPSHOT_VERSION = 1 as const;
export const CONTENT_REVISION_RETENTION_LIMIT = 20;
export const CONTENT_AUTOSAVE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CONTENT_AUTOSAVE_DEBOUNCE_MS = 15_000;
export const CONTENT_AUTOSAVE_MIN_WRITE_INTERVAL_MS = 30_000;
export const CONTENT_AUTOSAVE_MAX_WAIT_MS = 60_000;

export const contentSnapshotVersionSchema = z.literal(
  CONTENT_SNAPSHOT_VERSION,
);
export const readableContentSnapshotVersionSchema = z.union([
  z.literal(LEGACY_CONTENT_SNAPSHOT_VERSION),
  contentSnapshotVersionSchema,
]);
export const contentDraftIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const contentSnapshotSha256Schema = z.string()
  .regex(/^[0-9a-f]{64}$/u);

export const contentAutosaveDeleteRequestSchema = z.object({
  draft_id: contentDraftIdSchema,
}).strict();

export const contentAutosaveDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('autosave_deleted'),
    deleted: z.boolean(),
  }).strict(),
}).strict();

export const contentAutosavePromotionRequestSchema = z.object({
  draft_id: contentDraftIdSchema,
}).strict();

export function createAutosaveLocatorQuerySchema<T extends z.ZodType>(
  targetIdSchema: T,
) {
  return z.object({
    draft_id: contentDraftIdSchema.optional(),
    target_id: targetIdSchema.optional(),
  }).strict().superRefine((value, context) => {
    if ((value.draft_id === undefined) === (value.target_id === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of draft_id or target_id.',
      });
    }
  });
}

export function validateAutosaveTargetPair(
  value: { target_id: unknown | null; base_revision: unknown | null },
  context: z.core.$RefinementCtx,
) {
  if ((value.target_id === null) !== (value.base_revision === null)) {
    context.addIssue({
      code: 'custom',
      path: ['base_revision'],
      message: 'Target ID and base revision must both be present or both be null.',
    });
  }
}

export function validateAutosaveDocumentRetention(
  value: {
    target_id: unknown | null;
    base_revision: unknown | null;
    expires_at_iso: unknown | null;
  },
  context: z.core.$RefinementCtx,
) {
  validateAutosaveTargetPair(value, context);
  if ((value.target_id === null) !== (value.expires_at_iso !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['expires_at_iso'],
      message: 'Only an unbound autosave has an expiry.',
    });
  }
}

export type ContentAutosaveDeleteRequest = z.infer<
  typeof contentAutosaveDeleteRequestSchema
>;
export type ContentAutosavePromotionRequest = z.infer<
  typeof contentAutosavePromotionRequestSchema
>;
