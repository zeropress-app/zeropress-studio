import { describe, expect, it } from 'vitest';
import {
  authorIdSchema,
  authorListResponseSchema,
  authorListQuerySchema,
  createAuthorRequestSchema,
  suggestAuthorId,
  updateAuthorRequestSchema,
} from './authors';

describe('author contracts', () => {
  it('accepts immutable WXR-compatible IDs and preserves case', () => {
    expect(authorIdSchema.parse('Lael-Rukius')).toBe('Lael-Rukius');
    expect(authorIdSchema.parse('lael_rukius-2')).toBe('lael_rukius-2');
    for (const value of ['', 'editor.name', '한글', 'two words', '/editor']) {
      expect(authorIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it('normalizes display names but requires explicit canonical IDs', () => {
    expect(createAuthorRequestSchema.parse({
      id: 'Editor',
      display_name: '  Example Editor  ',
      user_id: null,
      avatar_media_id: null,
    })).toEqual({
      id: 'Editor',
      display_name: 'Example Editor',
      user_id: null,
      avatar_media_id: null,
    });
    expect(updateAuthorRequestSchema.safeParse({
      id: 'replacement-is-not-accepted',
      display_name: 'Editor',
      user_id: null,
      avatar_media_id: null,
      expected_revision: '1'.repeat(32),
    }).success).toBe(false);
  });

  it('materializes bounded list defaults and rejects unknown query keys', () => {
    expect(authorListQuerySchema.parse({})).toEqual({
      search: '',
      linked: 'all',
      page: 1,
      per_page: 50,
    });
    expect(authorListQuerySchema.safeParse({ per_page: '101' }).success)
      .toBe(false);
    expect(authorListQuerySchema.safeParse({ unexpected: 'value' }).success)
      .toBe(false);
  });

  it('reports the current Post count only on Author list items', () => {
    const author = {
      id: 'Editor',
      display_name: 'Editor',
      user: null,
      avatar: null,
      revision: '1'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    expect(authorListResponseSchema.safeParse({
      success: true,
      data: {
        items: [{ ...author, post_count: 3 }],
        pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
        summary: { total: 2, linked: 1, unlinked: 1 },
      },
    }).success).toBe(true);
    expect(authorListResponseSchema.safeParse({
      success: true,
      data: {
        items: [author],
        pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
        summary: { total: 2, linked: 1, unlinked: 1 },
      },
    }).success).toBe(false);
    expect(authorListResponseSchema.safeParse({
      success: true,
      data: {
        items: [{ ...author, post_count: 3 }],
        pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
        summary: { total: 3, linked: 1, unlinked: 1 },
      },
    }).success).toBe(false);
  });

  it('suggests the same ASCII-safe base shape used by the WXR bridge', () => {
    expect(suggestAuthorId('Lael Rukius')).toBe('Lael-Rukius');
    expect(suggestAuthorId('editor@example.com')).toBe('editor-example-com');
    expect(suggestAuthorId('한글 작성자')).toBe('');
  });
});
