import {
  isR2MediaPreviewSafeImage,
  type Media,
  type MediaDelivery,
} from '../../../contracts/media';

export function resolveMediaPreviewUrl(
  media: Media,
  delivery: MediaDelivery,
): string | null {
  if (media.kind !== 'image') return null;
  if (media.location.type === 'external') return media.location.url;
  if (delivery.media_origin !== '') {
    return `${delivery.media_origin}/${media.location.key}`;
  }
  if (
    !delivery.r2_preview_available
    || !isR2MediaPreviewSafeImage(media.mime_type, media.location.key)
  ) return null;
  return `/api/media/${encodeURIComponent(media.id)}/preview?revision=${encodeURIComponent(media.revision)}`;
}
