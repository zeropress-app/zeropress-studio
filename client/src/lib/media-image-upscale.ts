import {
  MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
  MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE,
  MEDIA_IMAGE_UPSCALE_TILE_OVERLAP,
  MEDIA_IMAGE_UPSCALE_TILE_SIZE,
  mediaImageUpscaleTileCount,
  type MediaImageUpscaleScale,
} from '../../../contracts/media-image-upscale';
import type { MediaImageEditorOutputMimeType } from '../../../contracts/media-image-editor';
import { MEDIA_FILENAME_MAX_CODE_POINTS } from '../../../contracts/media';

export const MEDIA_IMAGE_UPSCALE_MODEL = Object.freeze({
  artifactId: 'realesr-general-x4v3-tile64-fp16',
  revision: 'af572faa22679a75',
  modelUrl: '/image-models/realesr-general-x4v3-tile64-fp16/af572faa22679a75/model.json',
  manifestUrl: '/image-models/realesr-general-x4v3-tile64-fp16/af572faa22679a75/artifact-manifest.json',
});

export type MediaImageUpscaleErrorCode =
  | 'DECODE_FAILED'
  | 'SOURCE_DIMENSION_MISMATCH'
  | 'WEBGL_UNAVAILABLE'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_INVALID'
  | 'INFERENCE_FAILED'
  | 'ENCODE_FAILED'
  | 'OUTPUT_TOO_LARGE'
  | 'ALPHA_JPEG_UNSUPPORTED';

export class MediaImageUpscaleError extends Error {
  readonly code: MediaImageUpscaleErrorCode;

  constructor(code: MediaImageUpscaleErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'MediaImageUpscaleError';
    this.code = code;
  }
}

export type MediaImageUpscaleProgress =
  | { stage: 'preparing' }
  | { stage: 'loading_model'; progress: number }
  | { stage: 'processing'; completed: number; total: number }
  | { stage: 'encoding' };

type ModelTensorDescriptor = {
  shape?: readonly (number | null)[];
};

function isExpectedModelShape(
  shape: readonly (number | null)[] | undefined,
  expected: readonly number[],
): boolean {
  return shape !== undefined
    && shape.length === expected.length
    && shape.every((value, index) => value === expected[index]);
}

/**
 * TensorFlow.js derives GraphModel output metadata from the terminal graph
 * node. Converted SavedModels commonly terminate in an Identity node without
 * a `shape` attribute even though their SignatureDef contains the fixed output
 * shape. Keep the declared input strict, accept only an absent or exact output
 * descriptor, and validate every produced tensor separately after inference.
 */
export function isMediaImageUpscaleModelDescriptorCompatible(input: {
  inputs: readonly ModelTensorDescriptor[];
  outputs: readonly ModelTensorDescriptor[];
}): boolean {
  if (input.inputs.length !== 1 || input.outputs.length !== 1) return false;
  if (!isExpectedModelShape(input.inputs[0]?.shape, [1, 64, 64, 3])) {
    return false;
  }
  const outputShape = input.outputs[0]?.shape;
  return outputShape === undefined
    || isExpectedModelShape(outputShape, [1, 256, 256, 3]);
}

export type MediaImageUpscaleTile = {
  coreX: number;
  coreY: number;
  coreWidth: number;
  coreHeight: number;
  inputX: number;
  inputY: number;
};

const TILE_PADDING = MEDIA_IMAGE_UPSCALE_TILE_OVERLAP / 2;

export function createMediaImageUpscaleTilePlan(
  width: number,
  height: number,
): MediaImageUpscaleTile[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('Upscale source dimensions must be positive integers.');
  }
  const tiles: MediaImageUpscaleTile[] = [];
  for (let coreY = 0; coreY < height; coreY += MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE) {
    for (let coreX = 0; coreX < width; coreX += MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE) {
      tiles.push({
        coreX,
        coreY,
        coreWidth: Math.min(MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE, width - coreX),
        coreHeight: Math.min(MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE, height - coreY),
        inputX: coreX - TILE_PADDING,
        inputY: coreY - TILE_PADDING,
      });
    }
  }
  if (tiles.length !== mediaImageUpscaleTileCount(width, height)) {
    throw new Error('Upscale tile planning drifted from the shared contract.');
  }
  return tiles;
}

export function reflectMediaImageCoordinate(index: number, size: number): number {
  if (!Number.isInteger(index) || !Number.isInteger(size) || size < 1) {
    throw new TypeError('Reflection coordinates require integer input and a positive size.');
  }
  if (size === 1) return 0;
  const period = (size - 1) * 2;
  const normalized = ((index % period) + period) % period;
  return normalized < size ? normalized : period - normalized;
}

export function createMediaImageUpscaleTileInput(input: {
  source: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
  tile: MediaImageUpscaleTile;
}): Float32Array {
  if (input.source.length !== input.sourceWidth * input.sourceHeight * 4) {
    throw new TypeError('Upscale source pixels do not match their dimensions.');
  }
  const values = new Float32Array(
    MEDIA_IMAGE_UPSCALE_TILE_SIZE * MEDIA_IMAGE_UPSCALE_TILE_SIZE * 3,
  );
  let target = 0;
  for (let y = 0; y < MEDIA_IMAGE_UPSCALE_TILE_SIZE; y += 1) {
    const sourceY = reflectMediaImageCoordinate(input.tile.inputY + y, input.sourceHeight);
    for (let x = 0; x < MEDIA_IMAGE_UPSCALE_TILE_SIZE; x += 1) {
      const sourceX = reflectMediaImageCoordinate(input.tile.inputX + x, input.sourceWidth);
      const sourceIndex = (sourceY * input.sourceWidth + sourceX) * 4;
      values[target] = input.source[sourceIndex]! / 255;
      values[target + 1] = input.source[sourceIndex + 1]! / 255;
      values[target + 2] = input.source[sourceIndex + 2]! / 255;
      target += 3;
    }
  }
  return values;
}

export function mediaImageUpscaleModelCrop(tile: MediaImageUpscaleTile) {
  return {
    x: TILE_PADDING * MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
    y: TILE_PADDING * MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
    width: tile.coreWidth * MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
    height: tile.coreHeight * MEDIA_IMAGE_UPSCALE_MODEL_SCALE,
  };
}

export function mediaImageUpscaleOutputRect(
  tile: MediaImageUpscaleTile,
  scale: MediaImageUpscaleScale,
) {
  return {
    x: tile.coreX * scale,
    y: tile.coreY * scale,
    width: tile.coreWidth * scale,
    height: tile.coreHeight * scale,
  };
}

const OUTPUT_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const satisfies Record<MediaImageEditorOutputMimeType, string>;

export function upscaledMediaFilename(
  filename: string,
  outputMimeType: MediaImageEditorOutputMimeType,
  scale: MediaImageUpscaleScale,
): string {
  const dot = filename.lastIndexOf('.');
  const sourceBase = (dot > 0 ? filename.slice(0, dot) : filename).trim()
    || 'image';
  const suffix = `-upscaled-${scale}x.${OUTPUT_EXTENSION[outputMimeType]}`;
  const base = Array.from(sourceBase)
    .slice(0, MEDIA_FILENAME_MAX_CODE_POINTS - Array.from(suffix).length)
    .join('');
  return `${base}${suffix}`;
}
