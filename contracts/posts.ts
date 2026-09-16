import {
  CONTENT_SLUG_MAX_LENGTH,
  generateContentSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';
import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  authorIdSchema,
  publicAuthorIdentitySchema,
} from './author-identity';
import {
  contentPublicIdSchema,
  ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
} from './content-public-id';
import { settingsRevisionSchema } from './settings-revision';
import { mediaIdSchema, mediaReferenceSchema } from './media';
import { taxonomyTermIdSchema, taxonomySlugSchema } from './taxonomies';
import { contentDraftIdSchema } from './content-snapshots';
import {
  contentEditorModeSchema,
  contentEditorProfileSchema,
  validateContentEditorState,
} from './content-editor';
import { contentSearchMatchSchema } from './content-search';
import {
  CONTENT_BULK_LIFECYCLE_MAX_ITEMS,
  contentBulkLifecycleSummarySchema,
  contentBulkLifecycleTargetStatusSchema,
} from './content-bulk-lifecycle';
import { publicRouteUrlSchema } from './public-routing';

export { ZEROPRESS_NATIVE_PUBLIC_ID_BASE };
export const POST_TITLE_MAX_LENGTH = 200;
export const POST_CONTENT_MAX_LENGTH = 2_000_000;
export const POST_EXCERPT_MAX_LENGTH = 500;
export const POST_RELATION_MAX_ITEMS = 50;
export const POSTS_DEFAULT_PAGE_SIZE = 50;
export const POSTS_MAX_PAGE_SIZE = 100;
export const POST_EDITOR_OPTIONS_MAX_ITEMS = 100;

export const postIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const postPublicIdSchema = contentPublicIdSchema;
export const postStatusSchema = z.enum(['draft', 'published', 'trash']);
export const postDocumentTypeSchema = z.enum(['plaintext', 'markdown', 'html']);
export const postDiscoverabilitySchema = z.enum([
  'default',
  'noindex',
  'delist',
]);

export const postTitleInputSchema = z.string()
  .trim()
  .min(1)
  .max(POST_TITLE_MAX_LENGTH);

export const postTitleSchema = z.string()
  .min(1)
  .max(POST_TITLE_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const postSlugInputSchema = z.string()
  .max(CONTENT_SLUG_MAX_LENGTH * 2)
  .transform((value, context) => {
    const validation = validateSlugSegment(value);
    if (!validation.ok) {
      context.addIssue({
        code: 'custom',
        message: validation.issues[0].message,
      });
      return z.NEVER;
    }
    return validation.normalized;
  });

export const postSlugSchema = z.string()
  .max(CONTENT_SLUG_MAX_LENGTH * 2)
  .refine((value) => {
    const validation = validateSlugSegment(value);
    return validation.ok && validation.normalized === value;
  });

export const postContentSchema = z.string().max(POST_CONTENT_MAX_LENGTH);
export const postExcerptInputSchema = z.string()
  .trim()
  .max(POST_EXCERPT_MAX_LENGTH);
export const postExcerptSchema = z.string()
  .max(POST_EXCERPT_MAX_LENGTH)
  .refine((value) => value === value.trim());

function uniqueRelationIds<T extends z.ZodTypeAny>(item: T) {
  return z.array(item)
    .max(POST_RELATION_MAX_ITEMS)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: 'Relation IDs must be unique.',
        });
      }
    });
}

export const postCategoryIdsInputSchema = uniqueRelationIds(
  taxonomyTermIdSchema,
).transform((values) => [...values].sort());

export const postTagIdsInputSchema = uniqueRelationIds(taxonomyTermIdSchema);

export const postAuthorSchema = publicAuthorIdentitySchema;

export const postAccessSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z.object({
    scope: z.literal('own'),
    author: postAuthorSchema,
  }).strict(),
  z.object({
    scope: z.literal('unavailable'),
    reason: z.literal('author_not_linked'),
  }).strict(),
]);

export const postTaxonomyTermSchema = z.object({
  id: taxonomyTermIdSchema,
  name: z.string().min(1).max(200),
  slug: taxonomySlugSchema,
}).strict();

