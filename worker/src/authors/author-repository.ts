import {
  authorAvatarSchema,
  authorDisplayNameSchema,
  authorIdSchema,
  authorSchema,
  authorListItemSchema,
  authorUserOptionSchema,
  type Author,
  type AuthorListItem,
  type AuthorListQuery,
  type AuthorListSummary,
  type AuthorUserOption,
} from '../../../contracts/authors';
import {
  isR2MediaPreviewSafeImage,
  mediaLocationSchema,
  mediaReferenceSchema,
  type MediaLocation,
  type MediaReference,
} from '../../../contracts/media';
import { mediaOriginSchema } from '../../../contracts/media-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

type AuthorRow = {
  id: unknown;
  display_name: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
  user_id: unknown;
  user_email: unknown;
  user_name: unknown;
  user_status: unknown;
  avatar_media_id: unknown;
  avatar_kind: unknown;
  avatar_filename: unknown;
  avatar_mime_type: unknown;
  avatar_storage_type: unknown;
  avatar_storage_key: unknown;
  avatar_external_url: unknown;
  avatar_revision: unknown;
  media_origin: unknown;
  post_count?: unknown;
};

type AuthorUserOptionRow = {
  id: unknown;
  email: unknown;
  name: unknown;
  status: unknown;
  linked_author_id: unknown;
};

type CountRow = {
  row_count?: unknown;
  total_count?: unknown;
  linked_count?: unknown;
  unlinked_count?: unknown;
};

export type AuthorListResult = {
  items: AuthorListItem[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
  summary: AuthorListSummary;
};

export type CreateAuthorResult =
  | { kind: 'completed'; author: Author }
  | { kind: 'id_conflict' }
  | { kind: 'user_conflict' }
  | { kind: 'user_not_found' }
  | { kind: 'media_not_found' };

export type UpdateAuthorResult =
  | { kind: 'completed'; author: Author }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'user_conflict' }
  | { kind: 'user_not_found' }
  | { kind: 'media_not_found' };

export type DeleteAuthorResult =
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'in_use' };

export type PreviewAuthorRecord = {
  id: string;
  displayName: string;
  avatarLocation: MediaLocation | null;
  avatarMedia: MediaReference | null;
};

const AUTHOR_AVATAR_SELECT = `
    authors.avatar_media_id,
    avatar_media.kind AS avatar_kind,
    avatar_media.filename AS avatar_filename,
    avatar_media.mime_type AS avatar_mime_type,
    avatar_media.storage_type AS avatar_storage_type,
    avatar_media.storage_key AS avatar_storage_key,
    avatar_media.external_url AS avatar_external_url,
    avatar_media.revision AS avatar_revision,
    COALESCE((
      SELECT value FROM site_settings
      WHERE key = 'site_media_origin' AND type = 'string'
      LIMIT 1
    ), '') AS media_origin
`;

const AUTHOR_AVATAR_JOIN = `
  LEFT JOIN media AS avatar_media
    ON avatar_media.id = authors.avatar_media_id
`;

const AUTHOR_SELECT = `
  SELECT
    authors.id,
    authors.display_name,
    authors.revision,
    authors.created_at_iso,
    authors.updated_at_iso,
    users.id AS user_id,
    users.email AS user_email,
    users.name AS user_name,
    users.status AS user_status,
    ${AUTHOR_AVATAR_SELECT}
  FROM authors
  LEFT JOIN users ON users.id = authors.user_id
  ${AUTHOR_AVATAR_JOIN}
`;

const AUTHOR_LIST_SELECT = `
  SELECT
    authors.id,
    authors.display_name,
    authors.revision,
    authors.created_at_iso,
    authors.updated_at_iso,
    users.id AS user_id,
    users.email AS user_email,
    users.name AS user_name,
    users.status AS user_status,
    ${AUTHOR_AVATAR_SELECT},
    (
      SELECT COUNT(*)
      FROM posts
      WHERE posts.author_id = authors.id
    ) AS post_count
  FROM authors
  LEFT JOIN users ON users.id = authors.user_id
  ${AUTHOR_AVATAR_JOIN}
`;

function createRevision(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown>): number {
  const changes = result.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

function isAuthorAvatarConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /author avatar must reference image media/iu.test(message);
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'AUTHOR_MANAGEMENT_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'AUTHOR_MANAGEMENT_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('AUTHOR_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_author_data' },
  });
}

