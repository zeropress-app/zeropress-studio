import { z } from 'zod';
import { apiErrorSchema } from './api';
import { authorDisplayNameSchema, authorIdSchema } from './authors';
import {
  generalSettingsDocumentSchema,
  updateGeneralSettingsRequestSchema,
} from './general-settings';
import {
  COMMENT_AUTHOR_NAME_MAX_LENGTH,
  COMMENT_CONTENT_MAX_LENGTH,
  commentAuthorEmailSchema,
  commentTargetTypeSchema,
} from './comments';
import { ZEROPRESS_NATIVE_PUBLIC_ID_BASE } from './content-public-id';
import {
  contentEditorModeSchema,
  contentEditorProfileSchema,
  validateContentEditorState,
} from './content-editor';
import {
  mediaAssetSchema,
  mediaLocationIdentity,
  mediaLocationSchema,
} from './media';
import {
  MENU_ITEMS_JSON_MAX_BYTES,
  MENU_ITEM_TITLE_MAX_LENGTH,
  MENU_MAX_DEPTH,
  MENU_MAX_ITEMS,
  menuCustomUrlSchema,
  menuIdSchema,
  menuItemIdSchema,
  menuItemTargetSchema,
  menuNameSchema,
} from './menus';
import {
  POST_RELATION_MAX_ITEMS,
  postContentSchema,
  postExcerptSchema,
  postSlugSchema,
  postTitleSchema,
} from './posts';
import {
  pageContentSchema,
  pageExcerptSchema,
  pageSlugSchema,
  pageTitleSchema,
} from './pages';
import {
  routingSettingsDocumentSchema,
  updateRoutingSettingsRequestSchema,
} from './routing-settings';
import {
  taxonomySlugSchema,
  taxonomyTermDescriptionSchema,
  taxonomyTermNameSchema,
} from './taxonomies';

export const WXR_IMPORT_CHUNK_MAX_ROWS = 100;
export const WXR_IMPORT_POST_CHUNK_MAX_ROWS = 50;
export const WXR_IMPORT_MENU_CHUNK_MAX_ROWS = 50;
export const WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS = 80;
export const WXR_IMPORT_REQUEST_BODY_LIMIT = 8 * 1024 * 1024;
export const WXR_IMPORT_CLIENT_CHUNK_TARGET_BYTES = 6 * 1024 * 1024;
export const WXR_IMPORT_FAILURES_MAX = WXR_IMPORT_CHUNK_MAX_ROWS;

export const wxrImportPhaseSchema = z.enum([
  'authors',
  'categories',
  'tags',
  'media',
  'posts',
  'pages',
  'menus',
  'comments',
]);

const importedPublicIdSchema = z.number().int().positive()
  .max(ZEROPRESS_NATIVE_PUBLIC_ID_BASE - 1);
const importedStatusSchema = z.enum(['draft', 'published']);
const importedIsoSchema = z.iso.datetime({ offset: true });

function uniqueStrings(item: z.ZodType<string>, maximum: number) {
  return z.array(item).max(maximum).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Values must be unique.' });
    }
  });
}

export const wxrImportAuthorRowSchema = z.object({
  id: authorIdSchema,
  display_name: authorDisplayNameSchema,
}).strict();

const wxrImportTaxonomyRowSchema = z.object({
  name: taxonomyTermNameSchema,
  slug: taxonomySlugSchema,
  description: taxonomyTermDescriptionSchema,
}).strict();

export const wxrImportCategoryRowSchema = wxrImportTaxonomyRowSchema;
export const wxrImportTagRowSchema = wxrImportTaxonomyRowSchema;

export const wxrImportMediaRowSchema = mediaAssetSchema.safeExtend({
  external_id: importedPublicIdSchema,
});

