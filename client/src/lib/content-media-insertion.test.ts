import { describe, expect, it } from 'vitest';
import type { Media } from '../../../contracts/media';
import {
  contentMediaSource,
  createContentMediaSnippet,
  insertTextAtSelection,
} from './content-media-insertion';

const baseMedia = {
  id: '1'.repeat(32),
  kind: 'image' as const,
  filename: 'hero [large].jpg',
  mime_type: 'image/jpeg',
  location: {
    type: 'external' as const,
    url: 'https://media.example/uploads/hero.jpg?size=large&fit=cover',
  },
  size_bytes: 1024,
  width: 1600,
  height: 900,
  duration_ms: null,
  alt: 'Hero [launch] & "news"',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: '2'.repeat(32),
  created_at_iso: '2026-08-04T01:00:00.000Z',
  updated_at_iso: '2026-08-04T01:00:00.000Z',
} satisfies Media;

function asKind(
  kind: Media['kind'],
  fields: Partial<Media> = {},
): Media {
  return { ...baseMedia, kind, alt: kind === 'image' ? baseMedia.alt : '', ...fields };
}

describe('content Media insertion', () => {
  it('keeps external sources absolute and R2 sources host-independent', () => {
    expect(contentMediaSource(baseMedia)).toBe(
      'https://media.example/uploads/hero.jpg?size=large&fit=cover',
    );
    expect(contentMediaSource(asKind('document', {
      location: { type: 'r2', key: 'uploads/2026/08/guide.pdf' },
    }))).toBe('/__zeropress_media__/uploads/2026/08/guide.pdf');
  });

  it('creates image and attachment Markdown without exposing syntax', () => {
    expect(createContentMediaSnippet(baseMedia, 'markdown')).toBe(
      '![Hero \\[launch\\] & "news"](<https://media.example/uploads/hero.jpg?size=large&fit=cover>)',
    );
    expect(createContentMediaSnippet(asKind('document', {
      filename: 'Guide [PDF].pdf',
    }), 'markdown')).toBe(
      '[Guide \\[PDF\\].pdf](<https://media.example/uploads/hero.jpg?size=large&fit=cover>)',
    );
  });

  it('creates safe type-specific HTML', () => {
    expect(createContentMediaSnippet(baseMedia, 'html')).toBe(
      '<img src="https://media.example/uploads/hero.jpg?size=large&amp;fit=cover" alt="Hero [launch] &amp; &quot;news&quot;" width="1600" height="900" loading="lazy" decoding="async">',
    );
    expect(createContentMediaSnippet(asKind('video', {
      width: 1920,
      height: 1080,
      duration_ms: 30_000,
    }), 'html')).toContain(
      '<video controls preload="metadata" src="https://media.example/uploads/hero.jpg?size=large&amp;fit=cover" width="1920" height="1080"></video>',
    );
    expect(createContentMediaSnippet(asKind('audio', {
      width: null,
      height: null,
      duration_ms: 30_000,
    }), 'html')).toContain('<audio controls preload="metadata"');
    expect(createContentMediaSnippet(asKind('archive', {
      filename: 'Release & notes.zip',
      width: null,
      height: null,
    }), 'html')).toContain('>Release &amp; notes.zip</a>');
  });

  it('uses a bare source in plain text and replaces the selected range exactly', () => {
    const source = createContentMediaSnippet(baseMedia, 'plaintext');
    expect(source).toBe(baseMedia.location.url);
    expect(insertTextAtSelection({
      value: 'Before replace after',
      insertion: source,
      selectionStart: 7,
      selectionEnd: 14,
    })).toEqual({
      value: `Before ${source} after`,
      cursor: 7 + source.length,
    });
  });
});
