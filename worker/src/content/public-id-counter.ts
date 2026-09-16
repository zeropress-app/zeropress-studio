import {
  contentPublicIdSchema,
  type ContentType,
  ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
} from '../../../contracts/content-public-id';
import { StudioOperationalError } from '../lib/operational-error';

const CONTENT_TABLES = {
  post: 'posts',
  page: 'pages',
} as const satisfies Record<ContentType, string>;

export async function allocateContentPublicId(input: {
  db: D1Database;
  contentType: ContentType;
}): Promise<number> {
  const table = CONTENT_TABLES[input.contentType];
  let row: { last_public_id?: unknown } | null;
  try {
    row = await input.db.prepare(`
      UPDATE content_public_id_counters
      SET last_public_id = MAX(
        last_public_id,
        COALESCE((
          SELECT MAX(public_id)
          FROM ${table}
          WHERE public_id >= ?
        ), ?)
      ) + 1
      WHERE content_type = ?
      RETURNING last_public_id
    `).bind(
      ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
      ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
      input.contentType,
    ).first<{ last_public_id?: unknown }>();
  } catch (error) {
    throw new StudioOperationalError(
      `${input.contentType.toUpperCase()}_MANAGEMENT_DATABASE_WRITE_FAILED` as
        | 'POST_MANAGEMENT_DATABASE_WRITE_FAILED'
        | 'PAGE_MANAGEMENT_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: `allocate_${input.contentType}_public_id`,
        },
      },
    );
  }

  const parsed = contentPublicIdSchema.safeParse(row?.last_public_id);
  if (
    !parsed.success
    || parsed.data <= ZEROPRESS_NATIVE_PUBLIC_ID_BASE
  ) {
    throw new StudioOperationalError(
      `${input.contentType.toUpperCase()}_MANAGEMENT_DATA_INVALID` as
        | 'POST_MANAGEMENT_DATA_INVALID'
        | 'PAGE_MANAGEMENT_DATA_INVALID',
      {
        metadata: {
          resource: 'DB',
          action: `validate_${input.contentType}_public_id_counter`,
        },
      },
    );
  }
  return parsed.data;
}