export const wxrImportPostRowSchema = z.object({
  public_id: importedPublicIdSchema,
  title: postTitleSchema,
  slug: postSlugSchema,
  content: postContentSchema,
  document_type: z.literal('html'),
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: postExcerptSchema,
  status: importedStatusSchema,
  author_id: authorIdSchema,
  category_slugs: uniqueStrings(taxonomySlugSchema, POST_RELATION_MAX_ITEMS),
  tag_slugs: uniqueStrings(taxonomySlugSchema, POST_RELATION_MAX_ITEMS),
  discoverability: z.literal('default'),
  allow_comments: z.boolean(),
  featured_image_location: mediaLocationSchema.nullable(),
  published_at_iso: importedIsoSchema.nullable(),
  created_at_iso: importedIsoSchema,
  updated_at_iso: importedIsoSchema,
}).strict().superRefine((value, context) => {
  validateContentEditorState(value, context);
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({ code: 'custom', message: 'Post timestamps are invalid.' });
  }
  if (
    (value.status === 'published')
    !== (value.published_at_iso !== null)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Only published imported Posts have a publication time.',
    });
  }
});

export const wxrImportPageRowSchema = z.object({
  public_id: importedPublicIdSchema,
  parent_public_id: importedPublicIdSchema.nullable(),
  title: pageTitleSchema,
  slug: pageSlugSchema,
  content: pageContentSchema,
  document_type: z.literal('html'),
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
  excerpt: pageExcerptSchema,
  status: importedStatusSchema,
  discoverability: z.literal('default'),
  allow_comments: z.boolean(),
  featured_image_location: mediaLocationSchema.nullable(),
  created_at_iso: importedIsoSchema,
  updated_at_iso: importedIsoSchema,
}).strict().superRefine((value, context) => {
  validateContentEditorState(value, context);
  if (value.parent_public_id === value.public_id) {
    context.addIssue({ code: 'custom', message: 'A Page cannot parent itself.' });
  }
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({ code: 'custom', message: 'Page timestamps are invalid.' });
  }
});

export type WxrImportMenuItem = {
  id: string;
  title: string;
  link:
    | { kind: 'custom'; url: string }
    | { kind: 'post'; public_id: number }
    | { kind: 'page'; public_id: number }
    | { kind: 'category'; slug: string }
    | { kind: 'tag'; slug: string };
  target: '_self' | '_blank';
  children: WxrImportMenuItem[];
};

const wxrImportMenuItemLinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom'),
    url: menuCustomUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal('post'),
    public_id: importedPublicIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('page'),
    public_id: importedPublicIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('category'),
    slug: taxonomySlugSchema,
  }).strict(),
  z.object({
    kind: z.literal('tag'),
    slug: taxonomySlugSchema,
  }).strict(),
]);

export const wxrImportMenuItemSchema: z.ZodType<WxrImportMenuItem> = z.lazy(
  () => z.object({
    id: menuItemIdSchema,
    title: z.string()
      .min(1)
      .max(MENU_ITEM_TITLE_MAX_LENGTH)
      .refine((value) => value === value.trim()),
    link: wxrImportMenuItemLinkSchema,
    target: menuItemTargetSchema,
    children: z.array(wxrImportMenuItemSchema),
  }).strict(),
);

function inspectImportedMenuItems(
  items: WxrImportMenuItem[],
  context: z.RefinementCtx,
) {
  const ids = new Set<string>();
  const pending = items.map((item) => ({ item, depth: 1 }));
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    count += 1;
    if (count > MENU_MAX_ITEMS) {
      context.addIssue({
        code: 'custom',
        message: `An imported Menu may have at most ${MENU_MAX_ITEMS} items.`,
      });
      return;
    }
    if (current.depth > MENU_MAX_DEPTH) {
      context.addIssue({
        code: 'custom',
        message: `Imported Menu depth may not exceed ${MENU_MAX_DEPTH}.`,
      });
      return;
    }
    if (ids.has(current.item.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Imported Menu item IDs must be unique within one Menu.',
      });
      return;
    }
    ids.add(current.item.id);
    for (const child of current.item.children) {
      pending.push({ item: child, depth: current.depth + 1 });
    }
  }
}