const postFieldsSchema = z.object({
  id: postIdSchema,
  public_id: postPublicIdSchema,
  title: postTitleSchema,
  slug: postSlugSchema,
  content: postContentSchema,
  document_type: postDocumentTypeSchema,
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: postExcerptSchema,
  status: postStatusSchema,
  author: postAuthorSchema,
  discoverability: postDiscoverabilitySchema,
  allow_comments: z.boolean(),
  featured_image: mediaReferenceSchema.nullable(),
  published_at_iso: z.iso.datetime({ offset: true }).nullable(),
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const postSchema = postFieldsSchema.extend({
  categories: z.array(postTaxonomyTermSchema).max(POST_RELATION_MAX_ITEMS),
  tags: z.array(postTaxonomyTermSchema).max(POST_RELATION_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  validateContentEditorState(value, context);
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({ code: 'custom', message: 'Post timestamps are invalid.' });
  }
  if (value.status === 'published' && value.published_at_iso === null) {
    context.addIssue({ code: 'custom', message: 'Published posts need a publication time.' });
  }
});

export const postSummarySchema = postFieldsSchema.omit({
  content: true,
  featured_image: true,
  editor_mode: true,
  editor_profile: true,
})
  .strict();

export const postListRecordSchema = postSummarySchema.extend({
  search_match: contentSearchMatchSchema.nullable(),
}).strict();

export const postListItemSchema = postListRecordSchema.extend({
  public_url: publicRouteUrlSchema,
}).strict();

export const postListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', 'draft', 'published', 'trash']).default('all'),
  author_id: authorIdSchema.optional(),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(POSTS_MAX_PAGE_SIZE)
    .default(POSTS_DEFAULT_PAGE_SIZE),
}).strict();

const postPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(POSTS_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

const postStatusCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  trash: z.number().int().nonnegative(),
}).strict();

export const postListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    access: postAccessSchema,
    items: z.array(postListItemSchema).max(POSTS_MAX_PAGE_SIZE),
    pagination: postPaginationSchema,
    status_counts: postStatusCountsSchema,
  }).strict(),
}).strict();

export const postListResponseSchema = z.union([
  postListSuccessSchema,
  apiErrorSchema,
]);

export const postDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: postSchema,
}).strict();

export const postDetailResponseSchema = z.union([
  postDetailSuccessSchema,
  apiErrorSchema,
]);

const authoredPostSchema = z.object({
  title: postTitleInputSchema,
  slug: postSlugInputSchema,
  content: postContentSchema,
  document_type: postDocumentTypeSchema,
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: postExcerptInputSchema,
  status: postStatusSchema,
  author_id: authorIdSchema,
  category_ids: postCategoryIdsInputSchema,
  tag_ids: postTagIdsInputSchema,
  discoverability: postDiscoverabilitySchema,
  allow_comments: z.boolean(),
  featured_image_id: mediaIdSchema.nullable(),
}).strict().superRefine(validateContentEditorState);

export const createPostRequestSchema = authoredPostSchema.extend({
  autosave_draft_id: contentDraftIdSchema.optional(),
}).strict();

export const updatePostRequestSchema = authoredPostSchema.extend({
  expected_revision: settingsRevisionSchema,
  autosave_draft_id: contentDraftIdSchema.optional(),
}).strict();

export const postMutationSuccessSchema = postDetailSuccessSchema;
export const postMutationResponseSchema = postDetailResponseSchema;

export const postNewsletterNotificationRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const postNewsletterNotificationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(['queued', 'no_subscribers', 'already_started']),
    post_id: postIdSchema,
    post_revision: settingsRevisionSchema,
    recipient_count: z.number().int().nonnegative(),
    newly_queued_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const postNewsletterNotificationResponseSchema = z.union([
  postNewsletterNotificationSuccessSchema,
  apiErrorSchema,
]);

export const deletePostRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const postDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('post_deleted'),
    id: postIdSchema,
  }).strict(),
}).strict();

export const postDeleteResponseSchema = z.union([
  postDeleteSuccessSchema,
  apiErrorSchema,
]);

export const postBulkLifecycleRequestSchema = z.object({
  target_status: contentBulkLifecycleTargetStatusSchema,
  items: z.array(z.object({
    id: postIdSchema,
    expected_revision: settingsRevisionSchema,
  }).strict()).min(1).max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'id'],
        message: 'Post IDs in a bulk lifecycle request must be unique.',
      });
    }
    seen.add(item.id);
  }
});

export const postBulkLifecycleResultSchema = z.union([
  z.object({
    id: postIdSchema,
    outcome: z.enum(['updated', 'unchanged']),
    status: postStatusSchema,
    revision: settingsRevisionSchema,
  }).strict(),
  z.object({
    id: postIdSchema,
    outcome: z.literal('conflict'),
  }).strict(),
  z.object({
    id: postIdSchema,
    outcome: z.literal('skipped'),
    reason: z.literal('not_found'),
  }).strict(),
]);

