import { z } from 'zod';
import { CONTENT_SLUG_MAX_LENGTH } from '@zeropress/slug-policy';
import { apiErrorSchema } from './api';
import {
  contentAutosaveDeleteSuccessSchema,
  contentAutosavePromotionRequestSchema,
  contentDraftIdSchema,
  contentSnapshotSha256Schema,
  contentSnapshotVersionSchema,
  createAutosaveLocatorQuerySchema,
  validateAutosaveDocumentRetention,
  validateAutosaveTargetPair,
} from './content-snapshots';
import {
  contentEditorModeSchema,
  contentEditorProfileSchema,
  sourceEditorState,
  validateContentEditorState,
} from './content-editor';
import { mediaIdSchema, mediaReferenceSchema } from './media';
import {
  POST_CONTENT_MAX_LENGTH,
  POST_EXCERPT_MAX_LENGTH,
  POST_RELATION_MAX_ITEMS,
  POST_TITLE_MAX_LENGTH,
  postAuthorSchema,
  postDiscoverabilitySchema,
  postDocumentTypeSchema,
  postIdSchema,
  postSchema,
  postStatusSchema,
  postTaxonomyTermSchema,
} from './posts';
import { authorIdSchema } from './authors';
import { settingsRevisionSchema } from './settings-revision';
import { taxonomyTermIdSchema } from './taxonomies';

const rawAuthorIdSchema = z.union([authorIdSchema, z.literal('')]);
const relationIdsSchema = z.array(taxonomyTermIdSchema)
  .max(POST_RELATION_MAX_ITEMS)
  .refine((items) => new Set(items).size === items.length);

const legacyPostSnapshotDraftSchema = z.object({
    title: z.string().max(POST_TITLE_MAX_LENGTH),
    slug: z.string().max(CONTENT_SLUG_MAX_LENGTH * 2),
    content: z.string().max(POST_CONTENT_MAX_LENGTH),
    document_type: postDocumentTypeSchema,
    excerpt: z.string().max(POST_EXCERPT_MAX_LENGTH),
    status: postStatusSchema,
    author_id: rawAuthorIdSchema,
    category_ids: relationIdsSchema,
    tag_ids: relationIdsSchema,
    discoverability: postDiscoverabilitySchema,
    allow_comments: z.boolean(),
    featured_image_id: mediaIdSchema.nullable(),
  }).strict();

const postSnapshotDraftSchema = legacyPostSnapshotDraftSchema.extend({
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
}).strict().superRefine(validateContentEditorState);

const postSnapshotReferencesSchema = z.object({
  author: postAuthorSchema.nullable(),
  categories: z.array(postTaxonomyTermSchema).max(POST_RELATION_MAX_ITEMS),
  tags: z.array(postTaxonomyTermSchema).max(POST_RELATION_MAX_ITEMS),
  featured_image: mediaReferenceSchema.nullable(),
}).strict();

function validatePostSnapshotReferences(
  value: {
    draft: z.infer<typeof legacyPostSnapshotDraftSchema>;
    references: z.infer<typeof postSnapshotReferencesSchema>;
  },
  context: z.core.$RefinementCtx,
) {
  const { draft, references } = value;
  if ((references.author?.id ?? '') !== draft.author_id) {
    context.addIssue({ code: 'custom', path: ['references', 'author'], message: 'Author reference does not match the draft.' });
  }
  if (references.categories.map((item) => item.id).join('\0') !== draft.category_ids.join('\0')) {
    context.addIssue({ code: 'custom', path: ['references', 'categories'], message: 'Category references do not match the draft.' });
  }
  if (references.tags.map((item) => item.id).join('\0') !== draft.tag_ids.join('\0')) {
    context.addIssue({ code: 'custom', path: ['references', 'tags'], message: 'Tag references do not match the draft.' });
  }
  if ((references.featured_image?.id ?? null) !== draft.featured_image_id) {
    context.addIssue({ code: 'custom', path: ['references', 'featured_image'], message: 'Featured image reference does not match the draft.' });
  }
}

