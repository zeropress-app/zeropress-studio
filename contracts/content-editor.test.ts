import { describe, expect, it } from 'vitest';
import {
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS,
  contentEditorFieldsSchema,
} from './content-editor';
import { createPageRequestSchema } from './pages';
import { createPostRequestSchema } from './posts';

const common = {
  title: 'Document',
  slug: 'document',
  content: '<p>Hello</p>',
  document_type: 'html' as const,
  editor_mode: 'visual' as const,
  editor_profile: 'tiptap-v1' as const,
  excerpt: '',
  status: 'draft' as const,
  discoverability: 'default' as const,
  allow_comments: false,
  featured_image_id: null,
};

describe('content editor contract', () => {
  it('keeps editor fields explicit and closed', () => {
    expect(contentEditorFieldsSchema.parse({
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    })).toEqual({ editor_mode: 'visual', editor_profile: 'tiptap-v1' });
    expect(contentEditorFieldsSchema.safeParse({
      editor_mode: 'source',
      editor_profile: null,
      extra: true,
    }).success).toBe(false);
  });

  it('requires visual mode to use bounded HTML and the tiptap-v1 profile', () => {
    const page = { parent_id: null, ...common };
    expect(createPageRequestSchema.safeParse(page).success).toBe(true);
    expect(createPageRequestSchema.safeParse({
      ...page,
      document_type: 'markdown',
    }).success).toBe(false);
    expect(createPageRequestSchema.safeParse({
      ...page,
      editor_profile: null,
    }).success).toBe(false);
    expect(createPageRequestSchema.safeParse({
      ...page,
      content: 'x'.repeat(CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS + 1),
    }).success).toBe(false);
  });

  it('requires source mode to omit the visual profile for every document type', () => {
    const post = {
      ...common,
      document_type: 'markdown' as const,
      editor_mode: 'source' as const,
      editor_profile: null,
      author_id: 'site-author',
      category_ids: [],
      tag_ids: [],
    };
    expect(createPostRequestSchema.safeParse(post).success).toBe(true);
    expect(createPostRequestSchema.safeParse({
      ...post,
      editor_profile: 'tiptap-v1',
    }).success).toBe(false);
  });
});
