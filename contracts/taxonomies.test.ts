import { describe, expect, it } from 'vitest';
import {
  createTaxonomyTermRequestSchema,
  suggestTaxonomySlug,
  taxonomyListItemSchema,
  taxonomyListQuerySchema,
  taxonomyListSuccessSchema,
  taxonomyListSummarySchema,
  taxonomySlugInputSchema,
  taxonomySlugSchema,
  taxonomyTermSchema,
  updateTaxonomyTermRequestSchema,
} from './taxonomies';

describe('taxonomy contracts', () => {
  it('uses the shared Preview Data slug policy and canonical NFC output', () => {
    expect(taxonomySlugInputSchema.parse('cafe\u0301')).toBe('caf\u00e9');
    expect(taxonomySlugInputSchema.parse('release.v0.7')).toBe('release.v0.7');
    for (const value of ['', '.', '..', '.private', 'private.', 'a..b', 'two words', 'a/b', 'foo%20bar']) {
      expect(taxonomySlugInputSchema.safeParse(value).success).toBe(false);
    }
    expect(taxonomySlugSchema.safeParse('cafe\u0301').success).toBe(false);
  });

  it('trims authored fields and keeps slug edits explicit', () => {
    expect(createTaxonomyTermRequestSchema.parse({
      name: '  Product News  ',
      slug: 'product-news',
      description: '  Announcements.  ',
    })).toEqual({
      name: 'Product News',
      slug: 'product-news',
      description: 'Announcements.',
    });
    expect(updateTaxonomyTermRequestSchema.safeParse({
      name: 'Product News',
      slug: 'product-news',
      description: '',
      expected_revision: '1'.repeat(32),
      unexpected: true,
    }).success).toBe(false);
  });

  it('materializes bounded list defaults', () => {
    expect(taxonomyListQuerySchema.parse({})).toEqual({
      search: '',
      page: 1,
      per_page: 50,
    });
    expect(taxonomyListQuerySchema.safeParse({ per_page: '101' }).success)
      .toBe(false);
  });

  it('suggests readable lowercase slugs without inventing an invalid value', () => {
    expect(suggestTaxonomySlug('Product News')).toBe('product-news');
    expect(suggestTaxonomySlug('릴리스 소식')).toBe('릴리스-소식');
    expect(suggestTaxonomySlug('---')).toBe('');
  });

  it('validates management counts separately from canonical terms and writes', () => {
    const term = {
      id: '1'.repeat(32), taxonomy: 'tag', name: '릴리스', slug: '릴리스.v0.7',
      description: 'Public description.', revision: '2'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    expect(taxonomyListItemSchema.parse({ ...term, post_count: 0 }).post_count).toBe(0);
    expect(taxonomyListItemSchema.safeParse(term).success).toBe(false);
    expect(taxonomyTermSchema.safeParse({ ...term, post_count: 1 }).success).toBe(false);
    expect(createTaxonomyTermRequestSchema.safeParse({
      name: term.name, slug: term.slug, description: term.description, post_count: 1,
    }).success).toBe(false);
    expect(taxonomyListItemSchema.safeParse({
      ...term, post_count: 1, updated_at_iso: '2026-07-01T00:00:00.000Z',
    }).success).toBe(false);
    for (const count of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(taxonomyListItemSchema.safeParse({ ...term, post_count: count }).success)
        .toBe(false);
      expect(taxonomyListSummarySchema.safeParse({ categories: count, tags: 0 }).success)
        .toBe(false);
    }
    expect(taxonomyListSummarySchema.safeParse({ categories: 0 }).success).toBe(false);
    expect(taxonomyListSummarySchema.safeParse({ categories: 0, tags: 0, extra: 1 }).success)
      .toBe(false);
    expect(taxonomyListSuccessSchema.safeParse({
      success: true,
      data: {
        items: [{ ...term, post_count: 3 }],
        pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
        summary: { categories: 4, tags: 12 },
      },
    }).success).toBe(true);
  });
});
