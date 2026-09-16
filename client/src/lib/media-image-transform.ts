import {
  MEDIA_IMAGE_EDITOR_MAX_DIMENSION,
  MEDIA_IMAGE_EDITOR_MAX_PIXELS,
  type MediaImageEditorOutputMimeType,
} from '../../../contracts/media-image-editor';

export type MediaImageEditorRotation = 0 | 90 | 180 | 270;

export type MediaImageFilterSettings = {
  brightness: number;
  contrast: number;
  saturation: number;
  grayscale: number;
  sepia: number;
  hueRotate: number;
  blur: number;
  vignette: number;
  sharpen: number;
};

export type MediaImageTransformRecipe = {
  crop: { x: number; y: number; width: number; height: number };
  rotation: MediaImageEditorRotation;
  flipHorizontal: boolean;
  flipVertical: boolean;
  outputWidth: number;
  outputHeight: number;
} & MediaImageFilterSettings;

export type MediaImageRenderWorkerRequest = {
  blob: Blob;
  recipe: MediaImageTransformRecipe;
  outputMimeType: MediaImageEditorOutputMimeType;
  quality: number;
};

export function createMediaImageRenderWorkerRequest(
  input: MediaImageRenderWorkerRequest & {
    onProgress?: (progress: number) => void;
  },
): MediaImageRenderWorkerRequest {
  return {
    blob: input.blob,
    recipe: input.recipe,
    outputMimeType: input.outputMimeType,
    quality: input.quality,
  };
}

export const MEDIA_IMAGE_DEFAULT_FILTERS: Readonly<MediaImageFilterSettings> = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  grayscale: 0,
  sepia: 0,
  hueRotate: 0,
  blur: 0,
  vignette: 0,
  sharpen: 0,
};

export type MediaImageFilterPreset = MediaImageFilterSettings & {
  id: 'normal' | 'vivid' | 'sepia' | 'vintage' | 'cool' | 'warm' | 'dramatic' | 'bw' | 'fade';
};

function filterPreset(
  id: MediaImageFilterPreset['id'],
  values: Partial<MediaImageFilterSettings>,
): MediaImageFilterPreset {
  return { id, ...MEDIA_IMAGE_DEFAULT_FILTERS, ...values };
}

export const MEDIA_IMAGE_FILTER_PRESETS: readonly MediaImageFilterPreset[] = [
  filterPreset('normal', {}),
  filterPreset('vivid', {
    brightness: 105,
    contrast: 115,
    saturation: 130,
  }),
  filterPreset('sepia', {
    saturation: 50,
    sepia: 80,
  }),
  filterPreset('vintage', {
    brightness: 110,
    contrast: 85,
    saturation: 70,
    sepia: 30,
    hueRotate: -10,
  }),
  filterPreset('cool', {
    contrast: 105,
    saturation: 90,
    hueRotate: 180,
  }),
  filterPreset('warm', {
    brightness: 105,
    saturation: 110,
    sepia: 20,
    hueRotate: -15,
  }),
  filterPreset('dramatic', {
    brightness: 90,
    contrast: 140,
    saturation: 80,
  }),
  filterPreset('bw', {
    contrast: 110,
    saturation: 0,
  }),
  filterPreset('fade', {
    brightness: 115,
    contrast: 80,
    saturation: 80,
    sepia: 10,
  }),
];

export function outputDimensionsForCrop(input: {
  cropWidth: number;
  cropHeight: number;
  rotation: MediaImageEditorRotation;
  maximumWidth?: number;
  maximumHeight?: number;
}) {
  const rotated = input.rotation === 90 || input.rotation === 270;
  const naturalWidth = rotated ? input.cropHeight : input.cropWidth;
  const naturalHeight = rotated ? input.cropWidth : input.cropHeight;
  const limit = Math.min(
    1,
    (input.maximumWidth ?? naturalWidth) / naturalWidth,
    (input.maximumHeight ?? naturalHeight) / naturalHeight,
  );
  return {
    width: Math.max(1, Math.round(naturalWidth * limit)),
    height: Math.max(1, Math.round(naturalHeight * limit)),
  };
}

