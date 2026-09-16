import { describe, expect, it } from 'vitest';
import {
  MEDIA_IMAGE_UPSCALE_MAX_TILE_COUNT,
  isMediaImageUpscalable,
  isMediaImageUpscaleDimensioned,
  mediaImageUpscaleTileCount,
} from './media-image-upscale';

describe('Media image upscale contract', () => {
  it('supports the reviewed 2x 2000px and 4x 1024px boundaries', () => {
    expect(isMediaImageUpscaleDimensioned({ width: 2_000, height: 2_000 }, 2))
      .toBe(true);
    expect(isMediaImageUpscaleDimensioned({ width: 1_920, height: 1_080 }, 2))
      .toBe(true);
    expect(isMediaImageUpscaleDimensioned({ width: 2_001, height: 1_000 }, 2))
      .toBe(false);
    expect(isMediaImageUpscaleDimensioned({ width: 1_024, height: 1_024 }, 4))
      .toBe(true);
    expect(isMediaImageUpscaleDimensioned({ width: 1_025, height: 1_000 }, 4))
      .toBe(false);
    expect(isMediaImageUpscaleDimensioned({ width: 1_920, height: 1_080 }, 4))
      .toBe(false);
  });

  it('keeps the exact tile budget for square and 1080p inputs', () => {
    expect(mediaImageUpscaleTileCount(1_024, 1_024)).toBe(400);
    expect(mediaImageUpscaleTileCount(1_920, 1_080)).toBe(777);
    expect(mediaImageUpscaleTileCount(2_000, 2_000))
      .toBe(1_521);
    expect(mediaImageUpscaleTileCount(2_000, 2_000))
      .toBeLessThanOrEqual(MEDIA_IMAGE_UPSCALE_MAX_TILE_COUNT);
  });

  it('accepts only dimensioned managed JPEG, PNG, or WebP sources', () => {
    const source = {
      kind: 'image' as const,
      mime_type: 'image/png',
      location: { type: 'r2' as const, key: 'uploads/2026/08/image.png' },
      width: 2_000,
      height: 2_000,
    };
    expect(isMediaImageUpscalable(source)).toBe(true);
    expect(isMediaImageUpscalable({
      ...source,
      location: { type: 'external', url: 'https://media.example/image.png' },
    })).toBe(false);
    expect(isMediaImageUpscalable({ ...source, mime_type: 'image/svg+xml' }))
      .toBe(false);
    expect(isMediaImageUpscalable({ ...source, width: 2_001 }))
      .toBe(false);
  });
});
