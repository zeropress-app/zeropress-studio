import { z } from 'zod';
import {
  generateContentSlug,
  normalizeStoredSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';
import { apiErrorSchema } from './api';
import {
  AUTHOR_DISPLAY_NAME_MAX_LENGTH,
  AUTHOR_ID_MAX_LENGTH,
  authorDisplayNameInputSchema,
  authorDisplayNameSchema,
  authorIdSchema,
} from './author-identity';
import { settingsRevisionSchema } from './settings-revision';
import { userIdSchema, userStatusSchema } from './users';
import {
  externalMediaUrlSchema,
  mediaFilenameSchema,
  mediaIdSchema,
  mediaLocationSchema,
  mediaMimeTypeSchema,
  privateMediaPreviewUrlSchema,
} from './media';

export const AUTHORS_DEFAULT_PAGE_SIZE = 50;
export const AUTHORS_MAX_PAGE_SIZE = 100;

export {
  AUTHOR_DISPLAY_NAME_MAX_LENGTH,
  AUTHOR_ID_MAX_LENGTH,
  authorDisplayNameInputSchema,
  authorDisplayNameSchema,
  authorIdSchema,
};

export const authorLinkedUserSchema = z.object({
  id: userIdSchema,
  email: z.email().max(254).refine(
    (value) => value === value.trim() && value === value.toLowerCase(),
  ),
  name: z.string().min(2).max(100).refine(
    (value) => value === value.trim(),
  ),
  status: userStatusSchema,
}).strict();

export const authorAvatarSchema = z.object({
  id: mediaIdSchema,
  filename: mediaFilenameSchema,
  mime_type: mediaMimeTypeSchema.refine((value) => value.startsWith('image/')),
  location: mediaLocationSchema,
  preview_url: z.union([
    externalMediaUrlSchema,
    privateMediaPreviewUrlSchema,
  ]).nullable(),
}).strict();

export const authorSchema = z.object({
  id: authorIdSchema,
  display_name: authorDisplayNameSchema,
  user: authorLinkedUserSchema.nullable(),
  avatar: authorAvatarSchema.nullable(),
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().refine((value) => (
  Date.parse(value.created_at_iso) <= Date.parse(value.updated_at_iso)
));

export const authorListItemSchema = authorSchema.extend({
  post_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const authorListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  linked: z.enum(['all', 'linked', 'unlinked']).default('all'),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(AUTHORS_MAX_PAGE_SIZE)
    .default(AUTHORS_DEFAULT_PAGE_SIZE),
}).strict();

const paginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(AUTHORS_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

const authorCountSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const authorListSummarySchema = z.object({
  total: authorCountSchema,
  linked: authorCountSchema,
  unlinked: authorCountSchema,
}).strict().refine(
  (value) => value.total === value.linked + value.unlinked,
  { path: ['total'], message: 'Author summary counts must be consistent.' },
);

export const authorListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(authorListItemSchema).max(AUTHORS_MAX_PAGE_SIZE),
    pagination: paginationSchema,
    summary: authorListSummarySchema,
  }).strict(),
}).strict();

export const authorListResponseSchema = z.union([
  authorListSuccessSchema,
  apiErrorSchema,
]);

export const authorUserOptionSchema = authorLinkedUserSchema.extend({
  linked_author_id: authorIdSchema.nullable(),
}).strict();

export const authorUserOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(authorUserOptionSchema).max(100),
  }).strict(),
}).strict();

export const authorUserOptionsResponseSchema = z.union([
  authorUserOptionsSuccessSchema,
  apiErrorSchema,
]);

export const createAuthorRequestSchema = z.object({
  id: authorIdSchema,
  display_name: authorDisplayNameInputSchema,
  user_id: userIdSchema.nullable(),
  avatar_media_id: mediaIdSchema.nullable(),
}).strict();

export const updateAuthorRequestSchema = z.object({
  display_name: authorDisplayNameInputSchema,
  user_id: userIdSchema.nullable(),
  avatar_media_id: mediaIdSchema.nullable(),
  expected_revision: settingsRevisionSchema,
}).strict();

export const deleteAuthorRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const authorMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: authorSchema,
}).strict();

export const authorMutationResponseSchema = z.union([
  authorMutationSuccessSchema,
  apiErrorSchema,
]);

export const authorDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('author_deleted'),
    id: authorIdSchema,
  }).strict(),
}).strict();

export const authorDeleteResponseSchema = z.union([
  authorDeleteSuccessSchema,
  apiErrorSchema,
]);

/**
 * Produces the same ASCII-safe base ID shape used by the WXR bridge. The
 * explicit create contract remains authoritative, so callers must still let
 * users review and submit the resulting immutable ID.
 */
export function suggestAuthorId(value: string): string {
  const source = normalizeStoredSlug(value)
    .trim()
    .replace(/[\s/\\%?#\u0000-\u001F\u007F]+/gu, '-')
    .replace(/\.{2,}/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '');
  if (!source) return '';
  const validation = validateSlugSegment(source);
  const normalized = validation.ok
    ? validation.normalized
    : generateContentSlug(source);
  return normalized
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, AUTHOR_ID_MAX_LENGTH);
}

export type Author = z.infer<typeof authorSchema>;
export type AuthorAvatar = z.infer<typeof authorAvatarSchema>;
export type AuthorListItem = z.infer<typeof authorListItemSchema>;
export type AuthorListQuery = z.infer<typeof authorListQuerySchema>;
export type AuthorListSummary = z.infer<typeof authorListSummarySchema>;
export type AuthorListResponse = z.infer<typeof authorListResponseSchema>;
export type AuthorUserOption = z.infer<typeof authorUserOptionSchema>;
export type AuthorUserOptionsResponse = z.infer<
  typeof authorUserOptionsResponseSchema
>;
export type CreateAuthorRequest = z.infer<typeof createAuthorRequestSchema>;
export type UpdateAuthorRequest = z.infer<typeof updateAuthorRequestSchema>;
export type DeleteAuthorRequest = z.infer<typeof deleteAuthorRequestSchema>;
export type AuthorMutationResponse = z.infer<
  typeof authorMutationResponseSchema
>;
export type AuthorDeleteResponse = z.infer<typeof authorDeleteResponseSchema>;