export function validateMediaImageTransformRecipe(
  recipe: MediaImageTransformRecipe,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  const values = [
    recipe.crop.x,
    recipe.crop.y,
    recipe.crop.width,
    recipe.crop.height,
    recipe.outputWidth,
    recipe.outputHeight,
    recipe.brightness,
    recipe.contrast,
    recipe.saturation,
    recipe.grayscale,
    recipe.sepia,
    recipe.hueRotate,
    recipe.blur,
    recipe.vignette,
    recipe.sharpen,
  ];
  return values.every(Number.isFinite)
    && recipe.crop.x >= 0
    && recipe.crop.y >= 0
    && recipe.crop.width >= 1
    && recipe.crop.height >= 1
    && recipe.crop.x + recipe.crop.width <= sourceWidth
    && recipe.crop.y + recipe.crop.height <= sourceHeight
    && Number.isInteger(recipe.outputWidth)
    && Number.isInteger(recipe.outputHeight)
    && recipe.outputWidth >= 1
    && recipe.outputHeight >= 1
    && recipe.outputWidth <= MEDIA_IMAGE_EDITOR_MAX_DIMENSION
    && recipe.outputHeight <= MEDIA_IMAGE_EDITOR_MAX_DIMENSION
    && recipe.outputWidth * recipe.outputHeight <= MEDIA_IMAGE_EDITOR_MAX_PIXELS
    && [0, 90, 180, 270].includes(recipe.rotation)
    && [recipe.brightness, recipe.contrast, recipe.saturation]
      .every((value) => value >= 0 && value <= 200)
    && [recipe.grayscale, recipe.sepia]
      .every((value) => value >= 0 && value <= 100)
    && recipe.hueRotate >= -180
    && recipe.hueRotate <= 180
    && recipe.blur >= 0
    && recipe.blur <= 20
    && recipe.vignette >= 0
    && recipe.vignette <= 100
    && recipe.sharpen >= 0
    && recipe.sharpen <= 100;
}

function clampedChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Applies a real cross-kernel sharpen while retaining only a bounded stripe
 * plus one original source row. This avoids allocating a second full-size
 * 25-megapixel pixel buffer and keeps later stripes independent from already
 * sharpened output.
 */
export function applyMediaImageSharpen(input: {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
  strength: number;
  onProgress?: (completedRows: number, totalRows: number) => void;
}) {
  if (input.strength <= 0 || input.width < 1 || input.height < 1) return;
  const amount = (input.strength / 100) * 0.6;
  const rowBytes = input.width * 4;
  const stripeRows = 128;
  let previousOriginalRow: Uint8ClampedArray | null = null;

  for (let y = 0; y < input.height; y += stripeRows) {
    const rows = Math.min(stripeRows, input.height - y);
    const readableRows = Math.min(rows + 1, input.height - y);
    const source = input.context.getImageData(0, y, input.width, readableRows);
    const output = input.context.createImageData(input.width, rows);
    const lastRowStart = (rows - 1) * rowBytes;
    const nextPreviousOriginalRow = source.data.slice(
      lastRowStart,
      lastRowStart + rowBytes,
    );

    for (let localY = 0; localY < rows; localY += 1) {
      const currentRow = localY * rowBytes;
      const previousRow = localY > 0
        ? currentRow - rowBytes
        : previousOriginalRow === null ? currentRow : -1;
      const nextRow = localY + 1 < readableRows
        ? currentRow + rowBytes
        : currentRow;

      for (let x = 0; x < input.width; x += 1) {
        const current = currentRow + x * 4;
        const left = currentRow + Math.max(0, x - 1) * 4;
        const right = currentRow + Math.min(input.width - 1, x + 1) * 4;
        const up = previousRow === -1 ? x * 4 : previousRow + x * 4;
        const down = nextRow + x * 4;
        const currentAlpha = source.data[current + 3]!;
        if (currentAlpha < 255) {
          output.data[current] = source.data[current]!;
          output.data[current + 1] = source.data[current + 1]!;
          output.data[current + 2] = source.data[current + 2]!;
          output.data[current + 3] = currentAlpha;
          continue;
        }
        for (let channel = 0; channel < 3; channel += 1) {
          const currentValue = source.data[current + channel]!;
          const previousAlpha = previousRow === -1
            ? previousOriginalRow![x * 4 + 3]!
            : source.data[up + 3]!;
          const previousValue = previousRow === -1
            ? previousOriginalRow![x * 4 + channel]!
            : source.data[up + channel]!;
          output.data[current + channel] = clampedChannel(
            currentValue * (1 + 4 * amount)
            - amount * (
              (source.data[left + 3] === 0
                ? currentValue
                : source.data[left + channel]!)
              + (source.data[right + 3] === 0
                ? currentValue
                : source.data[right + channel]!)
              + (previousAlpha === 0 ? currentValue : previousValue)
              + (source.data[down + 3] === 0
                ? currentValue
                : source.data[down + channel]!)
            ),
          );
        }
        output.data[current + 3] = currentAlpha;
      }
    }

    previousOriginalRow = nextPreviousOriginalRow;
    input.context.putImageData(output, 0, y);
    input.onProgress?.(y + rows, input.height);
  }
}

