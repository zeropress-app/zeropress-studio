import { z } from 'zod';
import {
  externalMediaUrlSchema,
  isR2MediaPreviewSafeImage,
  mediaIdSchema,
  mediaLocationSchema,
  mediaMimeTypeSchema,
  privateMediaPreviewUrlSchema,
} from '../../../contracts/media';
import { mediaOriginSchema } from '../../../contracts/media-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

const accountAvatarPreviewUrlSchema = z.union([
  externalMediaUrlSchema,
  privateMediaPreviewUrlSchema,
]);

type AccountAvatarRow = {
  media_id: unknown;
  mime_type: unknown;
  storage_type: unknown;
  storage_key: unknown;
  external_url: unknown;
  revision: unknown;
  media_origin: unknown;
};

export type ReadAccountAvatarPreviewUrl = typeof readAccountAvatarPreviewUrl;

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('AUTH_SESSION_DATABASE_QUERY_FAILED', {
    cause,
    metadata: { resource: 'DB', action: 'validate_account_avatar' },
  });
}

export async function readAccountAvatarPreviewUrl(input: {
  db: D1Database;
  userId: string;
}): Promise<string | null> {
  try {
    const row = await input.db.prepare(`
      SELECT
        media.id AS media_id,
        media.mime_type,
        media.storage_type,
        media.storage_key,
        media.external_url,
        media.revision,
        COALESCE((
          SELECT value FROM site_settings
          WHERE key = 'site_media_origin' AND type = 'string'
          LIMIT 1
        ), '') AS media_origin
      FROM authors
      JOIN media ON media.id = authors.avatar_media_id
      WHERE authors.user_id = ?
        AND media.kind = 'image'
      LIMIT 1
    `).bind(input.userId).first<AccountAvatarRow>();
    if (!row) return null;

    const mediaId = mediaIdSchema.safeParse(row.media_id);
    const mimeType = mediaMimeTypeSchema.safeParse(row.mime_type);
    const revision = settingsRevisionSchema.safeParse(row.revision);
    const mediaOrigin = mediaOriginSchema.safeParse(row.media_origin);
    const location = mediaLocationSchema.safeParse(
      row.storage_type === 'external'
        ? { type: 'external', url: row.external_url }
        : { type: 'r2', key: row.storage_key },
    );
    if (
      !mediaId.success
      || !mimeType.success
      || !revision.success
      || !mediaOrigin.success
      || !location.success
    ) throw dataInvalid();

    let previewUrl: string | null;
    if (location.data.type === 'external') {
      previewUrl = location.data.url;
    } else if (mediaOrigin.data) {
      previewUrl = `${mediaOrigin.data}/${location.data.key}`;
    } else if (isR2MediaPreviewSafeImage(
      mimeType.data,
      location.data.key,
    )) {
      previewUrl = `/api/media/${mediaId.data}/preview?revision=${revision.data}`;
    } else {
      previewUrl = null;
    }
    if (previewUrl === null) return null;
    const parsed = accountAvatarPreviewUrlSchema.safeParse(previewUrl);
    if (!parsed.success) throw dataInvalid(parsed.error);
    return parsed.data;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('AUTH_SESSION_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'read_account_avatar' },
    });
  }
}