export const wxrImportMenuItemsSchema = z.array(wxrImportMenuItemSchema)
  .superRefine((items, context) => {
    inspectImportedMenuItems(items, context);
    if (
      new TextEncoder().encode(JSON.stringify(items)).byteLength
      > MENU_ITEMS_JSON_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: `Imported Menu data may use at most ${MENU_ITEMS_JSON_MAX_BYTES} UTF-8 bytes.`,
      });
    }
  });

export const wxrImportMenuRowSchema = z.object({
  menu_id: menuIdSchema,
  name: menuNameSchema,
  items: wxrImportMenuItemsSchema,
}).strict();

export const wxrImportCommentRowSchema = z.object({
  public_id: importedPublicIdSchema,
  target_type: commentTargetTypeSchema,
  target_public_id: importedPublicIdSchema,
  parent_public_id: importedPublicIdSchema.nullable(),
  author_name: z.string().trim().min(1).max(COMMENT_AUTHOR_NAME_MAX_LENGTH),
  author_email: commentAuthorEmailSchema,
  content_text: z.string().trim().min(1).max(COMMENT_CONTENT_MAX_LENGTH),
  status: z.enum(['pending', 'approved']),
  created_at_iso: importedIsoSchema,
}).strict().superRefine((value, context) => {
  if (value.parent_public_id === value.public_id) {
    context.addIssue({
      code: 'custom',
      path: ['parent_public_id'],
      message: 'A Comment cannot parent itself.',
    });
  }
});

function phaseRequest<Phase extends string, Row extends z.ZodTypeAny>(
  phase: Phase,
  row: Row,
  maximumRows = WXR_IMPORT_CHUNK_MAX_ROWS,
) {
  return z.object({
    phase: z.literal(phase),
    rows: z.array(row).min(1).max(maximumRows),
  }).strict();
}

const wxrImportCommentPhaseRequestSchema = phaseRequest(
  'comments',
  wxrImportCommentRowSchema,
  WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS,
).superRefine((value, context) => {
  const seen = new Set<number>();
  for (const [index, row] of value.rows.entries()) {
    if (seen.has(row.public_id)) {
      context.addIssue({
        code: 'custom',
        path: ['rows', index, 'public_id'],
        message: 'Comment public IDs must be unique within a chunk.',
      });
    }
    seen.add(row.public_id);
  }
});

const wxrImportMediaPhaseRequestSchema = phaseRequest(
  'media',
  wxrImportMediaRowSchema,
).superRefine((value, context) => {
  const externalIds = new Set<number>();
  const locations = new Set<string>();
  for (const [index, row] of value.rows.entries()) {
    if (externalIds.has(row.external_id)) {
      context.addIssue({
        code: 'custom',
        path: ['rows', index, 'external_id'],
        message: 'Media external IDs must be unique within a chunk.',
      });
    }
    externalIds.add(row.external_id);
    const location = mediaLocationIdentity(row.location);
    if (locations.has(location)) {
      context.addIssue({
        code: 'custom',
        path: ['rows', index, 'location'],
        message: 'Media locations must be unique within a chunk.',
      });
    }
    locations.add(location);
  }
});

export const wxrCoreImportChunkRequestSchema = z.discriminatedUnion('phase', [
  phaseRequest('authors', wxrImportAuthorRowSchema),
  phaseRequest('categories', wxrImportCategoryRowSchema),
  phaseRequest('tags', wxrImportTagRowSchema),
  wxrImportMediaPhaseRequestSchema,
  phaseRequest('posts', wxrImportPostRowSchema, WXR_IMPORT_POST_CHUNK_MAX_ROWS),
  phaseRequest('pages', wxrImportPageRowSchema),
  phaseRequest('menus', wxrImportMenuRowSchema, WXR_IMPORT_MENU_CHUNK_MAX_ROWS),
  wxrImportCommentPhaseRequestSchema,
]);

