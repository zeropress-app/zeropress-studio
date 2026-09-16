import {
  CONTENT_SLUG_MAX_LENGTH,
  generateContentSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';
import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';

export const TAXONOMY_TERM_NAME_MAX_LENGTH = 200;
export const TAXONOMY_TERM_DESCRIPTION_MAX_LENGTH = 10_000;
export const TAXONOMIES_DEFAULT_PAGE_SIZE = 50;
export const TAXONOMIES_MAX_PAGE_SIZE = 100;

export const taxonomyKindSchema = z.enum(['category', 'tag']);
export const taxonomyTermIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const taxonomyTermNameInputSchema = z.string()
  .trim()
  .min(1)
  .max(TAXONOMY_TERM_NAME_MAX_LENGTH);

export const taxonomyTermNameSchema = z.string()
  .min(1)
  .max(TAXONOMY_TERM_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const taxonomyTermDescriptionInputSchema = z.string()
  .trim()
  .max(TAXONOMY_TERM_DESCRIPTION_MAX_LENGTH);

export const taxonomyTermDescriptionSchema = z.string()
  .max(TAXONOMY_TERM_DESCRIPTION_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const taxonomySlugInputSchema = z.string()
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

export const taxonomySlugSchema = z.string()
  .max(CONTENT_SLUG_MAX_LENGTH * 2)
  .refine((value) => {
    const validation = validateSlugSegment(value);
    return validation.ok && validation.normalized === value;
  });

export const taxonomyTermSchema = z.object({
  id: taxonomyTermIdSchema,
  taxonomy: taxonomyKindSchema,
  name: taxonomyTermNameSchema,
  slug: taxonomySlugSchema,
  description: taxonomyTermDescriptionSchema,
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().refine((value) => (
  Date.parse(value.created_at_iso) <= Date.parse(value.updated_at_iso)
));

const taxonomyCountSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

// Management-only projections; mutations and Preview Data retain the term shape.
export const taxonomyListItemSchema = taxonomyTermSchema.safeExtend({
  post_count: taxonomyCountSchema,
});

export const taxonomyListSummarySchema = z.object({
  categories: taxonomyCountSchema,
  tags: taxonomyCountSchema,
}).strict();

export const taxonomyListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(TAXONOMIES_MAX_PAGE_SIZE)
    .default(TAXONOMIES_DEFAULT_PAGE_SIZE),
}).strict();

const taxonomyPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(TAXONOMIES_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

export const taxonomyListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(taxonomyListItemSchema).max(TAXONOMIES_MAX_PAGE_SIZE),
    pagination: taxonomyPaginationSchema,
    summary: taxonomyListSummarySchema,
  }).strict(),
}).strict();

export const taxonomyListResponseSchema = z.union([
  taxonomyListSuccessSchema,
  apiErrorSchema,
]);

export const createTaxonomyTermRequestSchema = z.object({
  name: taxonomyTermNameInputSchema,
  slug: taxonomySlugInputSchema,
  description: taxonomyTermDescriptionInputSchema,
}).strict();

export const updateTaxonomyTermRequestSchema = z.object({
  name: taxonomyTermNameInputSchema,
  slug: taxonomySlugInputSchema,
  description: taxonomyTermDescriptionInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const deleteTaxonomyTermRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const taxonomyMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: taxonomyTermSchema,
}).strict();

export const taxonomyMutationResponseSchema = z.union([
  taxonomyMutationSuccessSchema,
  apiErrorSchema,
]);

export const taxonomyDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('taxonomy_term_deleted'),
    taxonomy: taxonomyKindSchema,
    id: taxonomyTermIdSchema,
  }).strict(),
}).strict();

export const taxonomyDeleteResponseSchema = z.union([
  taxonomyDeleteSuccessSchema,
  apiErrorSchema,
]);

export function suggestTaxonomySlug(value: string): string {
  return generateContentSlug(value);
}

export type TaxonomyKind = z.infer<typeof taxonomyKindSchema>;
export type TaxonomyTerm = z.infer<typeof taxonomyTermSchema>;
export type TaxonomyListItem = z.infer<typeof taxonomyListItemSchema>;
export type TaxonomyListSummary = z.infer<typeof taxonomyListSummarySchema>;
export type TaxonomyListQuery = z.infer<typeof taxonomyListQuerySchema>;
export type TaxonomyListResponse = z.infer<typeof taxonomyListResponseSchema>;
export type CreateTaxonomyTermRequest = z.infer<
  typeof createTaxonomyTermRequestSchema
>;
export type UpdateTaxonomyTermRequest = z.infer<
  typeof updateTaxonomyTermRequestSchema
>;
export type DeleteTaxonomyTermRequest = z.infer<
  typeof deleteTaxonomyTermRequestSchema
>;
export type TaxonomyMutationResponse = z.infer<
  typeof taxonomyMutationResponseSchema
>;
export type TaxonomyDeleteResponse = z.infer<
  typeof taxonomyDeleteResponseSchema
>;
