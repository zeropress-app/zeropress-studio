import {
  isDeletableR2MediaStorageKey,
  type Media,
} from './media';
import { isMediaImageEditorMimeType } from './media-image-editor';

export const MEDIA_IMAGE_UPSCALE_MODEL_SCALE = 4;
export const MEDIA_IMAGE_UPSCALE_TILE_SIZE = 64;
export const MEDIA_IMAGE_UPSCALE_TILE_OVERLAP = 12;
export const MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE =
  MEDIA_IMAGE_UPSCALE_TILE_SIZE - MEDIA_IMAGE_UPSCALE_TILE_OVERLAP;
export const MEDIA_IMAGE_UPSCALE_MAX_TILE_COUNT = 1_600;
export const MEDIA_IMAGE_UPSCALE_MAX_OUTPUT_DIMENSION = 4_096;
export const MEDIA_IMAGE_UPSCALE_MAX_OUTPUT_PIXELS = 16_777_216;

export const MEDIA_IMAGE_UPSCALE_SCALES = [2, 4] as const;
export type MediaImageUpscaleScale =
  (typeof MEDIA_IMAGE_UPSCALE_SCALES)[number];

export const MEDIA_IMAGE_UPSCALE_LIMITS = Object.freeze({
  2: Object.freeze({
    maxInputDimension: 2_000,
    maxInputPixels: 4_000_000,
  }),
  4: Object.freeze({
    maxInputDimension: 1_024,
    maxInputPixels: 1_048_576,
  }),
}) satisfies Record<MediaImageUpscaleScale, {
  maxInputDimension: number;
  maxInputPixels: number;
}>;

export function mediaImageUpscaleTileCount(
  width: number,
  height: number,
): number {
  return Math.ceil(width / MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE)
    * Math.ceil(height / MEDIA_IMAGE_UPSCALE_TILE_CORE_SIZE);
}

export function isMediaImageUpscaleDimensioned(
  input: { width: number | null; height: number | null },
  scale: MediaImageUpscaleScale,
): input is { width: number; height: number } {
  if (
    input.width === null
    || input.height === null
    || !Number.isInteger(input.width)
    || !Number.isInteger(input.height)
    || input.width < 1
    || input.height < 1
  ) return false;

  const limits = MEDIA_IMAGE_UPSCALE_LIMITS[scale];
  const outputWidth = input.width * scale;
  const outputHeight = input.height * scale;
  return input.width <= limits.maxInputDimension
    && input.height <= limits.maxInputDimension
    && input.width * input.height <= limits.maxInputPixels
    && outputWidth <= MEDIA_IMAGE_UPSCALE_MAX_OUTPUT_DIMENSION
    && outputHeight <= MEDIA_IMAGE_UPSCALE_MAX_OUTPUT_DIMENSION
    && outputWidth * outputHeight <= MEDIA_IMAGE_UPSCALE_MAX_OUTPUT_PIXELS
    && mediaImageUpscaleTileCount(input.width, input.height)
      <= MEDIA_IMAGE_UPSCALE_MAX_TILE_COUNT;
}

/**
 * Upscaling is deliberately limited to bounded raster bytes that Studio can
 * read from an owned R2 namespace. The original object is never overwritten.
 */
export function isMediaImageUpscalable(
  media: Pick<Media, 'kind' | 'mime_type' | 'location' | 'width' | 'height'>,
): boolean {
  return media.kind === 'image'
    && isMediaImageEditorMimeType(media.mime_type)
    && media.location.type === 'r2'
    && isDeletableR2MediaStorageKey(media.location.key)
    && isMediaImageUpscaleDimensioned(media, 2);
}
