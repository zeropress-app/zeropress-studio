import {
  CONTENT_SLUG_MAX_LENGTH,
  generateContentSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';
import { z } from 'zod';
import { apiErrorSchema } from './api';
import { contentPublicIdSchema } from './content-public-id';
import { settingsRevisionSchema } from './settings-revision';
import { mediaIdSchema, mediaReferenceSchema } from './media';
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

export const PAGE_TITLE_MAX_LENGTH = 200;
export const PAGE_CONTENT_MAX_LENGTH = 2_000_000;
export const PAGE_EXCERPT_MAX_LENGTH = 500;
export const PAGES_DEFAULT_PAGE_SIZE = 50;
export const PAGES_MAX_PAGE_SIZE = 100;
export const PAGE_PARENT_OPTIONS_MAX_ITEMS = 100;

export const pageIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const pagePublicIdSchema = contentPublicIdSchema;
export const pageStatusSchema = z.enum(['draft', 'published', 'trash']);
export const pageDocumentTypeSchema = z.enum(['plaintext', 'markdown', 'html']);
export const pageDiscoverabilitySchema = z.enum([
  'default',
  'noindex',
  'delist',
]);

export const pageTitleInputSchema = z.string()
  .trim()
  .min(1)
  .max(PAGE_TITLE_MAX_LENGTH);

export const pageTitleSchema = z.string()
  .min(1)
  .max(PAGE_TITLE_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const pageSlugInputSchema = z.string()
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

export const pageSlugSchema = z.string()
  .max(CONTENT_SLUG_MAX_LENGTH * 2)
  .refine((value) => {
    const validation = validateSlugSegment(value);
    return validation.ok && validation.normalized === value;
  });

export const pageEffectivePathSchema = z.string().min(1).superRefine(
  (value, context) => {
    if (value.startsWith('/') || value.endsWith('/')) {
      context.addIssue({ code: 'custom', message: 'Page paths omit boundary slashes.' });
      return;
    }
    const segments = value.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      context.addIssue({ code: 'custom', message: 'Page paths cannot contain empty segments.' });
      return;
    }
    for (const segment of segments) {
      const validation = validateSlugSegment(segment);
      if (!validation.ok || validation.normalized !== segment) {
        context.addIssue({ code: 'custom', message: 'Page paths contain an invalid segment.' });
        return;
      }
    }
  },
);

export const pageContentSchema = z.string().max(PAGE_CONTENT_MAX_LENGTH);
export const pageExcerptInputSchema = z.string()
  .trim()
  .max(PAGE_EXCERPT_MAX_LENGTH);
export const pageExcerptSchema = z.string()
  .max(PAGE_EXCERPT_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const pageParentSchema = z.object({
  id: pageIdSchema,
  title: pageTitleSchema,
  slug: pageSlugSchema,
}).strict();

const pageFieldsSchema = z.object({
  id: pageIdSchema,
  public_id: pagePublicIdSchema,
  parent: pageParentSchema.nullable(),
  title: pageTitleSchema,
  slug: pageSlugSchema,
  path: pageEffectivePathSchema,
  document_type: pageDocumentTypeSchema,
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: pageExcerptSchema,
  status: pageStatusSchema,
  discoverability: pageDiscoverabilitySchema,
  allow_comments: z.boolean(),
  featured_image: mediaReferenceSchema.nullable(),
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const pageSchema = pageFieldsSchema.extend({
  content: pageContentSchema,
}).strict().superRefine((value, context) => {
  validateContentEditorState(value, context);
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({ code: 'custom', message: 'Page timestamps are invalid.' });
  }
  if (value.path.split('/').at(-1) !== value.slug) {
    context.addIssue({ code: 'custom', message: 'Page path must end with its slug.' });
  }
});

export const pageSummarySchema = pageFieldsSchema.omit({
  featured_image: true,
  editor_mode: true,
  editor_profile: true,
}).strict();

export const pageListRecordSchema = pageSummarySchema.extend({
  search_match: contentSearchMatchSchema.nullable(),
}).strict();

export const pageListItemSchema = pageListRecordSchema.extend({
  public_url: publicRouteUrlSchema,
}).strict();

export const pageListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  status: z.enum(['all', 'draft', 'published', 'trash']).default('all'),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(PAGES_MAX_PAGE_SIZE)
    .default(PAGES_DEFAULT_PAGE_SIZE),
}).strict();

const pagePaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(PAGES_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

const pageStatusCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  trash: z.number().int().nonnegative(),
}).strict();

export const pageListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(pageListItemSchema).max(PAGES_MAX_PAGE_SIZE),
    pagination: pagePaginationSchema,
    status_counts: pageStatusCountsSchema,
  }).strict(),
}).strict();

export const pageListResponseSchema = z.union([
  pageListSuccessSchema,
  apiErrorSchema,
]);

export const pageDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: pageSchema,
}).strict();

export const pageDetailResponseSchema = z.union([
  pageDetailSuccessSchema,
  apiErrorSchema,
]);

const authoredPageSchema = z.object({
  parent_id: pageIdSchema.nullable(),
  title: pageTitleInputSchema,
  slug: pageSlugInputSchema,
  content: pageContentSchema,
  document_type: pageDocumentTypeSchema,
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: pageExcerptInputSchema,
  status: pageStatusSchema,
  discoverability: pageDiscoverabilitySchema,
  allow_comments: z.boolean(),
  featured_image_id: mediaIdSchema.nullable(),
}).strict().superRefine(validateContentEditorState);

