import { z } from 'zod';
import { apiErrorSchema } from './api';

export const COMMENTS_DEFAULT_PAGE_SIZE = 50;
export const COMMENTS_MAX_PAGE_SIZE = 100;
export const COMMENT_AUTHOR_NAME_MAX_LENGTH = 100;
export const COMMENT_AUTHOR_EMAIL_MAX_LENGTH = 320;
export const COMMENT_CONTENT_MAX_LENGTH = 5_000;
export const COMMENT_TARGET_OPTIONS_MAX_ITEMS = 100;
export const COMMENT_BULK_MODERATION_MAX_ITEMS = COMMENTS_DEFAULT_PAGE_SIZE;

const COMMENT_CONTROL_CHARS_EXCEPT_LF_AND_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Match Edge's multiline free-text policy without depending on its checkout.
export function normalizeCommentContent(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(COMMENT_CONTROL_CHARS_EXCEPT_LF_AND_TAB, '')
    .replace(/\t+/g, ' ')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n[^\S\n]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Zod string limits count code points; Edge and textarea limits use UTF-16.
const commentContentSchema = z.string().min(1).refine(
  (value) => value.length <= COMMENT_CONTENT_MAX_LENGTH,
  { message: `Comment content must be ${COMMENT_CONTENT_MAX_LENGTH} UTF-16 code units or fewer.` },
);
const commentContentInputSchema = z.string()
  .transform(normalizeCommentContent)
  .pipe(commentContentSchema);

export const commentIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const commentTargetTypeSchema = z.enum(['post', 'page']);
export const commentStatusSchema = z.enum([
  'pending',
  'approved',
  'spam',
  'trash',
]);
export const commentAuthorKindSchema = z.enum([
  'guest',
  'authenticated_user',
  'site_user',
]);

const commentPublicIdSchema = z.number().int().positive().safe();
const commentTimestampSchema = z.iso.datetime({ offset: true });
export const commentAuthorEmailSchema = z.union([
  z.literal(''),
  z.string().email().max(COMMENT_AUTHOR_EMAIL_MAX_LENGTH),
]);

export const commentTargetSchema = z.object({
  type: commentTargetTypeSchema,
  id: z.string().regex(/^[0-9a-f]{32}$/u),
  public_id: commentPublicIdSchema,
  title: z.string().min(1).max(200),
  slug: z.string().min(1).max(400),
}).strict();

export const commentReplyStateSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      'not_approved',
      'threading_disabled',
      'depth_limit',
      'invalid_thread',
      'target_unavailable',
    ]),
  }).strict(),
]);

export const managedCommentSchema = z.object({
  id: commentIdSchema,
  public_id: commentPublicIdSchema,
  target_type: commentTargetTypeSchema,
  target_public_id: commentPublicIdSchema,
  target: commentTargetSchema.nullable(),
  parent_public_id: commentPublicIdSchema.nullable(),
  reply: commentReplyStateSchema,
  author: z.object({
    name: z.string().min(1).max(COMMENT_AUTHOR_NAME_MAX_LENGTH),
    email: commentAuthorEmailSchema,
    kind: commentAuthorKindSchema,
  }).strict(),
  content_text: commentContentSchema,
  status: commentStatusSchema,
  ip_address: z.string().min(1).max(45).nullable(),
  user_agent: z.string().min(1).max(250).nullable(),
  created_at_iso: commentTimestampSchema,
  updated_at_iso: commentTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.target && (
    value.target.type !== value.target_type
    || value.target.public_id !== value.target_public_id
  )) {
    context.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'Comment target metadata does not match its Edge identity.',
    });
  }
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({
      code: 'custom',
      path: ['updated_at_iso'],
      message: 'Comment timestamps are invalid.',
    });
  }
});

export const commentListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', ...commentStatusSchema.options]).default('all'),
  target_type: z.enum(['all', ...commentTargetTypeSchema.options])
    .default('all'),
  target_public_id: z.coerce.number().int().positive().safe().optional(),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(COMMENTS_MAX_PAGE_SIZE)
    .default(COMMENTS_DEFAULT_PAGE_SIZE),
}).strict().superRefine((value, context) => {
  if (
    value.target_public_id !== undefined
    && value.target_type === 'all'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['target_type'],
      message: 'A target type is required with a target public ID.',
    });
  }
});

const commentPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(COMMENTS_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

export const commentStatusCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  spam: z.number().int().nonnegative(),
  trash: z.number().int().nonnegative(),
}).strict();

export const commentListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(managedCommentSchema).max(COMMENTS_MAX_PAGE_SIZE),
    pagination: commentPaginationSchema,
    status_counts: commentStatusCountsSchema,
  }).strict(),
}).strict();

export const commentListResponseSchema = z.union([
  commentListSuccessSchema,
  apiErrorSchema,
]);

export const commentTargetOptionsQuerySchema = z.object({
  target_type: commentTargetTypeSchema,
  search: z.string().trim().max(200).default(''),
}).strict();

export const commentTargetOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(commentTargetSchema).max(COMMENT_TARGET_OPTIONS_MAX_ITEMS),
  }).strict(),
}).strict();

export const commentTargetOptionsResponseSchema = z.union([
  commentTargetOptionsSuccessSchema,
  apiErrorSchema,
]);

export const createStudioCommentRequestSchema = z.object({
  target_type: commentTargetTypeSchema,
  target_public_id: commentPublicIdSchema,
  parent_public_id: commentPublicIdSchema.nullable(),
  content_text: commentContentInputSchema,
}).strict();

export const updateCommentRequestSchema = z.object({
  content_text: commentContentInputSchema.optional(),
  status: commentStatusSchema.optional(),
  expected_updated_at_iso: commentTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.content_text === undefined && value.status === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'At least one comment field must be changed.',
    });
  }
});

export const commentMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: managedCommentSchema,
}).strict();

export const commentMutationResponseSchema = z.union([
  commentMutationSuccessSchema,
  apiErrorSchema,
]);

export const deleteCommentRequestSchema = z.object({
  expected_updated_at_iso: commentTimestampSchema,
}).strict();

export const commentDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('moved_to_trash'),
      comment: managedCommentSchema,
    }).strict(),
    z.object({
      status: z.literal('permanently_deleted'),
      deleted_count: z.number().int().positive(),
    }).strict(),
  ]),
}).strict();

export const commentDeleteResponseSchema = z.union([
  commentDeleteSuccessSchema,
  apiErrorSchema,
]);

const commentBulkModerationItemSchema = z.object({
  id: commentIdSchema,
  expected_updated_at_iso: commentTimestampSchema,
}).strict();

const commentBulkModerationItemsSchema = z.array(
  commentBulkModerationItemSchema,
).min(1).max(COMMENT_BULK_MODERATION_MAX_ITEMS).superRefine(
  (items, context) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Comment IDs in a bulk moderation request must be unique.',
        });
      }
      seen.add(item.id);
    }
  },
);

export const commentBulkModerationRequestSchema = z.discriminatedUnion(
  'operation',
  [
    z.object({
      operation: z.literal('set_status'),
      status: commentStatusSchema,
      items: commentBulkModerationItemsSchema,
    }).strict(),
    z.object({
      operation: z.literal('delete_permanently'),
      items: commentBulkModerationItemsSchema,
    }).strict(),
  ],
);

export const commentBulkModerationResultSchema = z.union([
  z.object({
    id: commentIdSchema,
    outcome: z.enum(['updated', 'unchanged']),
    status: commentStatusSchema,
    updated_at_iso: commentTimestampSchema,
  }).strict(),
  z.object({
    id: commentIdSchema,
    outcome: z.literal('updated'),
    deleted_count: z.number().int().positive(),
  }).strict(),
  z.object({
    id: commentIdSchema,
    outcome: z.literal('conflict'),
  }).strict(),
  z.object({
    id: commentIdSchema,
    outcome: z.literal('skipped'),
    reason: z.enum(['not_found', 'not_in_trash']),
  }).strict(),
]);