export const legacyPostContentSnapshotSchema = z.object({
  version: z.literal(1),
  content_type: z.literal('post'),
  draft: legacyPostSnapshotDraftSchema,
  references: postSnapshotReferencesSchema,
}).strict().superRefine(validatePostSnapshotReferences);

export const currentPostContentSnapshotSchema = z.object({
  version: contentSnapshotVersionSchema,
  content_type: z.literal('post'),
  draft: postSnapshotDraftSchema,
  references: postSnapshotReferencesSchema,
}).strict().superRefine(validatePostSnapshotReferences);

export const postContentSnapshotSchema = z.union([
  legacyPostContentSnapshotSchema,
  currentPostContentSnapshotSchema,
]);

export function normalizePostContentSnapshot(
  snapshot: PostContentSnapshot,
): CurrentPostContentSnapshot {
  if (snapshot.version === 2) return snapshot;
  return currentPostContentSnapshotSchema.parse({
    ...snapshot,
    version: 2,
    draft: { ...snapshot.draft, ...sourceEditorState() },
  });
}

export const postAutosaveLocatorQuerySchema = createAutosaveLocatorQuerySchema(
  postIdSchema,
);

export const putPostAutosaveRequestSchema = z.object({
  draft_id: contentDraftIdSchema,
  target_id: postIdSchema.nullable(),
  base_revision: settingsRevisionSchema.nullable(),
  snapshot: currentPostContentSnapshotSchema,
}).strict().superRefine(validateAutosaveTargetPair);

export const postAutosaveDocumentSchema = z.object({
  draft_id: contentDraftIdSchema,
  target_id: postIdSchema.nullable(),
  base_revision: settingsRevisionSchema.nullable(),
  snapshot: postContentSnapshotSchema,
  snapshot_sha256: contentSnapshotSha256Schema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
  expires_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine(validateAutosaveDocumentRetention);

export const postAutosaveReadSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ autosave: postAutosaveDocumentSchema.nullable() }).strict(),
}).strict();
export const postAutosaveReadResponseSchema = z.union([
  postAutosaveReadSuccessSchema,
  apiErrorSchema,
]);
export const postAutosaveMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: postAutosaveDocumentSchema,
}).strict();
export const postAutosaveMutationResponseSchema = z.union([
  postAutosaveMutationSuccessSchema,
  apiErrorSchema,
]);
export const postAutosaveDeleteResponseSchema = z.union([
  contentAutosaveDeleteSuccessSchema,
  apiErrorSchema,
]);
export const postAutosavePromotionRequestSchema =
  contentAutosavePromotionRequestSchema;
export const postAutosavePromotionSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('draft_promoted'),
    post: postSchema,
  }).strict(),
}).strict();
export const postAutosavePromotionResponseSchema = z.union([
  postAutosavePromotionSuccessSchema,
  apiErrorSchema,
]);

export type PostContentSnapshot = z.infer<typeof postContentSnapshotSchema>;
export type CurrentPostContentSnapshot = z.infer<
  typeof currentPostContentSnapshotSchema
>;
export type PutPostAutosaveRequest = z.infer<typeof putPostAutosaveRequestSchema>;
export type PostAutosaveDocument = z.infer<typeof postAutosaveDocumentSchema>;
export type PostAutosaveReadResponse = z.infer<typeof postAutosaveReadResponseSchema>;
export type PostAutosaveMutationResponse = z.infer<typeof postAutosaveMutationResponseSchema>;
export type PostAutosaveDeleteResponse = z.infer<typeof postAutosaveDeleteResponseSchema>;
export type PostAutosavePromotionRequest = z.infer<
  typeof postAutosavePromotionRequestSchema
>;
export type PostAutosavePromotionResponse = z.infer<
  typeof postAutosavePromotionResponseSchema
>;
