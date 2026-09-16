import { describe, expect, it } from 'vitest';
import type { Media, MediaDelivery } from '../../../contracts/media';
import { resolveMediaPreviewUrl } from './media-preview';

const delivery: MediaDelivery = {
  media_origin: '',
  r2_preview_available: true,
};

function svgMedia(storageKey: string): Media {
  return {
    id: '1'.repeat(32),
    kind: 'image',
    filename: 'mark.svg',
    mime_type: 'image/svg+xml',
    location: { type: 'r2', key: storageKey },
    size_bytes: 256,
    width: 64,
    height: 64,
    duration_ms: null,
    alt: 'Mark',
    collection: null,
    usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
    revision: '2'.repeat(32),
    created_at_iso: '2026-08-19T00:00:00.000Z',
    updated_at_iso: '2026-08-19T00:00:00.000Z',
  };
}

describe('Media preview URL resolution', () => {
  it('uses private preview only for Studio-sanitized native SVG objects', () => {
    expect(resolveMediaPreviewUrl(
      svgMedia('uploads/2026/08/11111111111111111111111111111111.svg'),
      delivery,
    )).toBe(`/api/media/${'1'.repeat(32)}/preview?revision=${'2'.repeat(32)}`);
    expect(resolveMediaPreviewUrl(
      svgMedia('imported/2026/08/mark.svg'),
      delivery,
    )).toBeNull();
  });

  it('uses a configured public origin for imported SVG without implying sanitization', () => {
    expect(resolveMediaPreviewUrl(
      svgMedia('imported/2026/08/mark.svg'),
      { ...delivery, media_origin: 'https://media.example' },
    )).toBe('https://media.example/imported/2026/08/mark.svg');
  });
});