export const commentBulkModerationSummarySchema = z.object({
  requested: z.number().int().positive()
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  updated: z.number().int().nonnegative()
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  unchanged: z.number().int().nonnegative()
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  conflict: z.number().int().nonnegative()
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  skipped: z.number().int().nonnegative()
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  deleted_comments: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (
    value.updated + value.unchanged + value.conflict + value.skipped
      !== value.requested
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Bulk moderation summary counts must equal requested items.',
    });
  }
});

const commentBulkModerationDataBase = {
  results: z.array(commentBulkModerationResultSchema)
    .min(1)
    .max(COMMENT_BULK_MODERATION_MAX_ITEMS),
  summary: commentBulkModerationSummarySchema,
};

export const commentBulkModerationDataSchema = z.discriminatedUnion(
  'operation',
  [
    z.object({
      operation: z.literal('set_status'),
      status: commentStatusSchema,
      ...commentBulkModerationDataBase,
    }).strict(),
    z.object({
      operation: z.literal('delete_permanently'),
      ...commentBulkModerationDataBase,
    }).strict(),
  ],
).superRefine((value, context) => {
  if (value.results.length !== value.summary.requested) {
    context.addIssue({
      code: 'custom',
      message: 'Bulk moderation results must match the requested count.',
    });
  }
  const counts = { updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  let deletedComments = 0;
  for (const result of value.results) {
    counts[result.outcome] += 1;
    if ('deleted_count' in result) deletedComments += result.deleted_count;
  }
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[key] !== value.summary[key]) {
      context.addIssue({
        code: 'custom',
        path: ['summary', key],
        message: 'Bulk moderation summary does not match its results.',
      });
    }
  }
  if (deletedComments !== value.summary.deleted_comments) {
    context.addIssue({
      code: 'custom',
      path: ['summary', 'deleted_comments'],
      message: 'Deleted comment count does not match bulk results.',
    });
  }
  if (
    value.operation === 'set_status'
    && value.results.some((result) => (
      'deleted_count' in result
      || (
        result.outcome === 'skipped'
        && result.reason === 'not_in_trash'
      )
    ))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['results'],
      message: 'Status moderation cannot contain deletion results.',
    });
  }
  if (
    value.operation === 'delete_permanently'
    && value.results.some((result) => (
      result.outcome === 'unchanged'
      || ('status' in result && result.outcome === 'updated')
    ))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['results'],
      message: 'Permanent deletion contains an invalid status result.',
    });
  }
});

export const commentBulkModerationSuccessSchema = z.object({
  success: z.literal(true),
  data: commentBulkModerationDataSchema,
}).strict();

export const commentBulkModerationResponseSchema = z.union([
  commentBulkModerationSuccessSchema,
  apiErrorSchema,
]);

export type CommentTargetType = z.infer<typeof commentTargetTypeSchema>;
export type CommentStatus = z.infer<typeof commentStatusSchema>;
export type CommentTarget = z.infer<typeof commentTargetSchema>;
export type CommentReplyState = z.infer<typeof commentReplyStateSchema>;
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;
export type ManagedComment = z.infer<typeof managedCommentSchema>;
export type CommentListResponse = z.infer<typeof commentListResponseSchema>;
export type CommentTargetOptionsQuery = z.infer<
  typeof commentTargetOptionsQuerySchema
>;
export type CommentTargetOptionsResponse = z.infer<
  typeof commentTargetOptionsResponseSchema
>;
export type CreateStudioCommentRequest = z.infer<
  typeof createStudioCommentRequestSchema
>;
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;
export type CommentMutationResponse = z.infer<
  typeof commentMutationResponseSchema
>;
export type DeleteCommentRequest = z.infer<typeof deleteCommentRequestSchema>;
export type CommentDeleteResponse = z.infer<typeof commentDeleteResponseSchema>;
export type CommentBulkModerationRequest = z.infer<
  typeof commentBulkModerationRequestSchema
>;
export type CommentBulkModerationResult = z.infer<
  typeof commentBulkModerationResultSchema
>;
export type CommentBulkModerationData = z.infer<
  typeof commentBulkModerationDataSchema
>;
export type CommentBulkModerationResponse = z.infer<
  typeof commentBulkModerationResponseSchema
>;
