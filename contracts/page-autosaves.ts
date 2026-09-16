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
  PAGE_CONTENT_MAX_LENGTH,
  PAGE_EXCERPT_MAX_LENGTH,
  PAGE_TITLE_MAX_LENGTH,
  pageDiscoverabilitySchema,
  pageDocumentTypeSchema,
  pageIdSchema,
  pageSchema,
  pageParentOptionSchema,
  pageStatusSchema,
} from './pages';
import { settingsRevisionSchema } from './settings-revision';

const legacyPageSnapshotDraftSchema = z.object({
    parent_id: pageIdSchema.nullable(),
    title: z.string().max(PAGE_TITLE_MAX_LENGTH),
    slug: z.string().max(CONTENT_SLUG_MAX_LENGTH * 2),
    content: z.string().max(PAGE_CONTENT_MAX_LENGTH),
    document_type: pageDocumentTypeSchema,
    excerpt: z.string().max(PAGE_EXCERPT_MAX_LENGTH),
    status: pageStatusSchema,
    discoverability: pageDiscoverabilitySchema,
    allow_comments: z.boolean(),
    featured_image_id: mediaIdSchema.nullable(),
  }).strict();

const pageSnapshotDraftSchema = legacyPageSnapshotDraftSchema.extend({
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
}).strict().superRefine(validateContentEditorState);

const pageSnapshotReferencesSchema = z.object({
    parent: pageParentOptionSchema.nullable(),
    featured_image: mediaReferenceSchema.nullable(),
  }).strict();

function validatePageSnapshotReferences(
  value: {
    draft: z.infer<typeof legacyPageSnapshotDraftSchema>;
    references: z.infer<typeof pageSnapshotReferencesSchema>;
  },
  context: z.core.$RefinementCtx,
) {
  if ((value.references.parent?.id ?? null) !== value.draft.parent_id) {
    context.addIssue({ code: 'custom', path: ['references', 'parent'], message: 'Parent reference does not match the draft.' });
  }
  if ((value.references.featured_image?.id ?? null) !== value.draft.featured_image_id) {
    context.addIssue({ code: 'custom', path: ['references', 'featured_image'], message: 'Featured image reference does not match the draft.' });
  }
}

export const legacyPageContentSnapshotSchema = z.object({
  version: z.literal(1),
  content_type: z.literal('page'),
  draft: legacyPageSnapshotDraftSchema,
  references: pageSnapshotReferencesSchema,
}).strict().superRefine(validatePageSnapshotReferences);

export const currentPageContentSnapshotSchema = z.object({
  version: contentSnapshotVersionSchema,
  content_type: z.literal('page'),
  draft: pageSnapshotDraftSchema,
  references: pageSnapshotReferencesSchema,
}).strict().superRefine(validatePageSnapshotReferences);

export const pageContentSnapshotSchema = z.union([
  legacyPageContentSnapshotSchema,
  currentPageContentSnapshotSchema,
]);

export function normalizePageContentSnapshot(
  snapshot: PageContentSnapshot,
): CurrentPageContentSnapshot {
  if (snapshot.version === 2) return snapshot;
  return currentPageContentSnapshotSchema.parse({
    ...snapshot,
    version: 2,
    draft: { ...snapshot.draft, ...sourceEditorState() },
  });
}

export const pageAutosaveLocatorQuerySchema = createAutosaveLocatorQuerySchema(
  pageIdSchema,
);
export const putPageAutosaveRequestSchema = z.object({
  draft_id: contentDraftIdSchema,
  target_id: pageIdSchema.nullable(),
  base_revision: settingsRevisionSchema.nullable(),
  snapshot: currentPageContentSnapshotSchema,
}).strict().superRefine(validateAutosaveTargetPair);

export const pageAutosaveDocumentSchema = z.object({
  draft_id: contentDraftIdSchema,
  target_id: pageIdSchema.nullable(),
  base_revision: settingsRevisionSchema.nullable(),
  snapshot: pageContentSnapshotSchema,
  snapshot_sha256: contentSnapshotSha256Schema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
  expires_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine(validateAutosaveDocumentRetention);

export const pageAutosaveReadSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ autosave: pageAutosaveDocumentSchema.nullable() }).strict(),
}).strict();
export const pageAutosaveReadResponseSchema = z.union([
  pageAutosaveReadSuccessSchema,
  apiErrorSchema,
]);
export const pageAutosaveMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: pageAutosaveDocumentSchema,
}).strict();
export const pageAutosaveMutationResponseSchema = z.union([
  pageAutosaveMutationSuccessSchema,
  apiErrorSchema,
]);
export const pageAutosaveDeleteResponseSchema = z.union([
  contentAutosaveDeleteSuccessSchema,
  apiErrorSchema,
]);
export const pageAutosavePromotionRequestSchema =
  contentAutosavePromotionRequestSchema;
export const pageAutosavePromotionSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('draft_promoted'),
    page: pageSchema,
  }).strict(),
}).strict();
export const pageAutosavePromotionResponseSchema = z.union([
  pageAutosavePromotionSuccessSchema,
  apiErrorSchema,
]);

export type PageContentSnapshot = z.infer<typeof pageContentSnapshotSchema>;
export type CurrentPageContentSnapshot = z.infer<
  typeof currentPageContentSnapshotSchema
>;
export type PutPageAutosaveRequest = z.infer<typeof putPageAutosaveRequestSchema>;
export type PageAutosaveDocument = z.infer<typeof pageAutosaveDocumentSchema>;
export type PageAutosaveReadResponse = z.infer<typeof pageAutosaveReadResponseSchema>;
export type PageAutosaveMutationResponse = z.infer<typeof pageAutosaveMutationResponseSchema>;
export type PageAutosaveDeleteResponse = z.infer<typeof pageAutosaveDeleteResponseSchema>;
export type PageAutosavePromotionRequest = z.infer<
  typeof pageAutosavePromotionRequestSchema
>;
export type PageAutosavePromotionResponse = z.infer<
  typeof pageAutosavePromotionResponseSchema
>;