export const postBulkLifecycleDataSchema = z.object({
  target_status: contentBulkLifecycleTargetStatusSchema,
  results: z.array(postBulkLifecycleResultSchema)
    .min(1)
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  summary: contentBulkLifecycleSummarySchema,
}).strict().superRefine((value, context) => {
  if (value.results.length !== value.summary.requested) {
    context.addIssue({
      code: 'custom',
      message: 'Post bulk lifecycle results must match the requested count.',
    });
  }
  const counts = { updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  for (const result of value.results) counts[result.outcome] += 1;
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[key] !== value.summary[key]) {
      context.addIssue({
        code: 'custom',
        path: ['summary', key],
        message: 'Post bulk lifecycle summary does not match its results.',
      });
    }
  }
});

export const postBulkLifecycleSuccessSchema = z.object({
  success: z.literal(true),
  data: postBulkLifecycleDataSchema,
}).strict();

export const postBulkLifecycleResponseSchema = z.union([
  postBulkLifecycleSuccessSchema,
  apiErrorSchema,
]);

export const postEditorOptionKindSchema = z.enum([
  'author',
  'category',
  'tag',
]);

export const postEditorOptionsQuerySchema = z.object({
  kind: postEditorOptionKindSchema,
  search: z.string().trim().max(200).default(''),
}).strict();

export const postEditorOptionSchema = z.object({
  kind: postEditorOptionKindSchema,
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(200),
  slug: taxonomySlugSchema.nullable(),
}).strict();

export const postEditorOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    kind: postEditorOptionKindSchema,
    items: z.array(postEditorOptionSchema).max(POST_EDITOR_OPTIONS_MAX_ITEMS),
  }).strict(),
}).strict().superRefine((value, context) => {
  for (const [index, item] of value.data.items.entries()) {
    if (item.kind !== value.data.kind) {
      context.addIssue({
        code: 'custom',
        path: ['data', 'items', index, 'kind'],
        message: 'Editor option kind does not match the response kind.',
      });
    }
    if ((item.kind === 'author') !== (item.slug === null)) {
      context.addIssue({
        code: 'custom',
        path: ['data', 'items', index, 'slug'],
        message: 'Only Author options omit a slug.',
      });
    }
  }
});

export const postEditorOptionsResponseSchema = z.union([
  postEditorOptionsSuccessSchema,
  apiErrorSchema,
]);

export function suggestPostSlug(value: string): string {
  return generateContentSlug(value);
}

export type PostStatus = z.infer<typeof postStatusSchema>;
export type PostDocumentType = z.infer<typeof postDocumentTypeSchema>;
export type PostDiscoverability = z.infer<typeof postDiscoverabilitySchema>;
export type Post = z.infer<typeof postSchema>;
export type PostAccess = z.infer<typeof postAccessSchema>;
export type PostSummary = z.infer<typeof postSummarySchema>;
export type PostListRecord = z.infer<typeof postListRecordSchema>;
export type PostListItem = z.infer<typeof postListItemSchema>;
export type PostListQuery = z.infer<typeof postListQuerySchema>;
export type PostListResponse = z.infer<typeof postListResponseSchema>;
export type PostDetailResponse = z.infer<typeof postDetailResponseSchema>;
export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;
export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;
export type PostMutationResponse = z.infer<typeof postMutationResponseSchema>;
export type PostNewsletterNotificationRequest = z.infer<
  typeof postNewsletterNotificationRequestSchema
>;
export type PostNewsletterNotificationResponse = z.infer<
  typeof postNewsletterNotificationResponseSchema
>;
export type DeletePostRequest = z.infer<typeof deletePostRequestSchema>;
export type PostDeleteResponse = z.infer<typeof postDeleteResponseSchema>;
export type PostBulkLifecycleRequest = z.infer<
  typeof postBulkLifecycleRequestSchema
>;
export type PostBulkLifecycleResult = z.infer<
  typeof postBulkLifecycleResultSchema
>;
export type PostBulkLifecycleData = z.infer<
  typeof postBulkLifecycleDataSchema
>;
export type PostBulkLifecycleResponse = z.infer<
  typeof postBulkLifecycleResponseSchema
>;
export type PostEditorOptionKind = z.infer<
  typeof postEditorOptionKindSchema
>;
export type PostEditorOption = z.infer<typeof postEditorOptionSchema>;
export type PostEditorOptionsResponse = z.infer<
  typeof postEditorOptionsResponseSchema
>;
