import { describe, expect, it } from 'vitest';
import {
  WXR_IMPORT_CHUNK_MAX_ROWS,
  WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS,
  wxrCoreImportChunkRequestSchema,
  wxrCoreImportChunkSuccessSchema,
  wxrImportSettingsFinalizeRequestSchema,
} from './wxr-import';
import { materializeRoutingSettingsDefaults } from './routing-settings';

const author = { id: 'wordpress-author', display_name: 'WordPress Author' };

describe('WXR core import contracts', () => {
  it('accepts closed phase-specific chunks and rejects mixed or oversized rows', () => {
    expect(wxrCoreImportChunkRequestSchema.parse({
      phase: 'authors',
      rows: [author],
    })).toEqual({ phase: 'authors', rows: [author] });
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'authors',
      rows: [{ ...author, unexpected: true }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'authors',
      rows: Array.from({ length: WXR_IMPORT_CHUNK_MAX_ROWS + 1 }, () => author),
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'authors',
      rows: [{ public_id: 1 }],
    }).success).toBe(false);
  });

  it('reserves the native public-ID range and requires canonical source timestamps', () => {
    const post = {
      public_id: 13261,
      title: 'Imported Post',
      slug: 'imported-post',
      content: '<p>Hello</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      excerpt: 'Hello',
      status: 'published',
      author_id: author.id,
      category_slugs: ['news'],
      tag_slugs: ['featured'],
      discoverability: 'default',
      allow_comments: true,
      featured_image_location: null,
      published_at_iso: '2026-07-01T00:00:00Z',
      created_at_iso: '2026-07-01T00:00:00Z',
      updated_at_iso: '2026-07-02T00:00:00Z',
    };
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'posts', rows: [post],
    }).success).toBe(true);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'posts', rows: [{ ...post, public_id: 100_000_000_000 }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'posts', rows: [{ ...post, updated_at_iso: 'not-a-date' }],
    }).success).toBe(false);
  });

  it('requires one bounded external identity and location per Media row', () => {
    const media = {
      external_id: 90,
      kind: 'image' as const,
      filename: 'hero.jpg',
      mime_type: 'image/jpeg',
      location: {
        type: 'external' as const,
        url: 'https://media.example/hero.jpg',
      },
      size_bytes: null,
      width: 1018,
      height: 724,
      duration_ms: null,
      alt: 'Hero',
    };
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'media', rows: [media],
    }).success).toBe(true);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'media', rows: [{ ...media, external_id: 100_000_000_000 }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'media', rows: [{ ...media, external_id: undefined }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'media',
      rows: [media, {
        ...media,
        filename: 'second.jpg',
        location: { type: 'external', url: 'https://media.example/second.jpg' },
      }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'media',
      rows: [media, { ...media, external_id: 91 }],
    }).success).toBe(false);
  });

  it('accepts bounded target-aware comments and rejects duplicate IDs', () => {
    const comment = {
      public_id: 501,
      target_type: 'page',
      target_public_id: 21,
      parent_public_id: null,
      author_name: 'Reader',
      author_email: '',
      content_text: 'Historical comment',
      status: 'approved',
      created_at_iso: '2026-07-01T00:00:00Z',
    };
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'comments', rows: [comment],
    }).success).toBe(true);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'comments', rows: [comment, comment],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'comments',
      rows: Array.from(
        { length: WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS + 1 },
        (_, index) => ({ ...comment, public_id: index + 1 }),
      ),
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'comments', rows: [{ ...comment, author_email: 'not-email' }],
    }).success).toBe(false);
  });

  it('accepts closed deterministic Menu aggregates and validates their tree', () => {
    const item = {
      id: '0'.repeat(31) + '1',
      title: 'Imported Post',
      link: { kind: 'post' as const, public_id: 13261 },
      target: '_self' as const,
      children: [],
    };
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'menus',
      rows: [{ menu_id: 'primary', name: 'Primary', items: [item] }],
    }).success).toBe(true);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'menus',
      rows: [{
        menu_id: 'primary',
        name: 'Primary',
        items: [{ ...item, children: [{ ...item }] }],
      }],
    }).success).toBe(false);
    expect(wxrCoreImportChunkRequestSchema.safeParse({
      phase: 'menus',
      rows: [{
        menu_id: 'primary',
        name: 'Primary',
        items: [{ ...item, link: { kind: 'post', reference_id: 'f'.repeat(32) } }],
      }],
    }).success).toBe(false);
  });

  it('rejects inconsistent result accounting', () => {
    expect(wxrCoreImportChunkSuccessSchema.safeParse({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
      },
    }).success).toBe(true);
    expect(wxrCoreImportChunkSuccessSchema.safeParse({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 1,
        failures: [],
      },
    }).success).toBe(false);
  });

  it('requires complete closed General and Routing documents for finalization', () => {
    const request = {
      general_settings: {
        settings: {
          title: 'Imported site',
          description: '',
          url: 'https://example.com',
          locale: 'en-US',
          timezone: 'UTC',
        },
        expected_revision: '1'.repeat(32),
      },
      routing_settings: {
        settings: materializeRoutingSettingsDefaults(),
        expected_revision: '2'.repeat(32),
      },
    };
    expect(wxrImportSettingsFinalizeRequestSchema.safeParse(request).success)
      .toBe(true);
    expect(wxrImportSettingsFinalizeRequestSchema.safeParse({
      ...request,
      routing_settings: {
        ...request.routing_settings,
        settings: {
          ...request.routing_settings.settings,
          unexpected: true,
        },
      },
    }).success).toBe(false);
    expect(wxrImportSettingsFinalizeRequestSchema.safeParse({
      general_settings: request.general_settings,
    }).success).toBe(false);
  });
});
