import { describe, expect, it } from 'vitest';
import {
  createPostRequestSchema,
  postBulkLifecycleRequestSchema,
  postBulkLifecycleSuccessSchema,
  postEditorOptionsSuccessSchema,
  postListSuccessSchema,
  postListQuerySchema,
  postSchema,
  suggestPostSlug,
  updatePostRequestSchema,
} from './posts';

const authoredPost = {
  title: '  Product update  ',
  slug: 'release.v0.7',
  content: '# Hello',
  document_type: 'markdown',
  editor_mode: 'source',
  editor_profile: null,
  excerpt: '  Summary.  ',
  status: 'draft',
  author_id: 'site-author',
  category_ids: ['2'.repeat(32), '1'.repeat(32)],
  tag_ids: ['4'.repeat(32), '3'.repeat(32)],
  discoverability: 'default',
  allow_comments: true,
  featured_image_id: null,
};

describe('Post contracts', () => {
  it('canonicalizes authored fields while preserving Tag order', () => {
    expect(createPostRequestSchema.parse(authoredPost)).toEqual({
      ...authoredPost,
      title: 'Product update',
      excerpt: 'Summary.',
      category_ids: ['1'.repeat(32), '2'.repeat(32)],
    });
    expect(updatePostRequestSchema.safeParse({
      ...authoredPost,
      expected_revision: 'a'.repeat(32),
      extra: true,
    }).success).toBe(false);
  });

  it('rejects unsafe slugs and duplicate relation IDs', () => {
    expect(createPostRequestSchema.safeParse({
      ...authoredPost,
      slug: '.private',
    }).success).toBe(false);
    expect(createPostRequestSchema.safeParse({
      ...authoredPost,
      tag_ids: ['3'.repeat(32), '3'.repeat(32)],
    }).success).toBe(false);
  });

  it('materializes bounded list defaults', () => {
    expect(postListQuerySchema.parse({})).toEqual({
      search: '',
      status: 'all',
      page: 1,
      per_page: 50,
    });
    expect(postListQuerySchema.safeParse({ per_page: '101' }).success)
      .toBe(false);
    expect(postListQuerySchema.parse({ author_id: 'Site-Author' }))
      .toMatchObject({ author_id: 'Site-Author' });
    expect(postListQuerySchema.safeParse({ author_id: 'invalid.author' }).success)
      .toBe(false);
  });

  it('requires explicit all, own, or unavailable Post access metadata', () => {
    const response = {
      success: true,
      data: {
        access: {
          scope: 'own',
          author: { id: 'site-author', display_name: 'Site Author' },
        },
        items: [],
        pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 },
        status_counts: { all: 0, draft: 0, published: 0, trash: 0 },
      },
    };
    expect(postListSuccessSchema.safeParse(response).success).toBe(true);
    expect(postListSuccessSchema.safeParse({
      ...response,
      data: { ...response.data, access: undefined },
    }).success).toBe(false);
    expect(postListSuccessSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        access: { scope: 'unavailable', reason: 'author_not_linked' },
      },
    }).success).toBe(true);
  });

  it('requires publication timestamps only for published stored Posts', () => {
    const post = {
      id: '1'.repeat(32),
      public_id: 100_000_000_001,
      title: 'Post',
      slug: 'post',
      content: '',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      excerpt: '',
      status: 'published',
      author: { id: 'site-author', display_name: 'Site Author' },
      categories: [],
      tags: [],
      discoverability: 'default',
      allow_comments: true,
      featured_image: null,
      published_at_iso: null,
      revision: '2'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    expect(postSchema.safeParse(post).success).toBe(false);
    expect(postSchema.safeParse({
      ...post,
      status: 'draft',
    }).success).toBe(true);
  });

  it('keeps editor option kinds and slugs discriminated', () => {
    expect(postEditorOptionsSuccessSchema.safeParse({
      success: true,
      data: {
        kind: 'author',
        items: [{
          kind: 'author',
          id: 'site-author',
          label: 'Site Author',
          slug: null,
        }],
      },
    }).success).toBe(true);
    expect(postEditorOptionsSuccessSchema.safeParse({
      success: true,
      data: {
        kind: 'author',
        items: [{
          kind: 'tag',
          id: '3'.repeat(32),
          label: 'Tag',
          slug: 'tag',
        }],
      },
    }).success).toBe(false);
  });

  it('suggests the shared readable slug format', () => {
    expect(suggestPostSlug('Product Update')).toBe('product-update');
    expect(suggestPostSlug('릴리스 소식')).toBe('릴리스-소식');
  });

  it('bounds bulk lifecycle requests and verifies result summaries', () => {
    const id = '1'.repeat(32);
    const request = {
      target_status: 'published',
      items: [{ id, expected_revision: '2'.repeat(32) }],
    };
    expect(postBulkLifecycleRequestSchema.safeParse(request).success).toBe(true);
    expect(postBulkLifecycleRequestSchema.safeParse({
      ...request,
      items: [...request.items, ...request.items],
    }).success).toBe(false);
    expect(postBulkLifecycleRequestSchema.safeParse({
      target_status: 'published',
      items: Array.from({ length: 11 }, (_, index) => ({
        id: index.toString(16).padStart(32, '0'),
        expected_revision: '2'.repeat(32),
      })),
    }).success).toBe(false);

    const response = {
      success: true,
      data: {
        target_status: 'published',
        results: [{
          id,
          outcome: 'updated',
          status: 'published',
          revision: '3'.repeat(32),
        }],
        summary: {
          requested: 1,
          updated: 1,
          unchanged: 0,
          conflict: 0,
          skipped: 0,
        },
      },
    };
    expect(postBulkLifecycleSuccessSchema.safeParse(response).success).toBe(true);
    expect(postBulkLifecycleSuccessSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        summary: { ...response.data.summary, updated: 0, skipped: 1 },
      },
    }).success).toBe(false);
  });
});
