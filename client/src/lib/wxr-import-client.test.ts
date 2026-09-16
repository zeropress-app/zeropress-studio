import { describe, expect, it } from 'vitest';
import type { WxrCoreImportPlan } from '../wxr/wxr-core-parser';
import { createWxrCoreImportChunks } from './wxr-import-client';

function plan(overrides: Partial<WxrCoreImportPlan['rows']>): WxrCoreImportPlan {
  return {
    source: {
      site_title: 'WordPress',
      site_url: 'https://blog.example',
      site_settings: {
        title: 'WordPress',
        description: '',
        url: {
          source: 'https://blog.example',
          origin: 'https://blog.example',
        },
        locale: 'en-US',
        timezone: 'UTC',
      },
      permalinks: {
        output_style: 'html-extension',
        posts: '/post/:public_id/',
        pages: '/:slug/',
      },
      media_strategy: 'external',
      media_from: null,
    },
    editor_compatibility: { visual: 0, source: 0, source_fallbacks: [] },
    warnings: [],
    rows: {
      authors: [], categories: [], tags: [], media: [], posts: [], pages: [],
      menus: [],
      comments: [],
      ...overrides,
    },
  };
}

describe('WXR import client chunk planner', () => {
  it('preserves dependency order and caps each chunk at 100 rows', () => {
    const chunks = createWxrCoreImportChunks(plan({
      authors: Array.from({ length: 101 }, (_, index) => ({
        id: `author-${index}`,
        display_name: `Author ${index}`,
      })),
      categories: [{ name: 'News', slug: 'news', description: '' }],
    }));
    expect(chunks.map((chunk) => [chunk.phase, chunk.rows.length]))
      .toEqual([['authors', 100], ['authors', 1], ['categories', 1]]);
  });

  it('splits valid multibyte content before the preferred byte target', () => {
    const largeContent = '한'.repeat(1_100_000);
    const rows = Array.from({ length: 2 }, (_, index) => ({
      public_id: index + 1,
      title: `Post ${index + 1}`,
      slug: `post-${index + 1}`,
      content: largeContent,
      document_type: 'html' as const,
      editor_mode: 'source' as const,
      editor_profile: null,
      excerpt: '',
      status: 'draft' as const,
      author_id: 'author',
      category_slugs: [],
      tag_slugs: [],
      discoverability: 'default' as const,
      allow_comments: false,
      featured_image_location: null,
      published_at_iso: null,
      created_at_iso: '2026-07-01T00:00:00Z',
      updated_at_iso: '2026-07-01T00:00:00Z',
    }));
    const chunks = createWxrCoreImportChunks(plan({ posts: rows }));
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([1, 1]);
  });

  it('uses the conservative 50-row Post budget while other phases allow 100', () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      public_id: index + 1,
      title: `Post ${index + 1}`,
      slug: `post-${index + 1}`,
      content: '',
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
      editor_profile: 'tiptap-v1' as const,
      excerpt: '',
      status: 'draft' as const,
      author_id: 'author',
      category_slugs: [],
      tag_slugs: [],
      discoverability: 'default' as const,
      allow_comments: false,
      featured_image_location: null,
      published_at_iso: null,
      created_at_iso: '2026-07-01T00:00:00Z',
      updated_at_iso: '2026-07-01T00:00:00Z',
    }));
    expect(createWxrCoreImportChunks(plan({ posts: rows }))
      .map((chunk) => chunk.rows.length)).toEqual([50, 1]);
  });

  it('places Menus after Pages and Comments last with its Edge write budget', () => {
    const comments = Array.from({ length: 81 }, (_, index) => ({
      public_id: index + 1,
      target_type: 'post' as const,
      target_public_id: 13261,
      parent_public_id: null,
      author_name: `Reader ${index + 1}`,
      author_email: '',
      content_text: `Comment ${index + 1}`,
      status: 'approved' as const,
      created_at_iso: '2026-07-01T00:00:00Z',
    }));
    const chunks = createWxrCoreImportChunks(plan({
      menus: [{ menu_id: 'primary', name: 'Primary', items: [] }],
      comments,
    }));
    expect(chunks.map((chunk) => [chunk.phase, chunk.rows.length]))
      .toEqual([['menus', 1], ['comments', 80], ['comments', 1]]);
  });

  it('bounds Menu aggregate chunks independently from general rows', () => {
    const menus = Array.from({ length: 51 }, (_, index) => ({
      menu_id: `menu-${index}`,
      name: `Menu ${index}`,
      items: [],
    }));
    const chunks = createWxrCoreImportChunks(plan({ menus }));
    expect(chunks.map((chunk) => [chunk.phase, chunk.rows.length]))
      .toEqual([['menus', 50], ['menus', 1]]);
  });
});
