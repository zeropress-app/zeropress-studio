import { z } from 'zod';
import {
  isDeletableR2MediaStorageKey,
  type Media,
} from './media';
import { settingsRevisionSchema } from './settings-revision';

export const MEDIA_IMAGE_EDITOR_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const MEDIA_IMAGE_EDITOR_MAX_DIMENSION = 8_192;
export const MEDIA_IMAGE_EDITOR_MAX_PIXELS = 25_000_000;

export const mediaImageEditorSourceQuerySchema = z.object({
  revision: settingsRevisionSchema,
}).strict();

export const mediaImageEditorOutputMimeTypeSchema = z.enum(
  MEDIA_IMAGE_EDITOR_MIME_TYPES,
);

export type MediaImageEditorOutputMimeType = z.infer<
  typeof mediaImageEditorOutputMimeTypeSchema
>;

export function isMediaImageEditorMimeType(
  value: string,
): value is MediaImageEditorOutputMimeType {
  return (MEDIA_IMAGE_EDITOR_MIME_TYPES as readonly string[]).includes(value);
}

export function isMediaImageEditorDimensioned(input: {
  width: number | null;
  height: number | null;
}): input is { width: number; height: number } {
  return input.width !== null
    && input.height !== null
    && Number.isInteger(input.width)
    && Number.isInteger(input.height)
    && input.width > 0
    && input.height > 0
    && input.width <= MEDIA_IMAGE_EDITOR_MAX_DIMENSION
    && input.height <= MEDIA_IMAGE_EDITOR_MAX_DIMENSION
    && input.width * input.height <= MEDIA_IMAGE_EDITOR_MAX_PIXELS;
}

/**
 * Editing is deliberately narrower than previewing. Studio only decodes
 * bounded raster bytes from deletable R2 namespaces and always saves the
 * result as a new immutable managed Media object.
 */
export function isMediaImageEditable(
  media: Pick<Media, 'kind' | 'mime_type' | 'location' | 'width' | 'height'>,
): boolean {
  return media.kind === 'image'
    && isMediaImageEditorMimeType(media.mime_type)
    && media.location.type === 'r2'
    && isDeletableR2MediaStorageKey(media.location.key)
    && isMediaImageEditorDimensioned(media);
}
