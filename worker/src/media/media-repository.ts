import {
  isDeletableR2MediaStorageKey,
  isR2MediaPreviewSafeImage,
  mediaIdSchema,
  mediaMimeTypeSchema,
  mediaUsageReferenceSchema,
  mediaSchema,
  mediaStorageKeySchema,
  type BulkMediaOperationData,
  type BulkMediaOperationRequest,
  type BulkMediaOperationResult,
  type CreateMediaRequest,
  type Media,
  type MediaListQuery,
  type MediaLocation,
  type MediaReferenceListQuery,
  type MediaUsageReference,
  type UpdateMediaRequest,
} from '../../../contracts/media';
import {
  parseMediaAiGenerationJson,
  type MediaAiGeneration,
} from '../../../contracts/media-ai-generation';
import {
  isMediaImageEditorDimensioned,
  isMediaImageEditorMimeType,
} from '../../../contracts/media-image-editor';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

type MediaRow = {
  id: unknown;
  kind: unknown;
  filename: unknown;
  mime_type: unknown;
  storage_type: unknown;
  storage_key: unknown;
  external_url: unknown;
  size_bytes: unknown;
  width: unknown;
  height: unknown;
  duration_ms: unknown;
  alt: unknown;
  post_usage: unknown;
  page_usage: unknown;
  author_usage: unknown;
  branding_usage: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
  collection_id: unknown;
  collection_name: unknown;
};

type CountRow = { row_count?: unknown };
type ReferenceSummaryRow = CountRow & {
  media_exists?: unknown;
  ai_generation_json?: unknown;
};
type MediaUsageReferenceRow = {
  reference_type: unknown;
  reference_id: unknown;
  public_id: unknown;
  reference_label: unknown;
  branding_slot: unknown;
};
type R2MediaPreviewRow = {
  id: unknown;
  mime_type: unknown;
  storage_key: unknown;
};
type R2MediaImageEditorRow = R2MediaPreviewRow & {
  kind: unknown;
  storage_type: unknown;
  width: unknown;
  height: unknown;
  revision: unknown;
};

type BulkMediaRow = {
  id: unknown;
  kind: unknown;
  filename: unknown;
  alt: unknown;
  revision: unknown;
  storage_type: unknown;
  storage_key: unknown;
  post_usage: unknown;
  page_usage: unknown;
  author_usage: unknown;
  branding_usage: unknown;
};

export type MediaListResult = {
  items: Media[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
};

export type MediaReferenceListResult =
  | {
      kind: 'completed';
      items: MediaUsageReference[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
    }
  | { kind: 'not_found' };

export type MediaInformationResult =
  | {
      kind: 'completed';
      generation: MediaAiGeneration | null;
      items: MediaUsageReference[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
    }
  | { kind: 'not_found' };

export type R2MediaPreviewDescriptor = {
  mediaId: string;
  mimeType: string;
  storageKey: string;
};

export type R2MediaImageEditorSourceResult =
  | { kind: 'ready'; preview: R2MediaPreviewDescriptor }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'unsupported' };

export type CreateMediaResult =
  | { kind: 'completed'; media: Media }
  | { kind: 'source_conflict' };

export type UpdateMediaResult =
  | { kind: 'completed'; media: Media }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'in_use' }
  | { kind: 'managed_file_immutable' }
  | { kind: 'source_conflict' };

export type DeleteMediaResult =
  | { kind: 'completed'; cleanupKey: string | null; filename?: string }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'in_use' }
  | { kind: 'managed_object_unavailable' };

export type BulkMediaOperationResultData = BulkMediaOperationData & {
  cleanupKeys: string[];
};

const MEDIA_SELECT = `
  SELECT
    media.id,
    media.kind,
    media.filename,
    media.mime_type,
    media.storage_type,
    media.storage_key,
    media.external_url,
    media.width,
    media.height,
    media.alt,
    media.size_bytes,
    media.duration_ms,
    (SELECT COUNT(*) FROM posts WHERE posts.featured_image_id = media.id)
      AS post_usage,
    (SELECT COUNT(*) FROM pages WHERE pages.featured_image_id = media.id)
      AS page_usage,
    (SELECT COUNT(*) FROM authors WHERE authors.avatar_media_id = media.id)
      AS author_usage,
    (SELECT COUNT(*) FROM site_assets WHERE site_assets.media_id = media.id)
      AS branding_usage,
    media.revision,
    media.created_at_iso,
    media.updated_at_iso,
    media.collection_id,
    media_collections.name AS collection_name
  FROM media
  LEFT JOIN media_collections
    ON media_collections.id = media.collection_id
`;