function avatarLocation(row: AuthorRow): MediaLocation {
  const parsed = mediaLocationSchema.safeParse(
    row.avatar_storage_type === 'external'
      ? { type: 'external', url: row.avatar_external_url }
      : { type: 'r2', key: row.avatar_storage_key },
  );
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseAvatar(row: AuthorRow) {
  if (row.avatar_media_id === null) return null;
  if (row.avatar_kind !== 'image') throw dataInvalid();
  const location = avatarLocation(row);
  const mediaOrigin = mediaOriginSchema.safeParse(row.media_origin);
  if (!mediaOrigin.success) throw dataInvalid(mediaOrigin.error);
  const previewUrl = location.type === 'external'
    ? location.url
    : mediaOrigin.data
      ? `${mediaOrigin.data}/${location.key}`
      : isR2MediaPreviewSafeImage(
          String(row.avatar_mime_type),
          location.key,
        )
        ? `/api/media/${String(row.avatar_media_id)}/preview?revision=${String(row.avatar_revision)}`
        : null;
  const parsed = authorAvatarSchema.safeParse({
    id: row.avatar_media_id,
    filename: row.avatar_filename,
    mime_type: row.avatar_mime_type,
    location,
    preview_url: previewUrl,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseAuthor(row: AuthorRow): Author {
  const hasUser = row.user_id !== null;
  const parsed = authorSchema.safeParse({
    id: row.id,
    display_name: row.display_name,
    user: hasUser
      ? {
          id: row.user_id,
          email: row.user_email,
          name: row.user_name,
          status: row.user_status,
        }
      : null,
    avatar: parseAvatar(row),
    revision: row.revision,
    created_at_iso: row.created_at_iso,
    updated_at_iso: row.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseAuthorListItem(row: AuthorRow): AuthorListItem {
  const author = parseAuthor(row);
  const parsed = authorListItemSchema.safeParse({
    ...author,
    post_count: row.post_count,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseUserOption(row: AuthorUserOptionRow): AuthorUserOption {
  const parsed = authorUserOptionSchema.safeParse(row);
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function readCount(result: D1Result<unknown> | undefined): number {
  const row = result?.results?.[0] as CountRow | undefined;
  if (!Number.isSafeInteger(row?.row_count) || (row?.row_count as number) < 0) {
    throw new TypeError('D1 returned an invalid author count.');
  }
  return row?.row_count as number;
}

function readSummary(result: D1Result<unknown> | undefined): AuthorListSummary {
  const row = result?.results?.[0] as CountRow | undefined;
  const values = [
    row?.total_count,
    row?.linked_count,
    row?.unlinked_count,
  ];
  if (values.some((value) => (
    !Number.isSafeInteger(value) || (value as number) < 0
  ))) {
    throw new TypeError('D1 returned an invalid author summary.');
  }
  const summary = {
    total: row?.total_count as number,
    linked: row?.linked_count as number,
    unlinked: row?.unlinked_count as number,
  };
  if (summary.total !== summary.linked + summary.unlinked) {
    throw new TypeError('D1 returned inconsistent author summary counts.');
  }
  return summary;
}

async function readAuthor(
  db: D1Database,
  authorId: string,
): Promise<Author | null> {
  const row = await db.prepare(`
    ${AUTHOR_SELECT}
    WHERE authors.id = ?
    LIMIT 1
  `).bind(authorId).first<AuthorRow>();
  return row ? parseAuthor(row) : null;
}

async function inspectUserLink(
  db: D1Database,
  userId: string,
): Promise<'missing' | 'available' | 'linked'> {
  const row = await db.prepare(`
    SELECT users.id, authors.id AS linked_author_id
    FROM users
    LEFT JOIN authors ON authors.user_id = users.id
    WHERE users.id = ?
    LIMIT 1
  `).bind(userId).first<{ id: unknown; linked_author_id: unknown }>();
  if (!row) return 'missing';
  return row.linked_author_id === null ? 'available' : 'linked';
}

async function avatarExists(db: D1Database, mediaId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS valid
    FROM media
    WHERE id = ? AND kind = 'image'
    LIMIT 1
  `).bind(mediaId).first<{ valid?: unknown }>();
  return row?.valid === 1;
}

export async function listAuthors(input: {
  db: D1Database;
  query: AuthorListQuery;
}): Promise<AuthorListResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.query.search) {
    where.push(`(
      instr(lower(authors.id), lower(?)) > 0
      OR instr(lower(authors.display_name), lower(?)) > 0
      OR instr(lower(users.email), lower(?)) > 0
      OR instr(lower(users.name), lower(?)) > 0
    )`);
    const search = input.query.search;
    params.push(search, search, search, search);
  }
  if (input.query.linked === 'linked') {
    where.push('authors.user_id IS NOT NULL');
  } else if (input.query.linked === 'unlinked') {
    where.push('authors.user_id IS NULL');
  }
  const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (input.query.page - 1) * input.query.per_page;

  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM authors
        LEFT JOIN users ON users.id = authors.user_id
        ${filter}
      `).bind(...params),
      input.db.prepare(`
        SELECT
          COUNT(*) AS total_count,
          COUNT(user_id) AS linked_count,
          COUNT(*) - COUNT(user_id) AS unlinked_count
        FROM authors
      `),
      input.db.prepare(`
        ${AUTHOR_LIST_SELECT}
        ${filter}
        ORDER BY authors.display_name COLLATE NOCASE, authors.id
        LIMIT ? OFFSET ?
      `).bind(...params, input.query.per_page, offset),
    ]);
    const total = readCount(results[0]);
    const summary = readSummary(results[1]);
    const rows = results[2]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid author list.');
    }
    return {
      items: (rows as AuthorRow[]).map(parseAuthorListItem),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0
          ? 0
          : Math.ceil(total / input.query.per_page),
      },
      summary,
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_authors');
  }
}

export async function listAuthorUserOptions(input: {
  db: D1Database;
}): Promise<AuthorUserOption[]> {
  try {
    const result = await input.db.prepare(`
      SELECT
        users.id,
        users.email,
        users.name,
        users.status,
        authors.id AS linked_author_id
      FROM users
      LEFT JOIN authors ON authors.user_id = users.id
      ORDER BY users.name COLLATE NOCASE, users.email, users.id
      LIMIT 100
    `).all<AuthorUserOptionRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid author user options.');
    }
    return result.results.map(parseUserOption);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_author_user_options');
  }
}

export async function createAuthor(input: {
  db: D1Database;
  id: string;
  displayName: string;
  userId: string | null;
  avatarMediaId: string | null;
  now?: Date;
  createRevision?: () => string;
}): Promise<CreateAuthorResult> {
  try {
    if (await readAuthor(input.db, input.id)) return { kind: 'id_conflict' };
    if (input.userId) {
      const userState = await inspectUserLink(input.db, input.userId);
      if (userState === 'missing') return { kind: 'user_not_found' };
      if (userState === 'linked') return { kind: 'user_conflict' };
    }
    if (input.avatarMediaId && !await avatarExists(input.db, input.avatarMediaId)) {
      return { kind: 'media_not_found' };
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createRevision)(),
    );
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso,
        avatar_media_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.userId,
      input.displayName,
      revision,
      nowIso,
      nowIso,
      input.avatarMediaId,
    ).run();
    if (readChanges(result) === 0) {
      if (await readAuthor(input.db, input.id)) return { kind: 'id_conflict' };
      if (input.userId && await inspectUserLink(input.db, input.userId) === 'linked') {
        return { kind: 'user_conflict' };
      }
      throw new TypeError('D1 ignored a valid author insert.');
    }
    const author = await readAuthor(input.db, input.id);
    if (!author) throw new TypeError('D1 did not return the created author.');
    return { kind: 'completed', author };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isAuthorAvatarConstraint(error)) return { kind: 'media_not_found' };
    throw writeFailure(error, 'create_author');
  }
}

export async function updateAuthor(input: {
  db: D1Database;
  id: string;
  displayName: string;
  userId: string | null;
  avatarMediaId: string | null;
  expectedRevision: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdateAuthorResult> {
  try {
    const current = await readAuthor(input.db, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (input.userId && input.userId !== current.user?.id) {
      const userState = await inspectUserLink(input.db, input.userId);
      if (userState === 'missing') return { kind: 'user_not_found' };
      if (userState === 'linked') return { kind: 'user_conflict' };
    }
    if (
      input.avatarMediaId
      && input.avatarMediaId !== current.avatar?.id
      && !await avatarExists(input.db, input.avatarMediaId)
    ) return { kind: 'media_not_found' };
    if (
      current.display_name === input.displayName
      && (current.user?.id ?? null) === input.userId
      && (current.avatar?.id ?? null) === input.avatarMediaId
    ) {
      return { kind: 'completed', author: current };
    }
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createRevision)(),
    );
    const result = await input.db.prepare(`
      UPDATE OR IGNORE authors
      SET user_id = ?, display_name = ?, avatar_media_id = ?,
          revision = ?, updated_at_iso = ?
      WHERE id = ? AND revision = ?
    `).bind(
      input.userId,
      input.displayName,
      input.avatarMediaId,
      revision,
      (input.now ?? new Date()).toISOString(),
      input.id,
      input.expectedRevision,
    ).run();
    if (readChanges(result) === 0) {
      const latest = await readAuthor(input.db, input.id);
      if (!latest) return { kind: 'not_found' };
      if (latest.revision !== input.expectedRevision) {
        return { kind: 'revision_conflict' };
      }
      if (input.userId && await inspectUserLink(input.db, input.userId) === 'linked') {
        return { kind: 'user_conflict' };
      }
      throw new TypeError('D1 ignored a valid author update.');
    }
    const author = await readAuthor(input.db, input.id);
    if (!author) throw new TypeError('D1 did not return the updated author.');
    return { kind: 'completed', author };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isAuthorAvatarConstraint(error)) return { kind: 'media_not_found' };
    throw writeFailure(error, 'update_author');
  }
}

export async function listPreviewAuthors(input: {
  db: D1Database;
}): Promise<PreviewAuthorRecord[]> {
  try {
    const result = await input.db.prepare(`
      SELECT DISTINCT
        authors.id,
        authors.display_name,
        authors.avatar_media_id,
        avatar_media.kind AS avatar_kind,
        avatar_media.filename AS avatar_filename,
        avatar_media.mime_type AS avatar_mime_type,
        avatar_media.storage_type AS avatar_storage_type,
        avatar_media.storage_key AS avatar_storage_key,
        avatar_media.external_url AS avatar_external_url,
        avatar_media.width AS avatar_width,
        avatar_media.height AS avatar_height,
        avatar_media.alt AS avatar_alt
      FROM authors
      JOIN posts
        ON posts.author_id = authors.id
       AND posts.status = 'published'
      LEFT JOIN media AS avatar_media
        ON avatar_media.id = authors.avatar_media_id
      ORDER BY authors.id COLLATE BINARY
    `).all<{
      id: unknown;
      display_name: unknown;
      avatar_media_id: unknown;
      avatar_kind: unknown;
      avatar_filename: unknown;
      avatar_mime_type: unknown;
      avatar_storage_type: unknown;
      avatar_storage_key: unknown;
      avatar_external_url: unknown;
      avatar_width: unknown;
      avatar_height: unknown;
      avatar_alt: unknown;
    }>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Preview Author rows.');
    }
    return result.results.map((row) => {
      const author = authorIdSchema.safeParse(row.id);
      const displayName = authorDisplayNameSchema.safeParse(row.display_name);
      if (!author.success || !displayName.success) throw dataInvalid();
      if (row.avatar_media_id === null) {
        return {
          id: author.data,
          displayName: displayName.data,
          avatarLocation: null,
          avatarMedia: null,
        };
      }
      if (row.avatar_kind !== 'image') throw dataInvalid();
      const location = mediaLocationSchema.safeParse(
        row.avatar_storage_type === 'external'
          ? { type: 'external', url: row.avatar_external_url }
          : { type: 'r2', key: row.avatar_storage_key },
      );
      if (!location.success) throw dataInvalid(location.error);
      const avatarMedia = row.avatar_width === null && row.avatar_height === null
        ? null
        : mediaReferenceSchema.safeParse({
            id: row.avatar_media_id,
            kind: row.avatar_kind,
            filename: row.avatar_filename,
            mime_type: row.avatar_mime_type,
            location: location.data,
            width: row.avatar_width,
            height: row.avatar_height,
            alt: row.avatar_alt,
          });
      if (avatarMedia !== null && !avatarMedia.success) {
        throw dataInvalid(avatarMedia.error);
      }
      return {
        id: author.data,
        displayName: displayName.data,
        avatarLocation: location.data,
        avatarMedia: avatarMedia === null ? null : avatarMedia.data,
      };
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_authors');
  }
}

export async function deleteAuthor(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
}): Promise<DeleteAuthorResult> {
  try {
    const current = await readAuthor(input.db, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const widgetReference = await input.db.prepare(`
      SELECT 1 AS referenced
      FROM widget_areas
      JOIN json_each(widget_areas.items) AS widget_item
      WHERE json_extract(widget_item.value, '$.type') = 'profile'
        AND json_extract(widget_item.value, '$.settings.author_id') = ?
      LIMIT 1
    `).bind(input.id).first<{ referenced?: unknown }>();
    if (widgetReference) return { kind: 'in_use' };
    const result = await input.db.prepare(`
      DELETE FROM authors WHERE id = ? AND revision = ?
    `).bind(input.id, input.expectedRevision).run();
    if (readChanges(result) === 0) {
      return await readAuthor(input.db, input.id)
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    return { kind: 'completed' };
  } catch (error) {
    if (isForeignKeyConstraint(error)) return { kind: 'in_use' };
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_author');
  }
}