export const wxrImportRowFailureCodeSchema = z.enum([
  'SLUG_CONFLICT',
  'AUTHOR_NOT_FOUND',
  'TAXONOMY_TERM_NOT_FOUND',
  'MEDIA_EXTERNAL_ID_CONFLICT',
  'MEDIA_NOT_FOUND',
  'PAGE_PARENT_NOT_FOUND',
  'PAGE_PARENT_CYCLE',
  'PAGE_IS_FRONT_PAGE',
  'MENU_REFERENCE_NOT_FOUND',
  'MENU_LIMIT_REACHED',
  'COMMENT_TARGET_NOT_FOUND',
  'COMMENT_PUBLIC_ID_CONFLICT',
  'COMMENT_PARENT_NOT_FOUND',
  'REVISION_CONFLICT',
]);

export const wxrCoreImportChunkSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    phase: wxrImportPhaseSchema,
    processed: z.number().int().min(1).max(WXR_IMPORT_CHUNK_MAX_ROWS),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failures: z.array(z.object({
      row_index: z.number().int().nonnegative()
        .max(WXR_IMPORT_CHUNK_MAX_ROWS - 1),
      key: z.string().min(1).max(2_048),
      code: wxrImportRowFailureCodeSchema,
    }).strict()).max(WXR_IMPORT_FAILURES_MAX),
  }).strict().superRefine((value, context) => {
    if (
      value.created + value.updated + value.unchanged + value.failed
        !== value.processed
      || value.failed !== value.failures.length
    ) {
      context.addIssue({ code: 'custom', message: 'Import counts are inconsistent.' });
    }
  }),
}).strict();

export const wxrCoreImportChunkResponseSchema = z.union([
  wxrCoreImportChunkSuccessSchema,
  apiErrorSchema,
]);

export const wxrImportSettingsFinalizeRequestSchema = z.object({
  general_settings: updateGeneralSettingsRequestSchema,
  routing_settings: updateRoutingSettingsRequestSchema,
}).strict();

const wxrImportSettingsResultSchema = z.enum(['updated', 'unchanged']);

export const wxrImportSettingsFinalizeSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    general_settings: z.object({
      result: wxrImportSettingsResultSchema,
      document: generalSettingsDocumentSchema,
    }).strict(),
    routing_settings: z.object({
      result: wxrImportSettingsResultSchema,
      document: routingSettingsDocumentSchema,
    }).strict(),
  }).strict(),
}).strict();

export const wxrImportSettingsFinalizeResponseSchema = z.union([
  wxrImportSettingsFinalizeSuccessSchema,
  apiErrorSchema,
]);

export type WxrImportPhase = z.infer<typeof wxrImportPhaseSchema>;
export type WxrImportAuthorRow = z.infer<typeof wxrImportAuthorRowSchema>;
export type WxrImportCategoryRow = z.infer<
  typeof wxrImportCategoryRowSchema
>;
export type WxrImportTagRow = z.infer<typeof wxrImportTagRowSchema>;
export type WxrImportMediaRow = z.infer<typeof wxrImportMediaRowSchema>;
export type WxrImportPostRow = z.infer<typeof wxrImportPostRowSchema>;
export type WxrImportPageRow = z.infer<typeof wxrImportPageRowSchema>;
export type WxrImportMenuRow = z.infer<typeof wxrImportMenuRowSchema>;
export type WxrImportCommentRow = z.infer<typeof wxrImportCommentRowSchema>;
export type WxrCoreImportChunkRequest = z.infer<
  typeof wxrCoreImportChunkRequestSchema
>;
export type WxrImportRowFailureCode = z.infer<
  typeof wxrImportRowFailureCodeSchema
>;
export type WxrCoreImportChunkSuccess = z.infer<
  typeof wxrCoreImportChunkSuccessSchema
>;
export type WxrCoreImportChunkResponse = z.infer<
  typeof wxrCoreImportChunkResponseSchema
>;
export type WxrImportSettingsFinalizeRequest = z.input<
  typeof wxrImportSettingsFinalizeRequestSchema
>;
export type NormalizedWxrImportSettingsFinalizeRequest = z.output<
  typeof wxrImportSettingsFinalizeRequestSchema
>;
export type WxrImportSettingsFinalizeResponse = z.infer<
  typeof wxrImportSettingsFinalizeResponseSchema
>;