const MEDIA_USAGE_REFERENCE_SELECT = `
  SELECT
    1 AS reference_order,
    'post' AS reference_type,
    posts.id AS reference_id,
    posts.public_id AS public_id,
    posts.title AS reference_label,
    NULL AS branding_slot
  FROM posts
  WHERE posts.featured_image_id = ?
  UNION ALL
  SELECT
    2,
    'page',
    pages.id,
    pages.public_id,
    pages.title,
    NULL
  FROM pages
  WHERE pages.featured_image_id = ?
  UNION ALL
  SELECT
    3,
    'author',
    authors.id,
    NULL,
    authors.display_name,
    NULL
  FROM authors
  WHERE authors.avatar_media_id = ?
  UNION ALL
  SELECT
    4,
    'branding',
    site_assets.slot,
    NULL,
    site_assets.slot,
    site_assets.slot
  FROM site_assets
  WHERE site_assets.media_id = ?
`;

function createHexId(): string {
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

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('MEDIA_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('MEDIA_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('MEDIA_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_media_data' },
  });
}

function parseCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned an invalid Media count.');
  }
  return value as number;
}

function bulkPlaceholders(length: number): string {
  return Array.from({ length }, () => '?').join(', ');
}

function parseBulkMediaRow(row: BulkMediaRow) {
  if (
    typeof row.id !== 'string'
    || typeof row.kind !== 'string'
    || typeof row.filename !== 'string'
    || typeof row.alt !== 'string'
    || typeof row.revision !== 'string'
    || !['external', 'r2'].includes(String(row.storage_type))
    || (row.storage_key !== null && typeof row.storage_key !== 'string')
  ) throw new TypeError('D1 returned invalid bulk Media metadata.');
  return {
    id: mediaIdSchema.parse(row.id),
    kind: row.kind,
    filename: row.filename,
    alt: row.alt,
    revision: settingsRevisionSchema.parse(row.revision),
    storageType: row.storage_type as 'external' | 'r2',
    storageKey: row.storage_key,
    usage: {
      posts: parseCount(row.post_usage),
      pages: parseCount(row.page_usage),
      authors: parseCount(row.author_usage),
      branding: parseCount(row.branding_usage),
    },
  };
}

async function readBulkMediaRows(
  db: D1Database,
  ids: string[],
): Promise<Map<string, ReturnType<typeof parseBulkMediaRow>>> {
  if (ids.length === 0) return new Map();
  let rows: BulkMediaRow[];
  try {
    const result = await db.prepare(`
      SELECT
        media.id,
        media.kind,
        media.filename,
        media.alt,
        media.revision,
        media.storage_type,
        media.storage_key,
        (SELECT COUNT(*) FROM posts WHERE posts.featured_image_id = media.id)
          AS post_usage,
        (SELECT COUNT(*) FROM pages WHERE pages.featured_image_id = media.id)
          AS page_usage,
        (SELECT COUNT(*) FROM authors WHERE authors.avatar_media_id = media.id)
          AS author_usage,
        (SELECT COUNT(*) FROM site_assets WHERE site_assets.media_id = media.id)
          AS branding_usage
      FROM media
      WHERE media.id IN (${bulkPlaceholders(ids.length)})
    `).bind(...ids).all<BulkMediaRow>();
    rows = result.results ?? [];
  } catch (error) {
    throw queryFailure(error, 'read_bulk_media_metadata');
  }
  const requested = new Set(ids);
  const parsed = new Map<string, ReturnType<typeof parseBulkMediaRow>>();
  for (const row of rows) {
    const current = parseBulkMediaRow(row);
    if (!requested.has(current.id) || parsed.has(current.id)) {
      throw dataInvalid();
    }
    parsed.set(current.id, current);
  }
  return parsed;
}

function summarizeBulkMediaOperation(
  operation: BulkMediaOperationRequest['operation'],
  results: BulkMediaOperationResult[],
): BulkMediaOperationData {
  const summary = {
    requested: results.length,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    skipped: 0,
    queued_objects: 0,
  };
  for (const result of results) {
    summary[result.outcome] += 1;
    if ('object_cleanup' in result && result.object_cleanup === 'pending') {
      summary.queued_objects += 1;
    }
  }
  return { operation, results, summary };
}

