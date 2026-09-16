import { describe, expect, it } from 'vitest';
import {
  createMediaImageUpscaleTileInput,
  createMediaImageUpscaleTilePlan,
  isMediaImageUpscaleModelDescriptorCompatible,
  mediaImageUpscaleModelCrop,
  mediaImageUpscaleOutputRect,
  reflectMediaImageCoordinate,
  upscaledMediaFilename,
} from './media-image-upscale';

describe('Media image upscale tiling', () => {
  it('accepts a converted Identity output with deferred shape metadata', () => {
    expect(isMediaImageUpscaleModelDescriptorCompatible({
      inputs: [{ shape: [1, 64, 64, 3] }],
      outputs: [{ shape: undefined }],
    })).toBe(true);
    expect(isMediaImageUpscaleModelDescriptorCompatible({
      inputs: [{ shape: [1, 64, 64, 3] }],
      outputs: [{ shape: [1, 256, 256, 3] }],
    })).toBe(true);
    expect(isMediaImageUpscaleModelDescriptorCompatible({
      inputs: [{ shape: [1, 64, 64, 3] }],
      outputs: [{ shape: [1, 128, 128, 3] }],
    })).toBe(false);
    expect(isMediaImageUpscaleModelDescriptorCompatible({
      inputs: [{ shape: [1, null, null, 3] }],
      outputs: [{ shape: undefined }],
    })).toBe(false);
  });

  it('plans bounded 52px cores with six reflected context pixels per side', () => {
    const plan = createMediaImageUpscaleTilePlan(53, 54);
    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({
      coreX: 0,
      coreY: 0,
      coreWidth: 52,
      coreHeight: 52,
      inputX: -6,
      inputY: -6,
    });
    expect(plan[3]).toEqual({
      coreX: 52,
      coreY: 52,
      coreWidth: 1,
      coreHeight: 2,
      inputX: 46,
      inputY: 46,
    });
    expect(mediaImageUpscaleModelCrop(plan[3]!)).toEqual({
      x: 24,
      y: 24,
      width: 4,
      height: 8,
    });
    expect(mediaImageUpscaleOutputRect(plan[3]!, 2)).toEqual({
      x: 104,
      y: 104,
      width: 2,
      height: 4,
    });
  });

  it('reflects edge pixels without repeating the boundary sample', () => {
    expect([-3, -2, -1, 0, 1, 2, 3, 4, 5].map((index) => (
      reflectMediaImageCoordinate(index, 3)
    ))).toEqual([1, 2, 1, 0, 1, 2, 1, 0, 1]);
    expect(reflectMediaImageCoordinate(-20, 1)).toBe(0);
  });

  it('projects reflected RGBA source pixels to normalized RGB model input', () => {
    const source = new Uint8ClampedArray([
      255, 0, 0, 20,
      0, 255, 0, 40,
    ]);
    const tile = createMediaImageUpscaleTilePlan(2, 1)[0]!;
    const values = createMediaImageUpscaleTileInput({
      source,
      sourceWidth: 2,
      sourceHeight: 1,
      tile,
    });
    expect(Array.from(values.slice(0, 6))).toEqual([1, 0, 0, 0, 1, 0]);
    expect(values).toHaveLength(64 * 64 * 3);
  });

  it('creates deterministic scale- and format-specific filenames', () => {
    expect(upscaledMediaFilename('wallpaper.original.png', 'image/webp', 2))
      .toBe('wallpaper.original-upscaled-2x.webp');
    expect(upscaledMediaFilename('photo', 'image/jpeg', 4))
      .toBe('photo-upscaled-4x.jpg');
    expect(Array.from(upscaledMediaFilename(`${'한'.repeat(255)}.png`, 'image/png', 2)))
      .toHaveLength(255);
  });
});