export function applyMediaImageVignette(input: {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
  strength: number;
}) {
  if (input.strength <= 0 || input.width < 1 || input.height < 1) return;
  const centerX = input.width / 2;
  const centerY = input.height / 2;
  const outerRadius = Math.hypot(centerX, centerY);
  const innerRadius = Math.min(input.width, input.height) * 0.28;
  const opacity = (input.strength / 100) * 0.85;
  const gradient = input.context.createRadialGradient(
    centerX,
    centerY,
    innerRadius,
    centerX,
    centerY,
    outerRadius,
  );
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(0.62, `rgba(0, 0, 0, ${opacity * 0.16})`);
  gradient.addColorStop(1, `rgba(0, 0, 0, ${opacity})`);
  input.context.save();
  input.context.filter = 'none';
  input.context.globalCompositeOperation = 'source-atop';
  input.context.fillStyle = gradient;
  input.context.fillRect(0, 0, input.width, input.height);
  input.context.restore();
}

export function drawMediaImage(input: {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  source: CanvasImageSource;
  recipe: MediaImageTransformRecipe;
  targetWidth: number;
  targetHeight: number;
  outputMimeType: MediaImageEditorOutputMimeType;
  onSharpenProgress?: (completedRows: number, totalRows: number) => void;
}) {
  const { context, recipe, targetWidth, targetHeight } = input;
  const previewScale = Math.min(
    targetWidth / recipe.outputWidth,
    targetHeight / recipe.outputHeight,
  );
  context.save();
  context.clearRect(0, 0, targetWidth, targetHeight);
  if (input.outputMimeType === 'image/jpeg') {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, targetWidth, targetHeight);
  }
  context.filter = [
    `brightness(${recipe.brightness}%)`,
    `contrast(${recipe.contrast}%)`,
    `saturate(${recipe.saturation}%)`,
    `grayscale(${recipe.grayscale}%)`,
    `sepia(${recipe.sepia}%)`,
    `hue-rotate(${recipe.hueRotate}deg)`,
    `blur(${recipe.blur * previewScale}px)`,
  ].join(' ');
  context.translate(targetWidth / 2, targetHeight / 2);
  context.scale(recipe.flipHorizontal ? -1 : 1, recipe.flipVertical ? -1 : 1);
  context.rotate((recipe.rotation * Math.PI) / 180);
  const rotated = recipe.rotation === 90 || recipe.rotation === 270;
  const drawWidth = rotated ? targetHeight : targetWidth;
  const drawHeight = rotated ? targetWidth : targetHeight;
  context.drawImage(
    input.source,
    recipe.crop.x,
    recipe.crop.y,
    recipe.crop.width,
    recipe.crop.height,
    -drawWidth / 2,
    -drawHeight / 2,
    drawWidth,
    drawHeight,
  );
  context.restore();
  applyMediaImageSharpen({
    context,
    width: targetWidth,
    height: targetHeight,
    strength: recipe.sharpen,
    onProgress: input.onSharpenProgress,
  });
  applyMediaImageVignette({
    context,
    width: targetWidth,
    height: targetHeight,
    strength: recipe.vignette,
  });
}

export function editedMediaFilename(
  original: string,
  mimeType: MediaImageEditorOutputMimeType,
): string {
  const extension = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'image/png' ? 'png' : 'webp';
  const base = original.replace(/\.[^.]+$/u, '').trim() || 'image';
  return `${Array.from(base).slice(0, 240).join('')}-edited.${extension}`;
}