function rowLocation(row: Pick<
  MediaRow,
  'storage_type' | 'storage_key' | 'external_url'
>): unknown {
  if (row.storage_type === 'external') {
    return { type: 'external', url: row.external_url };
  }
  if (row.storage_type === 'r2') {
    return { type: 'r2', key: row.storage_key };
  }
  return { type: row.storage_type };
}

function parseMedia(row: MediaRow): Media {
  const parsed = mediaSchema.safeParse({
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mime_type,
    location: rowLocation(row),
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    alt: row.alt,
    collection: row.collection_id === null
      ? null
      : { id: row.collection_id, name: row.collection_name },
    usage: {
      posts: row.post_usage,
      pages: row.page_usage,
      authors: row.author_usage,
      branding: row.branding_usage,
    },
    revision: row.revision,
    created_at_iso: row.created_at_iso,
    updated_at_iso: row.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseMediaUsageReference(
  row: MediaUsageReferenceRow,
): MediaUsageReference {
  const candidate = row.reference_type === 'post'
    || row.reference_type === 'page'
    ? {
        type: row.reference_type,
        id: row.reference_id,
        public_id: row.public_id,
        title: row.reference_label,
      }
    : row.reference_type === 'author'
      ? {
          type: 'author',
          id: row.reference_id,
          display_name: row.reference_label,
        }
      : {
          type: row.reference_type,
          slot: row.branding_slot,
        };
  const parsed = mediaUsageReferenceSchema.safeParse(candidate);
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseR2MediaPreviewDescriptor(
  row: R2MediaPreviewRow,
): R2MediaPreviewDescriptor {
  const id = mediaIdSchema.safeParse(row.id);
  const mimeType = mediaMimeTypeSchema.safeParse(row.mime_type);
  const storageKey = mediaStorageKeySchema.safeParse(row.storage_key);
  if (!id.success || !mimeType.success || !storageKey.success) {
    throw dataInvalid();
  }
  return {
    mediaId: id.data,
    mimeType: mimeType.data,
    storageKey: storageKey.data,
  };
}

function locationColumns(location: MediaLocation) {
  return location.type === 'external'
    ? { storageType: 'external', storageKey: null, externalUrl: location.url }
    : { storageType: 'r2', storageKey: location.key, externalUrl: null };
}

function sameLocation(left: MediaLocation, right: MediaLocation): boolean {
  return left.type === right.type
    && (left.type === 'external'
      ? left.url === (right as Extract<MediaLocation, { type: 'external' }>).url
      : left.key === (right as Extract<MediaLocation, { type: 'r2' }>).key);
}

function isSourceConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:idx_media_(?:external_url|storage_key)_unique|unique constraint failed:\s*media\.(?:external_url|storage_key))/iu
    .test(message);
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

function isSiteAssetConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /referenced (?:site asset must remain a compatible image|author avatar must remain image media)/iu
    .test(message);
}

async function readMedia(db: D1Database, id: string): Promise<Media | null> {
  const row = await db.prepare(`
    ${MEDIA_SELECT}
    WHERE media.id = ?
    LIMIT 1
  `).bind(id).first<MediaRow>();
  return row ? parseMedia(row) : null;
}

export async function getMedia(input: {
  db: D1Database;
  id: string;
}): Promise<Media | null> {
  try {
    return await readMedia(input.db, input.id);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_media');
  }
}

export async function getR2MediaPreviewDescriptor(input: {
  db: D1Database;
  id: string;
}): Promise<R2MediaPreviewDescriptor | null> {
  try {
    const row = await input.db.prepare(`
      SELECT id, mime_type, storage_key
      FROM media
      WHERE id = ?
        AND kind = 'image'
        AND storage_type = 'r2'
      LIMIT 1
    `).bind(input.id).first<R2MediaPreviewRow>();
    if (!row) return null;
    const preview = parseR2MediaPreviewDescriptor(row);
    if (!isR2MediaPreviewSafeImage(
      preview.mimeType,
      preview.storageKey,
    )) return null;
    return preview;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_media_preview');
  }
}

export async function getR2MediaImageEditorSource(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
}): Promise<R2MediaImageEditorSourceResult> {
  try {
    const row = await input.db.prepare(`
      SELECT
        id,
        kind,
        mime_type,
        storage_type,
        storage_key,
        width,
        height,
        revision
      FROM media
      WHERE id = ?
      LIMIT 1
    `).bind(input.id).first<R2MediaImageEditorRow>();
    if (!row) return { kind: 'not_found' };
    const revision = settingsRevisionSchema.safeParse(row.revision);
    if (!revision.success) throw dataInvalid(revision.error);
    if (revision.data !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (
      row.kind !== 'image'
      || row.storage_type !== 'r2'
      || !isMediaImageEditorMimeType(String(row.mime_type))
      || !isDeletableR2MediaStorageKey(row.storage_key)
      || !isMediaImageEditorDimensioned({
        width: typeof row.width === 'number' ? row.width : null,
        height: typeof row.height === 'number' ? row.height : null,
      })
    ) return { kind: 'unsupported' };
    return {
      kind: 'ready',
      preview: parseR2MediaPreviewDescriptor(row),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_media_image_editor_source');
  }
}

/**
 * Resolves the immutable storage reference embedded in authored content.
 * The route decides whether the result uses the configured public Media
 * origin or the narrower private-R2 preview trust policy.
 */
export async function getR2MediaReferencePreviewDescriptor(input: {
  db: D1Database;
  storageKey: string;
}): Promise<R2MediaPreviewDescriptor | null> {
  try {
    const row = await input.db.prepare(`
      SELECT id, mime_type, storage_key
      FROM media
      WHERE storage_key = ?
        AND kind = 'image'
        AND storage_type = 'r2'
      LIMIT 1
    `).bind(input.storageKey).first<R2MediaPreviewRow>();
    return row ? parseR2MediaPreviewDescriptor(row) : null;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_media_reference_preview');
  }
}

export async function listMedia(input: {
  db: D1Database;
  query: MediaListQuery;
}): Promise<MediaListResult> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (input.query.kind !== 'all') {
    conditions.push('media.kind = ?');
    params.push(input.query.kind);
  }
  if (input.query.purpose === 'featured_image') {
    conditions.push(`media.kind = 'image'`);
    conditions.push('media.width IS NOT NULL');
    conditions.push('media.height IS NOT NULL');
  } else if (input.query.purpose === 'branding_favicon') {
    conditions.push(`media.kind = 'image'`);
    conditions.push(`media.mime_type IN (
      'image/png', 'image/svg+xml', 'image/x-icon',
      'image/vnd.microsoft.icon'
    )`);
  } else if (input.query.purpose === 'branding_logo') {
    conditions.push(`media.kind = 'image'`);
  } else if (input.query.purpose === 'author_avatar') {
    conditions.push(`media.kind = 'image'`);
  }
  if (input.query.collection === 'unfiled') {
    conditions.push('media.collection_id IS NULL');
  } else if (input.query.collection !== 'all') {
    conditions.push('media.collection_id = ?');
    params.push(input.query.collection);
  }
  if (input.query.search) {
    const search = input.query.search;
    conditions.push(`(
      instr(lower(media.filename), lower(?)) > 0
      OR instr(lower(media.mime_type), lower(?)) > 0
      OR instr(lower(media.storage_key), lower(?)) > 0
      OR instr(lower(media.external_url), lower(?)) > 0
      OR instr(lower(media.alt), lower(?)) > 0
    )`);
    params.push(search, search, search, search, search);
  }
  const filter = conditions.length === 0
    ? ''
    : `WHERE ${conditions.join('\n      AND ')}`;
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT COUNT(*) AS row_count FROM media ${filter}
      `).bind(...params),
      input.db.prepare(`
        ${MEDIA_SELECT}
        ${filter}
        ORDER BY media.updated_at_iso DESC, media.id ASC
        LIMIT ? OFFSET ?
      `).bind(...params, input.query.per_page, offset),
    ]);
    const total = parseCount(
      (results[0]?.results?.[0] as CountRow | undefined)?.row_count,
    );
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid Media list.');
    }
    return {
      items: (rows as MediaRow[]).map(parseMedia),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_media');
  }
}

export async function listMediaReferences(input: {
  db: D1Database;
  id: string;
  query: MediaReferenceListQuery;
}): Promise<MediaReferenceListResult> {
  const referenceIds = [input.id, input.id, input.id, input.id];
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM media WHERE id = ?) AS media_exists,
          (
            SELECT COUNT(*)
            FROM (${MEDIA_USAGE_REFERENCE_SELECT}) AS media_references
          ) AS row_count
      `).bind(input.id, ...referenceIds),
      input.db.prepare(`
        SELECT
          reference_type,
          reference_id,
          public_id,
          reference_label,
          branding_slot
        FROM (${MEDIA_USAGE_REFERENCE_SELECT}) AS media_references
        ORDER BY reference_order ASC,
          reference_label COLLATE NOCASE ASC,
          reference_id ASC
        LIMIT ? OFFSET ?
      `).bind(...referenceIds, input.query.per_page, offset),
    ]);
    const summary = results[0]?.results?.[0] as ReferenceSummaryRow | undefined;
    if (summary?.media_exists !== 1) return { kind: 'not_found' };
    const total = parseCount(summary.row_count);
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid Media reference list.');
    }
    return {
      kind: 'completed',
      items: (rows as MediaUsageReferenceRow[])
        .map(parseMediaUsageReference),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_media_references');
  }
}

