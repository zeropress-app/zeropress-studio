import { describe, expect, it } from 'vitest';
import {
  createPageRequestSchema,
  pageBulkLifecycleRequestSchema,
  pageBulkLifecycleSuccessSchema,
  pageEffectivePathSchema,
  pageSchema,
  updatePageRequestSchema,
} from './pages';

const authoredPage = {
  parent_id: null,
  title: 'About',
  slug: 'about',
  content: '# About',
  document_type: 'markdown',
  editor_mode: 'source',
  editor_profile: null,
  excerpt: '',
  status: 'draft',
  discoverability: 'default',
  allow_comments: false,
  featured_image_id: null,
} as const;

describe('Page contract', () => {
  it('normalizes authored fields and keeps requests closed', () => {
    expect(createPageRequestSchema.parse({
      ...authoredPage,
      title: '  About  ',
      slug: 'About',
      excerpt: '  Summary  ',
    })).toMatchObject({
      title: 'About',
      slug: 'About',
      excerpt: 'Summary',
      parent_id: null,
      allow_comments: false,
    });
    expect(updatePageRequestSchema.safeParse({
      ...authoredPage,
      expected_revision: 'a'.repeat(32),
      extra: true,
    }).success).toBe(false);
  });

  it('accepts normalized hierarchical paths but rejects unsafe shapes', () => {
    expect(pageEffectivePathSchema.safeParse('docs/v0.7').success).toBe(true);
    for (const value of ['/docs', 'docs/', 'docs//guide', 'docs/../guide']) {
      expect(pageEffectivePathSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires every stored Studio Page to have a public ID and canonical path', () => {
    const page = {
      id: '1'.repeat(32),
      public_id: 100_000_000_001,
      parent: null,
      title: 'About',
      slug: 'about',
      path: 'about',
      content: '',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      excerpt: '',
      status: 'published',
      discoverability: 'default',
      allow_comments: false,
      featured_image: null,
      revision: '2'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    expect(pageSchema.safeParse(page).success).toBe(true);
    expect(pageSchema.safeParse({ ...page, public_id: undefined }).success)
      .toBe(false);
    expect(pageSchema.safeParse({ ...page, path: 'other' }).success).toBe(false);
  });

  it('keeps bounded bulk lifecycle results aligned with Page policy outcomes', () => {
    const id = '1'.repeat(32);
    expect(pageBulkLifecycleRequestSchema.safeParse({
      target_status: 'trash',
      items: [{ id, expected_revision: '2'.repeat(32) }],
    }).success).toBe(true);
    expect(pageBulkLifecycleRequestSchema.safeParse({
      target_status: 'trash',
      items: [
        { id, expected_revision: '2'.repeat(32) },
        { id, expected_revision: '3'.repeat(32) },
      ],
    }).success).toBe(false);
    expect(pageBulkLifecycleSuccessSchema.safeParse({
      success: true,
      data: {
        target_status: 'trash',
        results: [{
          id,
          outcome: 'skipped',
          reason: 'has_children',
        }],
        summary: {
          requested: 1,
          updated: 0,
          unchanged: 0,
          conflict: 0,
          skipped: 1,
        },
      },
    }).success).toBe(true);
  });
});
