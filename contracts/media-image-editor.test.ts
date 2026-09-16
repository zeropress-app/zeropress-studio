import { describe, expect, it } from 'vitest';
import {
  isMediaImageEditable,
  isMediaImageEditorDimensioned,
} from './media-image-editor';

const base = {
  kind: 'image' as const,
  mime_type: 'image/png',
  location: { type: 'r2' as const, key: 'uploads/2026/08/image.png' },
  width: 1600,
  height: 900,
};

describe('Media image editor contract', () => {
  it('accepts bounded managed raster images', () => {
    expect(isMediaImageEditable(base)).toBe(true);
    expect(isMediaImageEditable({
      ...base,
      location: { type: 'r2', key: 'imported/2026/08/image.webp' },
      mime_type: 'image/webp',
    })).toBe(true);
  });

  it('rejects external, vector, arbitrary-key, and oversized images', () => {
    expect(isMediaImageEditable({
      ...base,
      location: { type: 'external', url: 'https://media.example/image.png' },
    })).toBe(false);
    expect(isMediaImageEditable({ ...base, mime_type: 'image/svg+xml' })).toBe(false);
    expect(isMediaImageEditable({
      ...base,
      location: { type: 'r2', key: 'private/image.png' },
    })).toBe(false);
    expect(isMediaImageEditorDimensioned({ width: 8192, height: 8192 }))
      .toBe(false);
  });
});