export const createPageRequestSchema = authoredPageSchema.extend({
  autosave_draft_id: contentDraftIdSchema.optional(),
}).strict();

export const updatePageRequestSchema = authoredPageSchema.extend({
  expected_revision: settingsRevisionSchema,
  autosave_draft_id: contentDraftIdSchema.optional(),
}).strict();

export const pageMutationSuccessSchema = pageDetailSuccessSchema;
export const pageMutationResponseSchema = pageDetailResponseSchema;

export const deletePageRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const pageDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('page_deleted'),
    id: pageIdSchema,
  }).strict(),
}).strict();

export const pageDeleteResponseSchema = z.union([
  pageDeleteSuccessSchema,
  apiErrorSchema,
]);

export const pageBulkLifecycleRequestSchema = z.object({
  target_status: contentBulkLifecycleTargetStatusSchema,
  items: z.array(z.object({
    id: pageIdSchema,
    expected_revision: settingsRevisionSchema,
  }).strict()).min(1).max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'id'],
        message: 'Page IDs in a bulk lifecycle request must be unique.',
      });
    }
    seen.add(item.id);
  }
});

export const pageBulkLifecycleResultSchema = z.union([
  z.object({
    id: pageIdSchema,
    outcome: z.enum(['updated', 'unchanged']),
    status: pageStatusSchema,
    revision: settingsRevisionSchema,
  }).strict(),
  z.object({
    id: pageIdSchema,
    outcome: z.literal('conflict'),
  }).strict(),
  z.object({
    id: pageIdSchema,
    outcome: z.literal('skipped'),
    reason: z.enum(['not_found', 'front_page_protected', 'has_children']),
  }).strict(),
]);

export const pageBulkLifecycleDataSchema = z.object({
  target_status: contentBulkLifecycleTargetStatusSchema,
  results: z.array(pageBulkLifecycleResultSchema)
    .min(1)
    .max(CONTENT_BULK_LIFECYCLE_MAX_ITEMS),
  summary: contentBulkLifecycleSummarySchema,
}).strict().superRefine((value, context) => {
  if (value.results.length !== value.summary.requested) {
    context.addIssue({
      code: 'custom',
      message: 'Page bulk lifecycle results must match the requested count.',
    });
  }
  const counts = { updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  for (const result of value.results) counts[result.outcome] += 1;
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[key] !== value.summary[key]) {
      context.addIssue({
        code: 'custom',
        path: ['summary', key],
        message: 'Page bulk lifecycle summary does not match its results.',
      });
    }
  }
});

export const pageBulkLifecycleSuccessSchema = z.object({
  success: z.literal(true),
  data: pageBulkLifecycleDataSchema,
}).strict();

export const pageBulkLifecycleResponseSchema = z.union([
  pageBulkLifecycleSuccessSchema,
  apiErrorSchema,
]);

export const pageParentOptionsQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  current_page_id: pageIdSchema.optional(),
}).strict();

export const pageParentOptionSchema = z.object({
  id: pageIdSchema,
  title: pageTitleSchema,
  slug: pageSlugSchema,
  path: pageEffectivePathSchema,
}).strict();

export const pageParentOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(pageParentOptionSchema).max(PAGE_PARENT_OPTIONS_MAX_ITEMS),
  }).strict(),
}).strict();

export const pageParentOptionsResponseSchema = z.union([
  pageParentOptionsSuccessSchema,
  apiErrorSchema,
]);

export function suggestPageSlug(value: string): string {
  return generateContentSlug(value);
}

export type PageStatus = z.infer<typeof pageStatusSchema>;
export type Page = z.infer<typeof pageSchema>;
export type PageSummary = z.infer<typeof pageSummarySchema>;
export type PageListRecord = z.infer<typeof pageListRecordSchema>;
export type PageListItem = z.infer<typeof pageListItemSchema>;
export type PageListQuery = z.infer<typeof pageListQuerySchema>;
export type PageListResponse = z.infer<typeof pageListResponseSchema>;
export type PageDetailResponse = z.infer<typeof pageDetailResponseSchema>;
export type CreatePageRequest = z.infer<typeof createPageRequestSchema>;
export type UpdatePageRequest = z.infer<typeof updatePageRequestSchema>;
export type PageMutationResponse = z.infer<typeof pageMutationResponseSchema>;
export type DeletePageRequest = z.infer<typeof deletePageRequestSchema>;
export type PageDeleteResponse = z.infer<typeof pageDeleteResponseSchema>;
export type PageBulkLifecycleRequest = z.infer<
  typeof pageBulkLifecycleRequestSchema
>;
export type PageBulkLifecycleResult = z.infer<
  typeof pageBulkLifecycleResultSchema
>;
export type PageBulkLifecycleData = z.infer<
  typeof pageBulkLifecycleDataSchema
>;
export type PageBulkLifecycleResponse = z.infer<
  typeof pageBulkLifecycleResponseSchema
>;
export type PageParentOption = z.infer<typeof pageParentOptionSchema>;
export type PageParentOptionsResponse = z.infer<
  typeof pageParentOptionsResponseSchema
>;