export async function getMediaInformation(input: {
  db: D1Database;
  id: string;
  query: MediaReferenceListQuery;
}): Promise<MediaInformationResult> {
  const referenceIds = [input.id, input.id, input.id, input.id];
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM media WHERE id = ?) AS media_exists,
          (
            SELECT ai_generation_json FROM media WHERE id = ?
          ) AS ai_generation_json,
          (
            SELECT COUNT(*)
            FROM (${MEDIA_USAGE_REFERENCE_SELECT}) AS media_references
          ) AS row_count
      `).bind(input.id, input.id, ...referenceIds),
      input.db.prepare(`
        SELECT
          reference_type,
          reference_id,
          public_id,
          reference_label,
          branding_slot
        FROM (${MEDIA_USAGE_REFERENCE_SELECT}) AS media_references
        ORDER BY reference_order ASC,
          reference_label COLLATE NOCASE ASC,
          reference_id ASC
        LIMIT ? OFFSET ?
      `).bind(...referenceIds, input.query.per_page, offset),
    ]);
    const summary = results[0]?.results?.[0] as ReferenceSummaryRow | undefined;
    if (summary?.media_exists !== 1) return { kind: 'not_found' };
    let generation: MediaAiGeneration | null;
    try {
      if (summary.ai_generation_json === null) generation = null;
      else if (typeof summary.ai_generation_json === 'string') {
        generation = parseMediaAiGenerationJson(summary.ai_generation_json);
      } else {
        throw new TypeError('D1 returned invalid AI generation metadata.');
      }
    } catch (error) {
      throw dataInvalid(error);
    }
    const total = parseCount(summary.row_count);
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned invalid Media information.');
    }
    return {
      kind: 'completed',
      generation,
      items: (rows as MediaUsageReferenceRow[])
        .map(parseMediaUsageReference),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'get_media_information');
  }
}

export async function createMedia(input: {
  db: D1Database;
  authored: CreateMediaRequest;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<CreateMediaResult> {
  try {
    const id = mediaIdSchema.parse((input.createId ?? createHexId)());
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const location = locationColumns(input.authored.location);
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO media (
        id, kind, filename, mime_type, storage_type, storage_key, external_url,
        size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.authored.kind,
      input.authored.filename,
      input.authored.mime_type,
      location.storageType,
      location.storageKey,
      location.externalUrl,
      input.authored.size_bytes,
      input.authored.width,
      input.authored.height,
      input.authored.duration_ms,
      input.authored.alt,
      revision,
      nowIso,
      nowIso,
    ).run();
    if (readChanges(result) === 0) {
      const sourceOwner = await input.db.prepare(`
        SELECT id FROM media
        WHERE (storage_type = 'external' AND external_url = ?)
           OR (storage_type = 'r2' AND storage_key = ?)
        LIMIT 1
      `).bind(location.externalUrl, location.storageKey).first<{ id?: unknown }>();
      if (sourceOwner) return { kind: 'source_conflict' };
      throw new TypeError('D1 ignored a valid Media insert.');
    }
    const media = await readMedia(input.db, id);
    if (!media) throw new TypeError('D1 did not return the created Media.');
    return { kind: 'completed', media };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSourceConstraint(error)) return { kind: 'source_conflict' };
    throw writeFailure(error, 'create_media');
  }
}

export async function updateMedia(input: {
  db: D1Database;
  id: string;
  authored: UpdateMediaRequest;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdateMediaResult> {
  try {
    const current = await readMedia(input.db, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.authored.expected_revision) {
      return { kind: 'revision_conflict' };
    }
    if (
      (current.usage.posts > 0 || current.usage.pages > 0)
      && (
        input.authored.kind !== 'image'
        || input.authored.width === null
        || input.authored.height === null
      )
    ) return { kind: 'in_use' };
    if (current.usage.authors > 0 && input.authored.kind !== 'image') {
      return { kind: 'in_use' };
    }
    if (
      current.location.type === 'r2'
      && current.location.key.startsWith('uploads/')
      && (
        input.authored.kind !== current.kind
        || input.authored.mime_type !== current.mime_type
        || !sameLocation(input.authored.location, current.location)
        || input.authored.size_bytes !== current.size_bytes
      )
    ) return { kind: 'managed_file_immutable' };
    if (
      current.kind === input.authored.kind
      && current.filename === input.authored.filename
      && current.mime_type === input.authored.mime_type
      && sameLocation(current.location, input.authored.location)
      && current.size_bytes === input.authored.size_bytes
      && current.width === input.authored.width
      && current.height === input.authored.height
      && current.duration_ms === input.authored.duration_ms
      && current.alt === input.authored.alt
    ) return { kind: 'completed', media: current };
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Media revision must advance.');
    }
    const location = locationColumns(input.authored.location);
    const result = await input.db.prepare(`
      UPDATE OR IGNORE media
      SET kind = ?, filename = ?, mime_type = ?, storage_type = ?,
          storage_key = ?, external_url = ?, size_bytes = ?, width = ?,
          height = ?, duration_ms = ?, alt = ?, revision = ?,
          updated_at_iso = ?
      WHERE id = ? AND revision = ?
    `).bind(
      input.authored.kind,
      input.authored.filename,
      input.authored.mime_type,
      location.storageType,
      location.storageKey,
      location.externalUrl,
      input.authored.size_bytes,
      input.authored.width,
      input.authored.height,
      input.authored.duration_ms,
      input.authored.alt,
      revision,
      (input.now ?? new Date()).toISOString(),
      input.id,
      input.authored.expected_revision,
    ).run();
    if (readChanges(result) === 0) {
      const latest = await readMedia(input.db, input.id);
      if (!latest) return { kind: 'not_found' };
      if (latest.revision !== input.authored.expected_revision) {
        return { kind: 'revision_conflict' };
      }
      return { kind: 'source_conflict' };
    }
    const media = await readMedia(input.db, input.id);
    if (!media) throw new TypeError('D1 did not return the updated Media.');
    return { kind: 'completed', media };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSourceConstraint(error)) return { kind: 'source_conflict' };
    if (isSiteAssetConstraint(error)) return { kind: 'in_use' };
    throw writeFailure(error, 'update_media');
  }
}

export async function bulkMutateMedia(input: {
  db: D1Database;
  request: BulkMediaOperationRequest;
  allowR2ObjectDeletion: boolean;
  now?: Date;
  createRevision?: () => string;
}): Promise<BulkMediaOperationResultData> {
  const identities = await readBulkMediaRows(
    input.db,
    input.request.items.map((item) => item.id),
  );
  const results: Array<BulkMediaOperationResult | undefined> =
    Array.from({ length: input.request.items.length });
  const cleanupKeys: string[] = [];

  if (input.request.operation === 'update_metadata') {
    const candidates: Array<{
      index: number;
      id: string;
      expectedRevision: string;
      filename: string;
      alt: string;
      nextRevision: string;
    }> = [];
    for (const [index, item] of input.request.items.entries()) {
      const current = identities.get(item.id);
      if (!current) {
        results[index] = { id: item.id, outcome: 'skipped', reason: 'not_found' };
      } else if (current.kind !== 'image' && item.alt !== '') {
        results[index] = {
          id: item.id,
          outcome: 'skipped',
          reason: 'alt_not_applicable',
        };
      } else if (
        current.filename === item.filename
        && current.alt === item.alt
      ) {
        results[index] = {
          id: item.id,
          outcome: 'unchanged',
          revision: current.revision,
        };
      } else if (current.revision !== item.expected_revision) {
        results[index] = { id: item.id, outcome: 'conflict' };
      } else {
        const nextRevision = settingsRevisionSchema.parse(
          (input.createRevision ?? createHexId)(),
        );
        if (nextRevision === current.revision) {
          throw dataInvalid(new TypeError('Media revision must advance.'));
        }
        candidates.push({
          index,
          id: item.id,
          expectedRevision: item.expected_revision,
          filename: item.filename,
          alt: item.alt,
          nextRevision,
        });
      }
    }

    if (candidates.length > 0) {
      let batchResults: D1Result<unknown>[];
      try {
        const nowIso = (input.now ?? new Date()).toISOString();
        batchResults = await input.db.batch(candidates.map((candidate) => (
          input.db.prepare(`
            UPDATE media
            SET filename = ?, alt = ?, revision = ?, updated_at_iso = ?
            WHERE id = ? AND revision = ?
          `).bind(
            candidate.filename,
            candidate.alt,
            candidate.nextRevision,
            nowIso,
            candidate.id,
            candidate.expectedRevision,
          )
        )));
      } catch (error) {
        throw writeFailure(error, 'bulk_update_media_metadata');
      }
      const unresolved: string[] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (readChanges(batchResults[candidateIndex]!) === 1) {
          results[candidate.index] = {
            id: candidate.id,
            outcome: 'updated',
            revision: candidate.nextRevision,
          };
        } else unresolved.push(candidate.id);
      }
      const latest = await readBulkMediaRows(input.db, unresolved);
      for (const candidate of candidates) {
        if (results[candidate.index]) continue;
        const current = latest.get(candidate.id);
        results[candidate.index] = !current
          ? { id: candidate.id, outcome: 'skipped', reason: 'not_found' }
          : current.filename === candidate.filename && current.alt === candidate.alt
            ? {
                id: candidate.id,
                outcome: 'unchanged',
                revision: current.revision,
              }
            : { id: candidate.id, outcome: 'conflict' };
      }
    }
  } else {
    const candidates: Array<{
      index: number;
      id: string;
      expectedRevision: string;
      cleanupKey: string | null;
    }> = [];
    for (const [index, item] of input.request.items.entries()) {
      const current = identities.get(item.id);
      if (!current) {
        results[index] = { id: item.id, outcome: 'skipped', reason: 'not_found' };
      } else if (current.revision !== item.expected_revision) {
        results[index] = { id: item.id, outcome: 'conflict' };
      } else if (
        current.usage.posts > 0
        || current.usage.pages > 0
        || current.usage.authors > 0
        || current.usage.branding > 0
      ) {
        results[index] = { id: item.id, outcome: 'skipped', reason: 'in_use' };
      } else {
        const cleanupKey = current.storageType === 'r2'
          && typeof current.storageKey === 'string'
          && isDeletableR2MediaStorageKey(current.storageKey)
          ? current.storageKey
          : null;
        if (cleanupKey && !input.allowR2ObjectDeletion) {
          results[index] = {
            id: item.id,
            outcome: 'skipped',
            reason: 'managed_storage_unavailable',
          };
        } else {
          candidates.push({
            index,
            id: item.id,
            expectedRevision: item.expected_revision,
            cleanupKey,
          });
        }
      }
    }

    if (candidates.length > 0) {
      const statements: D1PreparedStatement[] = [];
      const deletionResultIndexes: number[] = [];
      const nowIso = (input.now ?? new Date()).toISOString();
      for (const candidate of candidates) {
        if (candidate.cleanupKey) {
          statements.push(input.db.prepare(`
            INSERT OR IGNORE INTO media_object_deletions (
              storage_key, attempt_count, created_at_iso, last_attempt_at_iso
            )
            SELECT storage_key, 0, ?, NULL
            FROM media
            WHERE id = ? AND revision = ?
              AND storage_type = 'r2'
              AND storage_key = ?
              AND NOT EXISTS (
                SELECT 1 FROM posts WHERE posts.featured_image_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM pages WHERE pages.featured_image_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM authors WHERE authors.avatar_media_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM site_assets WHERE site_assets.media_id = media.id
              )
          `).bind(
            nowIso,
            candidate.id,
            candidate.expectedRevision,
            candidate.cleanupKey,
          ));
        }
        deletionResultIndexes.push(statements.length);
        statements.push(input.db.prepare(`
          DELETE FROM media
          WHERE id = ? AND revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM posts WHERE posts.featured_image_id = media.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM pages WHERE pages.featured_image_id = media.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM authors WHERE authors.avatar_media_id = media.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM site_assets WHERE site_assets.media_id = media.id
            )
        `).bind(candidate.id, candidate.expectedRevision));
      }
      let batchResults: D1Result<unknown>[];
      try {
        batchResults = await input.db.batch(statements);
      } catch (error) {
        throw writeFailure(error, 'bulk_delete_media');
      }
      const unresolved: string[] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (readChanges(batchResults[deletionResultIndexes[candidateIndex]]!) === 1) {
          if (candidate.cleanupKey) cleanupKeys.push(candidate.cleanupKey);
          results[candidate.index] = {
            id: candidate.id,
            outcome: 'updated',
            object_cleanup: candidate.cleanupKey ? 'pending' : 'not_applicable',
          };
        } else unresolved.push(candidate.id);
      }
      const latest = await readBulkMediaRows(input.db, unresolved);
      for (const candidate of candidates) {
        if (results[candidate.index]) continue;
        const current = latest.get(candidate.id);
        results[candidate.index] = !current
          ? {
              id: candidate.id,
              outcome: 'updated',
              object_cleanup: candidate.cleanupKey ? 'pending' : 'not_applicable',
            }
          : current.revision !== candidate.expectedRevision
            ? { id: candidate.id, outcome: 'conflict' }
            : {
                id: candidate.id,
                outcome: 'skipped',
                reason: 'in_use',
              };
      }
    }
  }

  const completed = results.map((result) => {
    if (!result) throw dataInvalid();
    return result;
  });
  return {
    ...summarizeBulkMediaOperation(input.request.operation, completed),
    cleanupKeys,
  };
}

export async function deleteMedia(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
  allowR2ObjectDeletion?: boolean;
  now?: Date;
}): Promise<DeleteMediaResult> {
  try {
    const current = await readMedia(input.db, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (
      current.usage.posts > 0
      || current.usage.pages > 0
      || current.usage.authors > 0
      || current.usage.branding > 0
    ) {
      return { kind: 'in_use' };
    }
    const cleanupKey = current.location.type === 'r2'
      && isDeletableR2MediaStorageKey(current.location.key)
      ? current.location.key
      : null;
    if (cleanupKey && input.allowR2ObjectDeletion === false) {
      return { kind: 'managed_object_unavailable' };
    }
    const statements = cleanupKey
      ? [
          input.db.prepare(`
            INSERT OR IGNORE INTO media_object_deletions (
              storage_key, attempt_count, created_at_iso, last_attempt_at_iso
            )
            SELECT storage_key, 0, ?, NULL
            FROM media
            WHERE id = ? AND revision = ?
              AND storage_type = 'r2'
              AND storage_key = ?
              AND NOT EXISTS (
                SELECT 1 FROM posts WHERE posts.featured_image_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM pages WHERE pages.featured_image_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM authors WHERE authors.avatar_media_id = media.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM site_assets WHERE site_assets.media_id = media.id
              )
          `).bind(
            (input.now ?? new Date()).toISOString(),
            input.id,
            input.expectedRevision,
            cleanupKey,
          ),
          input.db.prepare(`
            DELETE FROM media WHERE id = ? AND revision = ?
          `).bind(input.id, input.expectedRevision),
        ]
      : [input.db.prepare(`
          DELETE FROM media WHERE id = ? AND revision = ?
        `).bind(input.id, input.expectedRevision)];
    const results = await input.db.batch(statements);
    const deletionResult = results[results.length - 1]!;
    if (readChanges(deletionResult) === 1) {
      return { kind: 'completed', cleanupKey, filename: current.filename };
    }
    const latest = await readMedia(input.db, input.id);
    if (!latest) return { kind: 'not_found' };
    if (latest.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (
      latest.usage.posts > 0
      || latest.usage.pages > 0
      || latest.usage.authors > 0
      || latest.usage.branding > 0
    ) {
      return { kind: 'in_use' };
    }
    throw new TypeError('D1 ignored a valid Media deletion.');
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isForeignKeyConstraint(error)) return { kind: 'in_use' };
    throw writeFailure(error, 'delete_media');
  }
}
