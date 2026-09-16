import { describe, expect, it } from 'vitest';
import {
  MEDIA_IMAGE_DEFAULT_FILTERS,
  MEDIA_IMAGE_FILTER_PRESETS,
  applyMediaImageSharpen,
  createMediaImageRenderWorkerRequest,
  drawMediaImage,
  editedMediaFilename,
  outputDimensionsForCrop,
  validateMediaImageTransformRecipe,
  type MediaImageTransformRecipe,
} from './media-image-transform';

const recipe: MediaImageTransformRecipe = {
  crop: { x: 0, y: 0, width: 1600, height: 900 },
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  outputWidth: 1600,
  outputHeight: 900,
  ...MEDIA_IMAGE_DEFAULT_FILTERS,
};

function memoryContext(pixels: Uint8ClampedArray, width: number) {
  return {
    getImageData: (_x: number, y: number, readWidth: number, readHeight: number) => ({
      data: pixels.slice(y * width * 4, (y + readHeight) * readWidth * 4),
    }),
    createImageData: (createWidth: number, createHeight: number) => ({
      data: new Uint8ClampedArray(createWidth * createHeight * 4),
    }),
    putImageData: (image: { data: Uint8ClampedArray }, _x: number, y: number) => {
      pixels.set(image.data, y * width * 4);
    },
  } as unknown as CanvasRenderingContext2D;
}

describe('Media image transform', () => {
  it('validates bounded crop, output, and filter values', () => {
    expect(validateMediaImageTransformRecipe(recipe, 1600, 900)).toBe(true);
    expect(validateMediaImageTransformRecipe({
      ...recipe,
      crop: { ...recipe.crop, width: 1601 },
    }, 1600, 900)).toBe(false);
    expect(validateMediaImageTransformRecipe({
      ...recipe,
      outputWidth: 8192,
      outputHeight: 8192,
    }, 1600, 900)).toBe(false);
    expect(validateMediaImageTransformRecipe({
      ...recipe,
      blur: 21,
    }, 1600, 900)).toBe(false);
    expect(validateMediaImageTransformRecipe({
      ...recipe,
      sharpen: 101,
    }, 1600, 900)).toBe(false);
  });

  it('defines nine complete deterministic filter presets', () => {
    expect(MEDIA_IMAGE_FILTER_PRESETS.map((preset) => preset.id)).toEqual([
      'normal',
      'vivid',
      'sepia',
      'vintage',
      'cool',
      'warm',
      'dramatic',
      'bw',
      'fade',
    ]);
    expect(MEDIA_IMAGE_FILTER_PRESETS[0]).toMatchObject(
      MEDIA_IMAGE_DEFAULT_FILTERS,
    );
  });

  it('keeps main-thread progress callbacks out of the Worker payload', () => {
    const request = createMediaImageRenderWorkerRequest({
      blob: new Blob(['image'], { type: 'image/png' }),
      recipe,
      outputMimeType: 'image/png',
      quality: 0.9,
      onProgress: () => undefined,
    });

    expect(Object.keys(request)).toEqual([
      'blob',
      'recipe',
      'outputMimeType',
      'quality',
    ]);
    expect('onProgress' in request).toBe(false);
    expect(() => structuredClone(request)).not.toThrow();
  });

  it('applies real sharpen pixels while preserving alpha', () => {
    const width = 3;
    const height = 1;
    const pixels = new Uint8ClampedArray([
      10, 10, 10, 127,
      128, 128, 128, 255,
      0, 0, 0, 255,
    ]);
    const context = memoryContext(pixels, width);

    applyMediaImageSharpen({ context, width, height, strength: 100 });

    expect(Array.from(pixels.slice(4, 7))).toEqual([255, 255, 255]);
    expect(pixels[7]).toBe(255);
    expect(Array.from(pixels.slice(0, 4))).toEqual([10, 10, 10, 127]);
  });

  it('keeps sharpen convolution stable across bounded stripe boundaries', () => {
    const width = 1;
    const height = 130;
    const original = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const value = y < 128 ? 40 : 180;
      original.set([value, value, value, 255], y * 4);
    }
    const pixels = original.slice();
    applyMediaImageSharpen({
      context: memoryContext(pixels, width),
      width,
      height,
      strength: 50,
    });

    const amount = 0.3;
    const expected = (y: number) => {
      const current = original[y * 4]!;
      const previous = original[Math.max(0, y - 1) * 4]!;
      const next = original[Math.min(height - 1, y + 1) * 4]!;
      return Math.max(0, Math.min(255, Math.round(
        current * (1 + 2 * amount) - amount * (previous + next),
      )));
    };
    expect(pixels[127 * 4]).toBe(expected(127));
    expect(pixels[128 * 4]).toBe(expected(128));
  });

  it('swaps natural dimensions for quarter-turn rotations', () => {
    expect(outputDimensionsForCrop({
      cropWidth: 1600,
      cropHeight: 900,
      rotation: 90,
    })).toEqual({ width: 900, height: 1600 });
  });

  it('scales blur for the bounded preview while preserving filter semantics', () => {
    let filterAtDraw = '';
    const rawContext = {
      filter: 'none',
      fillStyle: '',
      save: () => undefined,
      restore: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      translate: () => undefined,
      scale: () => undefined,
      rotate: () => undefined,
      drawImage: () => {
        filterAtDraw = rawContext.filter;
      },
    };
    const context = rawContext as unknown as CanvasRenderingContext2D;

    drawMediaImage({
      context,
      source: {} as CanvasImageSource,
      recipe: { ...recipe, blur: 10, hueRotate: 20 },
      targetWidth: 800,
      targetHeight: 450,
      outputMimeType: 'image/png',
    });

    expect(filterAtDraw).toContain('hue-rotate(20deg)');
    expect(filterAtDraw).toContain('blur(5px)');
  });

  it('creates a bounded deterministic edited filename', () => {
    expect(editedMediaFilename('hero.original.png', 'image/webp'))
      .toBe('hero.original-edited.webp');
  });
});
