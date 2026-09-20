import type {
  WxrCoreImportChunkRequest,
  WxrImportAuthorRow,
  WxrImportCategoryRow,
  WxrImportMediaRow,
  WxrImportMenuItem,
  WxrImportMenuRow,
  WxrImportPageRow,
  WxrImportPhase,
  WxrImportPostRow,
  WxrImportRowFailureCode,
  WxrImportTagRow,
} from '../../../contracts/wxr-import';
import {
  MENU_MAX_COUNT,
  canonicalizeMenuItems,
  menuItemIdSchema,
  menuItemsSchema,
  menuSchema,
  type Menu,
  type MenuItem,
} from '../../../contracts/menus';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import {
  mediaLocationIdentity,
} from '../../../contracts/media';
import { StudioOperationalError } from '../lib/operational-error';
import { getPost } from '../posts/post-repository';
import { getPage } from '../pages/page-repository';
import {
  archivePageRevisionStatements,
  archivePostRevisionStatements,
  preparePageRevision,
  preparePostRevision,
} from '../content-revisions/repository';
import { prepareContentSearchReplaceStatements } from '../content-search/index-repository';

type ImportDisposition = 'created' | 'updated' | 'unchanged';

export type WxrCoreImportChunkResult = {
  summary: {
    phase: WxrImportPhase;
    processed: number;
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
    failures: Array<{
      row_index: number;
      key: string;
      code: WxrImportRowFailureCode;
    }>;
  };
};

type RowResult =
  | { kind: ImportDisposition }
  | { kind: 'failed'; code: WxrImportRowFailureCode };

type ScalarRow = Record<string, unknown>;

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createRevision(createValue?: () => string): string {
  return settingsRevisionSchema.parse((createValue ?? createHexId)());
}

function readChanges(result: D1Result<unknown> | undefined): number {
  // D1 may include trigger side effects in this value. Content-table callers
  // must distinguish zero from a positive count instead of requiring one.
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('WXR_IMPORT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  if (error instanceof StudioOperationalError) return error;
  return new StudioOperationalError('WXR_IMPORT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function rowKey(phase: WxrImportPhase, row: unknown): string {
  const value = row as Record<string, unknown>;
  if (phase === 'authors') return String(value.id);
  if (phase === 'categories' || phase === 'tags') return String(value.slug);
  if (phase === 'media') {
    return String(value.external_id);
  }
  if (phase === 'menus') return String(value.menu_id);
  return String(value.public_id);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

type MetadataRequest = Extract<WxrCoreImportChunkRequest, {
  phase: 'authors' | 'categories' | 'tags' | 'media';
}>;

type PreparedImportRow = RowResult | {
  kind: 'write';
  statements: D1PreparedStatement[];
  summarize: (results: D1Result<unknown>[]) => RowResult;
};

type ImportedAuthorState = { id: string; display_name: string };
type ImportedTermState = { slug: string; name: string; description: string };
type ImportedMediaState = {
  id: string;
  external_id: number | null;
  kind: string;
  filename: string;
  mime_type: string;
  storage_type: string;
  storage_key: string | null;
  external_url: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt: string;
  revision: string;
};

const IN_QUERY_MAX_PARAMETERS = 100;

function selectIn(
  db: D1Database,
  query: string,
  values: readonly (string | number)[],
): D1PreparedStatement[] {
  const uniqueValues = [...new Set(values)];
  const statements = [];
  for (let offset = 0; offset < uniqueValues.length; offset += IN_QUERY_MAX_PARAMETERS) {
    const chunk = uniqueValues.slice(offset, offset + IN_QUERY_MAX_PARAMETERS);
    statements.push(db.prepare(`${query} IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk));
  }
  return statements;
}

async function readMetadata<T>(
  db: D1Database,
  statements: D1PreparedStatement[],
  action: string,
): Promise<T[]> {
  try {
    const results = await db.batch<T>(statements);
    return results.flatMap((result) => result.results ?? []);
  } catch (error) {
    throw queryFailure(error, action);
  }
}

function isMediaIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:idx_media_(?:external_id|external_url|storage_key)_unique|unique constraint failed:\s*media\.(?:external_id|external_url|storage_key))/iu.test(message);
}

async function writeMetadata(
  db: D1Database,
  rows: PreparedImportRow[],
  action: string,
): Promise<RowResult[]> {
  const statements = rows.flatMap((row) => row.kind === 'write' ? row.statements : []);
  if (statements.length === 0) return rows as RowResult[];
  try {
    const results = await db.batch(statements);
    let offset = 0;
    return rows.map((row) => {
      if (row.kind !== 'write') return row;
      const result = row.summarize(results.slice(offset, offset + row.statements.length));
      offset += row.statements.length;
      return result;
    });
  } catch (error) {
    if (action !== 'upsert_wxr_media' || !isMediaIdentityConflict(error)) {
      throw writeFailure(error, action);
    }
    // A constraint failure rolls back the whole D1 batch. Retry only this
    // known rollback case, keeping revision guards and per-row conflicts.
    const results: RowResult[] = [];
    for (const row of rows) {
      if (row.kind !== 'write') {
        results.push(row);
        continue;
      }
      try {
        results.push(row.summarize(await db.batch(row.statements)));
      } catch (rowError) {
        if (!isMediaIdentityConflict(rowError)) throw writeFailure(rowError, action);
        results.push({ kind: 'failed', code: 'MEDIA_EXTERNAL_ID_CONFLICT' });
      }
    }
    return results;
  }
}

function prepareAuthor(input: {
  db: D1Database;
  row: WxrImportAuthorRow;
  current: ImportedAuthorState | undefined;
  nowIso: string;
  createRevision?: () => string;
}): PreparedImportRow {
  if (input.current?.display_name === input.row.display_name) {
    return { kind: 'unchanged' };
  }
  const statements = [];
  if (!input.current) {
    statements.push(input.db.prepare(`
      INSERT OR IGNORE INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES (?, NULL, ?, ?, ?, ?)
    `).bind(
      input.row.id,
      input.row.display_name,
      createRevision(input.createRevision),
      input.nowIso,
      input.nowIso,
    ));
  }
  // Also handles an author inserted concurrently after the chunk lookup.
  statements.push(input.db.prepare(`
    UPDATE authors
    SET display_name = ?, revision = ?, updated_at_iso = ?
    WHERE id = ? AND display_name != ?
  `).bind(
    input.row.display_name,
    createRevision(input.createRevision),
    input.nowIso,
    input.row.id,
    input.row.display_name,
  ));
  return {
    kind: 'write',
    statements,
    summarize: (results) => ({
      kind: !input.current && readChanges(results[0]) === 1
        ? 'created'
        : readChanges(results.at(-1)) === 1 ? 'updated' : 'unchanged',
    }),
  };
}

function prepareTaxonomy(input: {
  db: D1Database;
  table: 'categories' | 'tags';
  row: WxrImportCategoryRow | WxrImportTagRow;
  current: ImportedTermState | undefined;
  nowIso: string;
  createId?: () => string;
  createRevision?: () => string;
}): PreparedImportRow {
  if (
    input.current?.name === input.row.name
    && input.current.description === input.row.description
  ) return { kind: 'unchanged' };
  const statements = [];
  if (!input.current) {
    statements.push(input.db.prepare(`
      INSERT OR IGNORE INTO ${input.table} (
        id, name, slug, description, revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      (input.createId ?? createHexId)(),
      input.row.name,
      input.row.slug,
      input.row.description,
      createRevision(input.createRevision),
      input.nowIso,
      input.nowIso,
    ));
  }
  statements.push(input.db.prepare(`
    UPDATE ${input.table}
    SET name = ?, description = ?, revision = ?, updated_at_iso = ?
    WHERE slug = ? AND (name != ? OR description != ?)
  `).bind(
    input.row.name,
    input.row.description,
    createRevision(input.createRevision),
    input.nowIso,
    input.row.slug,
    input.row.name,
    input.row.description,
  ));
  return {
    kind: 'write',
    statements,
    summarize: (results) => ({
      kind: !input.current && readChanges(results[0]) === 1
        ? 'created'
        : readChanges(results.at(-1)) === 1 ? 'updated' : 'unchanged',
    }),
  };
}

async function readMedia(db: D1Database, rows: readonly WxrImportMediaRow[]) {
  const select = `
    SELECT id, external_id, kind, filename, mime_type, storage_type,
      storage_key, external_url, size_bytes, width, height, duration_ms,
      alt, revision
    FROM media WHERE
  `;
  const matches = await readMetadata<ImportedMediaState>(db, [
    ...selectIn(db, `${select} external_id`, rows.map((row) => row.external_id)),
    ...selectIn(db, `${select} storage_type = 'external' AND external_url`,
      rows.flatMap((row) => row.location.type === 'external' ? [row.location.url] : [])),
    ...selectIn(db, `${select} storage_type = 'r2' AND storage_key`,
      rows.flatMap((row) => row.location.type === 'r2' ? [row.location.key] : [])),
  ], 'read_wxr_media');
  return [...new Map(matches.map((row) => [row.id, row])).values()];
}

function mediaOwners(row: WxrImportMediaRow, current: readonly ImportedMediaState[]) {
  return current.filter((value) => value.external_id === row.external_id
    || (row.location.type === 'external'
      ? value.storage_type === 'external' && value.external_url === row.location.url
      : value.storage_type === 'r2' && value.storage_key === row.location.key));
}

function prepareMedia(input: {
  db: D1Database;
  row: WxrImportMediaRow;
  owners: readonly ImportedMediaState[];
  nowIso: string;
  createId?: () => string;
  createRevision?: () => string;
}): PreparedImportRow {
  const storageType = input.row.location.type;
  const storageKey = input.row.location.type === 'r2' ? input.row.location.key : null;
  const externalUrl = input.row.location.type === 'external' ? input.row.location.url : null;
  const identityOwner = input.owners.find((row) => row.external_id === input.row.external_id);
  const locationOwner = input.owners.find((row) => (
    (row.storage_type === 'external' && row.external_url === externalUrl)
    || (row.storage_type === 'r2' && row.storage_key === storageKey)
  ));
  if (
    (identityOwner && locationOwner && identityOwner.id !== locationOwner.id)
    || (!identityOwner && locationOwner && locationOwner.external_id !== null)
  ) return { kind: 'failed', code: 'MEDIA_EXTERNAL_ID_CONFLICT' };
  const current = identityOwner ?? locationOwner;
  if (
    current
    && current.external_id === input.row.external_id
    && current.kind === input.row.kind
    && current.filename === input.row.filename
    && current.mime_type === input.row.mime_type
    && current.storage_type === storageType
    && current.storage_key === storageKey
    && current.external_url === externalUrl
    && current.size_bytes === input.row.size_bytes
    && current.width === input.row.width
    && current.height === input.row.height
    && current.duration_ms === input.row.duration_ms
    && current.alt === input.row.alt
  ) return { kind: 'unchanged' };

  if (!current) {
    const statement = input.db.prepare(`
      INSERT OR IGNORE INTO media (
        id, external_id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt,
        revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      (input.createId ?? createHexId)(),
      input.row.external_id,
      input.row.kind,
      input.row.filename,
      input.row.mime_type,
      storageType,
      storageKey,
      externalUrl,
      input.row.size_bytes,
      input.row.width,
      input.row.height,
      input.row.duration_ms,
      input.row.alt,
      createRevision(input.createRevision),
      input.nowIso,
      input.nowIso,
    );
    return {
      kind: 'write',
      statements: [statement],
      summarize: ([result]) => readChanges(result) === 1
        ? { kind: 'created' }
        : { kind: 'failed', code: 'MEDIA_EXTERNAL_ID_CONFLICT' },
    };
  }
  const revision = createRevision(input.createRevision);
  if (revision === current.revision) {
    throw writeFailure(new TypeError('Imported Media revision must advance.'), 'upsert_wxr_media');
  }
  const statement = input.db.prepare(`
    UPDATE media
    SET external_id = ?, kind = ?, filename = ?, mime_type = ?,
      storage_type = ?, storage_key = ?, external_url = ?, size_bytes = ?,
      width = ?, height = ?, duration_ms = ?, alt = ?, revision = ?,
      updated_at_iso = ?
    WHERE id = ? AND revision = ?
  `).bind(
    input.row.external_id,
    input.row.kind,
    input.row.filename,
    input.row.mime_type,
    storageType,
    storageKey,
    externalUrl,
    input.row.size_bytes,
    input.row.width,
    input.row.height,
    input.row.duration_ms,
    input.row.alt,
    revision,
    input.nowIso,
    current.id,
    current.revision,
  );
  return {
    kind: 'write',
    statements: [statement],
    summarize: ([result]) => readChanges(result) === 1
      ? { kind: 'updated' }
      : { kind: 'failed', code: 'REVISION_CONFLICT' },
  };
}

async function importMetadataChunk(input: {
  db: D1Database;
  request: MetadataRequest;
  nowIso: string;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<RowResult[]> {
  const { db, request } = input;
  const keys = request.rows.map((row) => rowKey(request.phase, row));
  if (new Set(keys).size !== keys.length) {
    // Repeated identities must observe earlier writes in source order.
    const results: RowResult[] = [];
    for (const row of request.rows) {
      results.push(...await importMetadataChunk({
        ...input, request: { phase: request.phase, rows: [row] } as MetadataRequest,
      }));
    }
    return results;
  }
  if (request.phase === 'authors') {
    const current = await readMetadata<ImportedAuthorState>(db,
      selectIn(db, 'SELECT id, display_name FROM authors WHERE id', keys), 'read_wxr_author');
    const byId = new Map(current.map((row) => [row.id, row]));
    return writeMetadata(db, request.rows.map((row) => prepareAuthor({
      ...input, row, current: byId.get(row.id),
    })), 'upsert_wxr_author');
  }
  if (request.phase === 'categories' || request.phase === 'tags') {
    const current = await readMetadata<ImportedTermState>(db,
      selectIn(db, `SELECT slug, name, description FROM ${request.phase} WHERE slug`, keys),
      `read_wxr_${request.phase}`);
    const bySlug = new Map(current.map((row) => [row.slug, row]));
    return writeMetadata(db, request.rows.map((row) => prepareTaxonomy({
      ...input, table: request.phase, row, current: bySlug.get(row.slug),
    })), `upsert_wxr_${request.phase}`);
  }
  const current = await readMedia(db, request.rows);
  const owners = request.rows.map((row) => mediaOwners(row, current));
  const touchedIds = owners.flatMap((matches) => matches.map((row) => row.id));
  const locations = request.rows.map((row) => mediaLocationIdentity(row.location));
  if (
    new Set(touchedIds).size !== touchedIds.length
    || new Set(locations).size !== locations.length
  ) {
    // A relocation can free or claim another row's location. Refresh after
    // each write so these uncommon dependencies retain source-order behavior.
    const results: RowResult[] = [];
    for (const row of request.rows) {
      results.push(...await writeMetadata(db, [prepareMedia({
        ...input, row, owners: await readMedia(db, [row]),
      })], 'upsert_wxr_media'));
    }
    return results;
  }
  return writeMetadata(db, request.rows.map((row, index) => prepareMedia({
    ...input, row, owners: owners[index]!,
  })), 'upsert_wxr_media');
}

type PostState = {
  id: string;
  title: string;
  slug: string;
  content: string;
  document_type: string;
  editor_mode: string;
  editor_profile: string | null;
  excerpt: string;
  status: string;
  author_id: string;
  discoverability: string;
  allow_comments: number;
  featured_image_identity: string | null;
  published_at_iso: string | null;
  revision: string;
  created_at_iso: string;
  updated_at_iso: string;
  category_slugs: string[];
  tag_slugs: string[];
};

async function readPostState(
  db: D1Database,
  publicId: number,
): Promise<PostState | null> {
  try {
    const results = await db.batch<ScalarRow>([
      db.prepare(`
        SELECT posts.id, posts.title, posts.slug, posts.content,
          posts.document_type, posts.editor_mode, posts.editor_profile,
          posts.excerpt, posts.status, posts.author_id,
          posts.discoverability, posts.allow_comments,
          CASE media.storage_type
            WHEN 'external' THEN 'external:' || media.external_url
            WHEN 'r2' THEN 'r2:' || media.storage_key
            ELSE NULL
          END AS featured_image_identity,
          posts.published_at_iso,
          posts.revision, posts.created_at_iso, posts.updated_at_iso
        FROM posts
        LEFT JOIN media ON media.id = posts.featured_image_id
        WHERE posts.public_id = ?
        LIMIT 1
      `).bind(publicId),
      db.prepare(`
        SELECT categories.slug
        FROM post_categories
        INNER JOIN posts ON posts.id = post_categories.post_id
        INNER JOIN categories ON categories.id = post_categories.category_id
        WHERE posts.public_id = ?
        ORDER BY categories.slug
      `).bind(publicId),
      db.prepare(`
        SELECT tags.slug
        FROM post_tags
        INNER JOIN posts ON posts.id = post_tags.post_id
        INNER JOIN tags ON tags.id = post_tags.tag_id
        WHERE posts.public_id = ?
        ORDER BY post_tags.sort_order, tags.id
      `).bind(publicId),
    ]);
    const row = results[0]?.results?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...(row as Omit<PostState, 'category_slugs' | 'tag_slugs'>),
      category_slugs: (results[1]?.results ?? []).map((entry) => (
        String((entry as ScalarRow).slug)
      )),
      tag_slugs: (results[2]?.results ?? []).map((entry) => (
        String((entry as ScalarRow).slug)
      )),
    };
  } catch (error) {
    throw queryFailure(error, 'read_wxr_post');
  }
}

async function resolvePostReferences(input: {
  db: D1Database;
  row: WxrImportPostRow;
}): Promise<
  | { categoryIds: string[]; tagIds: string[]; mediaId: string | null }
  | { failure: WxrImportRowFailureCode }
> {
  const categoryPlaceholders = input.row.category_slugs.map(() => '?').join(', ');
  const tagPlaceholders = input.row.tag_slugs.map(() => '?').join(', ');
  try {
    const statements: D1PreparedStatement[] = [
      input.db.prepare('SELECT id FROM authors WHERE id = ? LIMIT 1')
        .bind(input.row.author_id),
      input.row.category_slugs.length > 0
        ? input.db.prepare(`
            SELECT id, slug FROM categories
            WHERE slug IN (${categoryPlaceholders})
          `).bind(...input.row.category_slugs)
        : input.db.prepare('SELECT id, slug FROM categories WHERE 0'),
      input.row.tag_slugs.length > 0
        ? input.db.prepare(`
            SELECT id, slug FROM tags WHERE slug IN (${tagPlaceholders})
          `).bind(...input.row.tag_slugs)
        : input.db.prepare('SELECT id, slug FROM tags WHERE 0'),
      input.row.featured_image_location
        ? input.db.prepare(`
            SELECT id FROM media
            WHERE kind = 'image' AND width IS NOT NULL AND height IS NOT NULL
              AND (
                (storage_type = 'external' AND external_url = ?)
                OR (storage_type = 'r2' AND storage_key = ?)
              )
            LIMIT 1
          `).bind(
            input.row.featured_image_location.type === 'external'
              ? input.row.featured_image_location.url
              : null,
            input.row.featured_image_location.type === 'r2'
              ? input.row.featured_image_location.key
              : null,
          )
        : input.db.prepare('SELECT id FROM media WHERE 0'),
    ];
    const results = await input.db.batch<ScalarRow>(statements);
    if ((results[0]?.results?.length ?? 0) !== 1) {
      return { failure: 'AUTHOR_NOT_FOUND' };
    }
    const categoryMap = new Map((results[1]?.results ?? []).map((row) => [
      String((row as ScalarRow).slug),
      String((row as ScalarRow).id),
    ]));
    const tagMap = new Map((results[2]?.results ?? []).map((row) => [
      String((row as ScalarRow).slug),
      String((row as ScalarRow).id),
    ]));
    if (categoryMap.size !== input.row.category_slugs.length
      || tagMap.size !== input.row.tag_slugs.length) {
      return { failure: 'TAXONOMY_TERM_NOT_FOUND' };
    }
    const mediaId = input.row.featured_image_location
      ? String(results[3]?.results?.[0]?.id ?? '')
      : null;
    if (input.row.featured_image_location && !mediaId) {
      return { failure: 'MEDIA_NOT_FOUND' };
    }
    return {
      categoryIds: input.row.category_slugs.map((slug) => categoryMap.get(slug)!),
      tagIds: input.row.tag_slugs.map((slug) => tagMap.get(slug)!),
      mediaId,
    };
  } catch (error) {
    throw queryFailure(error, 'resolve_wxr_post_references');
  }
}

function postMatches(state: PostState, row: WxrImportPostRow): boolean {
  return state.title === row.title
    && state.slug === row.slug
    && state.content === row.content
    && state.document_type === row.document_type
    && state.editor_mode === row.editor_mode
    && state.editor_profile === row.editor_profile
    && state.excerpt === row.excerpt
    && state.status === row.status
    && state.author_id === row.author_id
    && state.discoverability === row.discoverability
    && Boolean(state.allow_comments) === row.allow_comments
    && state.featured_image_identity === (
      row.featured_image_location
        ? mediaLocationIdentity(row.featured_image_location)
        : null
    )
    && state.published_at_iso === row.published_at_iso
    && state.created_at_iso === row.created_at_iso
    && state.updated_at_iso === row.updated_at_iso
    && sameStrings(state.category_slugs, [...row.category_slugs].sort())
    && sameStrings(state.tag_slugs, row.tag_slugs);
}

function postRelationStatements(input: {
  db: D1Database;
  postId: string;
  categoryIds: string[];
  tagIds: string[];
  guardRevision?: string;
  replaceExisting?: boolean;
}): D1PreparedStatement[] {
  const guard = input.guardRevision;
  const replaceExisting = input.replaceExisting ?? true;
  const statements: D1PreparedStatement[] = [];
  if (replaceExisting) {
    statements.push(input.db.prepare(`
      DELETE FROM post_categories
      WHERE post_id = ?
        ${guard ? 'AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND revision = ?)' : ''}
    `).bind(input.postId, ...(guard ? [input.postId, guard] : [])));
  }
  if (input.categoryIds.length > 0) {
    statements.push(guard
      ? input.db.prepare(`
          INSERT INTO post_categories (post_id, category_id)
          SELECT ?, CAST(value AS TEXT)
          FROM json_each(?)
          WHERE EXISTS (
            SELECT 1 FROM posts WHERE id = ? AND revision = ?
          )
        `).bind(
          input.postId,
          JSON.stringify(input.categoryIds),
          input.postId,
          guard,
        )
      : input.db.prepare(`
          INSERT INTO post_categories (post_id, category_id)
          SELECT ?, CAST(value AS TEXT) FROM json_each(?)
        `).bind(input.postId, JSON.stringify(input.categoryIds)));
  }
  if (replaceExisting) {
    statements.push(input.db.prepare(`
      DELETE FROM post_tags
      WHERE post_id = ?
        ${guard ? 'AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND revision = ?)' : ''}
    `).bind(input.postId, ...(guard ? [input.postId, guard] : [])));
  }
  if (input.tagIds.length > 0) {
    statements.push(guard
      ? input.db.prepare(`
          INSERT INTO post_tags (post_id, tag_id, sort_order)
          SELECT ?, CAST(value AS TEXT), CAST(key AS INTEGER)
          FROM json_each(?)
          WHERE EXISTS (
            SELECT 1 FROM posts WHERE id = ? AND revision = ?
          )
        `).bind(
          input.postId,
          JSON.stringify(input.tagIds),
          input.postId,
          guard,
        )
      : input.db.prepare(`
          INSERT INTO post_tags (post_id, tag_id, sort_order)
          SELECT ?, CAST(value AS TEXT), CAST(key AS INTEGER)
          FROM json_each(?)
        `).bind(input.postId, JSON.stringify(input.tagIds)));
  }
  return statements;
}

async function postSlugOwner(
  db: D1Database,
  slug: string,
): Promise<{ id: unknown } | null> {
  try {
    return await db.prepare('SELECT id FROM posts WHERE slug = ? LIMIT 1')
      .bind(slug).first<{ id: unknown }>();
  } catch (error) {
    throw queryFailure(error, 'read_wxr_post_slug_owner');
  }
}

async function importPost(input: {
  db: D1Database;
  row: WxrImportPostRow;
  nowIso: string;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<RowResult> {
  const current = await readPostState(input.db, input.row.public_id);
  const slugOwner = await postSlugOwner(input.db, input.row.slug);
  if (slugOwner && String(slugOwner.id) !== current?.id) {
    return { kind: 'failed', code: 'SLUG_CONFLICT' };
  }
  const references = await resolvePostReferences(input);
  if ('failure' in references) {
    return { kind: 'failed', code: references.failure };
  }
  if (current && postMatches(current, input.row)) {
    return { kind: 'unchanged' };
  }
  const archivedRevision = current
    ? await (async () => {
        try {
          const post = await getPost({ db: input.db, id: current.id });
          if (!post) throw new TypeError('Imported Post disappeared.');
          return await preparePostRevision(post);
        } catch (error) {
          throw queryFailure(error, 'read_wxr_post_revision_source');
        }
      })()
    : null;
  const revision = createRevision(input.createRevision);
  try {
    if (!current) {
      const id = (input.createId ?? createHexId)();
      await input.db.batch([
        input.db.prepare(`
          INSERT INTO posts (
            id, public_id, title, slug, content, document_type,
            editor_mode, editor_profile, excerpt,
            status, author_id, discoverability, allow_comments,
            featured_image_id, published_at_iso, revision, created_at_iso,
            updated_at_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id,
          input.row.public_id,
          input.row.title,
          input.row.slug,
          input.row.content,
          input.row.document_type,
          input.row.editor_mode,
          input.row.editor_profile,
          input.row.excerpt,
          input.row.status,
          input.row.author_id,
          input.row.discoverability,
          input.row.allow_comments ? 1 : 0,
          references.mediaId,
          input.row.published_at_iso,
          revision,
          input.row.created_at_iso,
          input.row.updated_at_iso,
        ),
        ...postRelationStatements({
          db: input.db,
          postId: id,
          categoryIds: references.categoryIds,
          tagIds: references.tagIds,
          replaceExisting: false,
        }),
        ...prepareContentSearchReplaceStatements({
          db: input.db,
          targetType: 'post',
          document: {
            publicId: input.row.public_id,
            revision,
            title: input.row.title,
            slug: input.row.slug,
            excerpt: input.row.excerpt,
            content: input.row.content,
            documentType: input.row.document_type,
          },
        }),
      ]);
      return { kind: 'created' };
    }

    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE OR IGNORE posts
        SET title = ?, slug = ?, content = ?, document_type = ?,
          editor_mode = ?, editor_profile = ?, excerpt = ?, status = ?,
          author_id = ?, discoverability = ?, allow_comments = ?,
          featured_image_id = ?, published_at_iso = ?, revision = ?,
          created_at_iso = ?, updated_at_iso = ?
        WHERE id = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM post_revisions
            WHERE post_id = ? AND revision_id = ?
          )
      `).bind(
        input.row.title,
        input.row.slug,
        input.row.content,
        input.row.document_type,
        input.row.editor_mode,
        input.row.editor_profile,
        input.row.excerpt,
        input.row.status,
        input.row.author_id,
        input.row.discoverability,
        input.row.allow_comments ? 1 : 0,
        references.mediaId,
        input.row.published_at_iso,
        revision,
        input.row.created_at_iso,
        input.row.updated_at_iso,
        current.id,
        current.revision,
        current.id,
        revision,
      ),
      ...archivePostRevisionStatements({
        db: input.db,
        postId: current.id,
        guardRevision: revision,
        archivedAtIso: input.nowIso,
        prepared: archivedRevision!,
      }),
      ...postRelationStatements({
        db: input.db,
        postId: current.id,
        categoryIds: references.categoryIds,
        tagIds: references.tagIds,
        guardRevision: revision,
      }),
      ...prepareContentSearchReplaceStatements({
        db: input.db,
        targetType: 'post',
        document: {
          publicId: input.row.public_id,
          revision,
          title: input.row.title,
          slug: input.row.slug,
          excerpt: input.row.excerpt,
          content: input.row.content,
          documentType: input.row.document_type,
        },
      }),
    ]);
    if (readChanges(results[0]) > 0) {
      return { kind: 'updated' };
    }
    const latestOwner = await postSlugOwner(input.db, input.row.slug);
    if (latestOwner && String(latestOwner.id) !== current.id) {
      return { kind: 'failed', code: 'SLUG_CONFLICT' };
    }
    return { kind: 'failed', code: 'REVISION_CONFLICT' };
  } catch (error) {
    throw writeFailure(error, 'upsert_wxr_post');
  }
}

type PageState = {
  id: string;
  parent_public_id: number | null;
  title: string;
  slug: string;
  content: string;
  document_type: string;
  editor_mode: string;
  editor_profile: string | null;
  excerpt: string;
  status: string;
  discoverability: string;
  allow_comments: number;
  featured_image_identity: string | null;
  revision: string;
  created_at_iso: string;
  updated_at_iso: string;
};

async function readPageState(
  db: D1Database,
  publicId: number,
): Promise<PageState | null> {
  try {
    const row = await db.prepare(`
      SELECT pages.id, parent.public_id AS parent_public_id, pages.title,
        pages.slug, pages.content, pages.document_type,
        pages.editor_mode, pages.editor_profile, pages.excerpt,
        pages.status, pages.discoverability, pages.allow_comments,
        CASE media.storage_type
          WHEN 'external' THEN 'external:' || media.external_url
          WHEN 'r2' THEN 'r2:' || media.storage_key
          ELSE NULL
        END AS featured_image_identity,
        pages.revision,
        pages.created_at_iso, pages.updated_at_iso
      FROM pages
      LEFT JOIN pages AS parent ON parent.id = pages.parent_id
      LEFT JOIN media ON media.id = pages.featured_image_id
      WHERE pages.public_id = ?
      LIMIT 1
    `).bind(publicId).first<PageState>();
    return row ?? null;
  } catch (error) {
    throw queryFailure(error, 'read_wxr_page');
  }
}

async function resolvePageReferences(input: {
  db: D1Database;
  row: WxrImportPageRow;
}): Promise<
  | { parentId: string | null; mediaId: string | null }
  | { failure: WxrImportRowFailureCode }
> {
  try {
    const results = await input.db.batch<ScalarRow>([
      input.row.parent_public_id === null
        ? input.db.prepare('SELECT id FROM pages WHERE 0')
        : input.db.prepare(`
            SELECT id FROM pages
            WHERE public_id = ? AND status != 'trash'
            LIMIT 1
          `).bind(input.row.parent_public_id),
      input.row.featured_image_location === null
        ? input.db.prepare('SELECT id FROM media WHERE 0')
        : input.db.prepare(`
            SELECT id FROM media
            WHERE kind = 'image' AND width IS NOT NULL AND height IS NOT NULL
              AND (
                (storage_type = 'external' AND external_url = ?)
                OR (storage_type = 'r2' AND storage_key = ?)
              )
            LIMIT 1
          `).bind(
            input.row.featured_image_location.type === 'external'
              ? input.row.featured_image_location.url
              : null,
            input.row.featured_image_location.type === 'r2'
              ? input.row.featured_image_location.key
              : null,
          ),
    ]);
    const parentId = input.row.parent_public_id === null
      ? null
      : String(results[0]?.results?.[0]?.id ?? '');
    if (input.row.parent_public_id !== null && !parentId) {
      return { failure: 'PAGE_PARENT_NOT_FOUND' };
    }
    const mediaId = input.row.featured_image_location === null
      ? null
      : String(results[1]?.results?.[0]?.id ?? '');
    if (input.row.featured_image_location !== null && !mediaId) {
      return { failure: 'MEDIA_NOT_FOUND' };
    }
    return { parentId, mediaId };
  } catch (error) {
    throw queryFailure(error, 'resolve_wxr_page_references');
  }
}

async function pageSlugOwner(input: {
  db: D1Database;
  parentId: string | null;
  slug: string;
}): Promise<{ id: unknown } | null> {
  try {
    return input.parentId === null
      ? await input.db.prepare(`
          SELECT id FROM pages
          WHERE parent_id IS NULL AND slug = ?
          LIMIT 1
        `).bind(input.slug).first<{ id: unknown }>()
      : await input.db.prepare(`
          SELECT id FROM pages
          WHERE parent_id = ? AND slug = ?
          LIMIT 1
        `).bind(input.parentId, input.slug).first<{ id: unknown }>();
  } catch (error) {
    throw queryFailure(error, 'read_wxr_page_slug_owner');
  }
}

async function wouldCreatePageCycle(input: {
  db: D1Database;
  pageId: string;
  parentId: string | null;
}): Promise<boolean> {
  if (input.parentId === null) return false;
  try {
    const row = await input.db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM pages WHERE id = ?
        UNION
        SELECT pages.id, pages.parent_id
        FROM pages
        INNER JOIN ancestors ON pages.id = ancestors.parent_id
      )
      SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1
    `).bind(input.parentId, input.pageId).first<{ found: unknown }>();
    return row !== null;
  } catch (error) {
    throw queryFailure(error, 'validate_wxr_page_parent');
  }
}

async function isFrontPage(db: D1Database, pageId: string): Promise<boolean> {
  try {
    const row = await db.prepare(`
      SELECT 1 AS found
      FROM site_settings
      WHERE key = 'site_front_page'
        AND type = 'json'
        AND json_extract(value, '$.type') = 'page'
        AND json_extract(value, '$.page_id') = ?
      LIMIT 1
    `).bind(pageId).first<{ found: unknown }>();
    return row !== null;
  } catch (error) {
    throw queryFailure(error, 'validate_wxr_front_page');
  }
}

function pageMatches(state: PageState, row: WxrImportPageRow): boolean {
  return state.parent_public_id === row.parent_public_id
    && state.title === row.title
    && state.slug === row.slug
    && state.content === row.content
    && state.document_type === row.document_type
    && state.editor_mode === row.editor_mode
    && state.editor_profile === row.editor_profile
    && state.excerpt === row.excerpt
    && state.status === row.status
    && state.discoverability === row.discoverability
    && Boolean(state.allow_comments) === row.allow_comments
    && state.featured_image_identity === (
      row.featured_image_location
        ? mediaLocationIdentity(row.featured_image_location)
        : null
    )
    && state.created_at_iso === row.created_at_iso
    && state.updated_at_iso === row.updated_at_iso;
}

async function importPage(input: {
  db: D1Database;
  row: WxrImportPageRow;
  nowIso: string;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<RowResult> {
  const current = await readPageState(input.db, input.row.public_id);
  const references = await resolvePageReferences(input);
  if ('failure' in references) {
    return { kind: 'failed', code: references.failure };
  }
  const slugOwner = await pageSlugOwner({
    db: input.db,
    parentId: references.parentId,
    slug: input.row.slug,
  });
  if (slugOwner && String(slugOwner.id) !== current?.id) {
    return { kind: 'failed', code: 'SLUG_CONFLICT' };
  }
  if (
    current
    && await wouldCreatePageCycle({
      db: input.db,
      pageId: current.id,
      parentId: references.parentId,
    })
  ) return { kind: 'failed', code: 'PAGE_PARENT_CYCLE' };
  if (
    current
    && current.status === 'published'
    && input.row.status !== 'published'
    && await isFrontPage(input.db, current.id)
  ) return { kind: 'failed', code: 'PAGE_IS_FRONT_PAGE' };

  if (current && pageMatches(current, input.row)) {
    return { kind: 'unchanged' };
  }
  const archivedRevision = current
    ? await (async () => {
        try {
          const page = await getPage({ db: input.db, id: current.id });
          if (!page) throw new TypeError('Imported Page disappeared.');
          return await preparePageRevision(page);
        } catch (error) {
          throw queryFailure(error, 'read_wxr_page_revision_source');
        }
      })()
    : null;
  const revision = createRevision(input.createRevision);
  try {
    if (!current) {
      const id = (input.createId ?? createHexId)();
      const results = await input.db.batch([
        input.db.prepare(`
          INSERT INTO pages (
            id, public_id, parent_id, title, slug, content, document_type,
            editor_mode, editor_profile, excerpt, status, discoverability,
            allow_comments, featured_image_id, revision, created_at_iso,
            updated_at_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id,
          input.row.public_id,
          references.parentId,
          input.row.title,
          input.row.slug,
          input.row.content,
          input.row.document_type,
          input.row.editor_mode,
          input.row.editor_profile,
          input.row.excerpt,
          input.row.status,
          input.row.discoverability,
          input.row.allow_comments ? 1 : 0,
          references.mediaId,
          revision,
          input.row.created_at_iso,
          input.row.updated_at_iso,
        ),
        ...prepareContentSearchReplaceStatements({
          db: input.db,
          targetType: 'page',
          document: {
            publicId: input.row.public_id,
            revision,
            title: input.row.title,
            slug: input.row.slug,
            excerpt: input.row.excerpt,
            content: input.row.content,
            documentType: input.row.document_type,
          },
        }),
      ]);
      if (readChanges(results[0]) === 0) {
        throw new TypeError('D1 did not insert an imported Page.');
      }
      return { kind: 'created' };
    }
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE OR IGNORE pages
        SET parent_id = ?, title = ?, slug = ?, content = ?, document_type = ?,
          editor_mode = ?, editor_profile = ?, excerpt = ?, status = ?,
          discoverability = ?, allow_comments = ?,
          featured_image_id = ?, revision = ?, created_at_iso = ?,
          updated_at_iso = ?
        WHERE id = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM page_revisions
            WHERE page_id = ? AND revision_id = ?
          )
      `).bind(
        references.parentId,
        input.row.title,
        input.row.slug,
        input.row.content,
        input.row.document_type,
        input.row.editor_mode,
        input.row.editor_profile,
        input.row.excerpt,
        input.row.status,
        input.row.discoverability,
        input.row.allow_comments ? 1 : 0,
        references.mediaId,
        revision,
        input.row.created_at_iso,
        input.row.updated_at_iso,
        current.id,
        current.revision,
        current.id,
        revision,
      ),
      ...archivePageRevisionStatements({
        db: input.db,
        pageId: current.id,
        guardRevision: revision,
        archivedAtIso: input.nowIso,
        prepared: archivedRevision!,
      }),
      ...prepareContentSearchReplaceStatements({
        db: input.db,
        targetType: 'page',
        document: {
          publicId: input.row.public_id,
          revision,
          title: input.row.title,
          slug: input.row.slug,
          excerpt: input.row.excerpt,
          content: input.row.content,
          documentType: input.row.document_type,
        },
      }),
    ]);
    if (readChanges(results[0]) > 0) {
      return { kind: 'updated' };
    }
    const latestOwner = await pageSlugOwner({
      db: input.db,
      parentId: references.parentId,
      slug: input.row.slug,
    });
    if (latestOwner && String(latestOwner.id) !== current.id) {
      return { kind: 'failed', code: 'SLUG_CONFLICT' };
    }
    return { kind: 'failed', code: 'REVISION_CONFLICT' };
  } catch (error) {
    throw writeFailure(error, 'upsert_wxr_page');
  }
}

type WxrMenuDatabaseRow = {
  menu_id?: unknown;
  name?: unknown;
  enabled?: unknown;
  items?: unknown;
  revision?: unknown;
  created_at_iso?: unknown;
  updated_at_iso?: unknown;
};

type WxrMenuReferenceRow = {
  id?: unknown;
  source_key?: unknown;
};

function parseWxrStoredMenu(row: WxrMenuDatabaseRow): Menu {
  if (typeof row.items !== 'string') {
    throw new TypeError('D1 returned invalid imported Menu items.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.items);
  } catch {
    throw new TypeError('D1 returned malformed imported Menu items.');
  }
  const parsedItems = menuItemsSchema.safeParse(decoded);
  if (!parsedItems.success) {
    throw new TypeError('D1 returned invalid imported Menu items.');
  }
  const items = canonicalizeMenuItems(parsedItems.data);
  if (JSON.stringify(items) !== row.items) {
    throw new TypeError('D1 returned non-canonical imported Menu items.');
  }
  const parsed = menuSchema.safeParse({
    ...row,
    enabled: row.enabled === 1 ? true : row.enabled === 0 ? false : row.enabled,
    items,
  });
  if (!parsed.success) throw new TypeError('D1 returned invalid imported Menu data.');
  return parsed.data;
}

async function readWxrMenu(
  db: D1Database,
  menuId: string,
): Promise<Menu | null> {
  try {
    const row = await db.prepare(`
      SELECT menu_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      FROM menus
      WHERE menu_id = ?
      LIMIT 1
    `).bind(menuId).first<WxrMenuDatabaseRow>();
    return row ? parseWxrStoredMenu(row) : null;
  } catch (error) {
    throw queryFailure(error, 'read_wxr_menu');
  }
}

async function countWxrMenus(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(
      'SELECT COUNT(*) AS row_count FROM menus',
    ).first<{ row_count?: unknown }>();
    const count = Number(row?.row_count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('D1 returned an invalid imported Menu count.');
    }
    return count;
  } catch (error) {
    throw queryFailure(error, 'count_wxr_menus');
  }
}

function collectWxrMenuReferences(items: readonly WxrImportMenuItem[]) {
  const values = {
    post: new Set<number>(),
    page: new Set<number>(),
    category: new Set<string>(),
    tag: new Set<string>(),
  };
  const pending = [...items];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    if (item.link.kind === 'post' || item.link.kind === 'page') {
      values[item.link.kind].add(item.link.public_id);
    } else if (item.link.kind === 'category' || item.link.kind === 'tag') {
      values[item.link.kind].add(item.link.slug);
    }
    pending.push(...item.children);
  }
  return values;
}

const WXR_MENU_REFERENCE_QUERY_CHUNK_SIZE = 90;

async function resolveWxrMenuReferences(input: {
  db: D1Database;
  row: WxrImportMenuRow;
}): Promise<MenuItem[] | null> {
  const requested = collectWxrMenuReferences(input.row.items);
  const resolved = {
    post: new Map<number, string>(),
    page: new Map<number, string>(),
    category: new Map<string, string>(),
    tag: new Map<string, string>(),
  };
  const definitions = {
    post: {
      table: 'posts', sourceColumn: 'public_id', filter: "status != 'trash'",
    },
    page: {
      table: 'pages', sourceColumn: 'public_id', filter: "status != 'trash'",
    },
    category: {
      table: 'categories', sourceColumn: 'slug', filter: '1 = 1',
    },
    tag: {
      table: 'tags', sourceColumn: 'slug', filter: '1 = 1',
    },
  } as const;
  try {
    for (const kind of ['post', 'page', 'category', 'tag'] as const) {
      const sourceValues = [...requested[kind]];
      for (
        let offset = 0;
        offset < sourceValues.length;
        offset += WXR_MENU_REFERENCE_QUERY_CHUNK_SIZE
      ) {
        const chunk = sourceValues.slice(
          offset,
          offset + WXR_MENU_REFERENCE_QUERY_CHUNK_SIZE,
        );
        const definition = definitions[kind];
        const result = await input.db.prepare(`
          SELECT id, ${definition.sourceColumn} AS source_key
          FROM ${definition.table}
          WHERE ${definition.sourceColumn} IN (${chunk.map(() => '?').join(', ')})
            AND ${definition.filter}
        `).bind(...chunk).all<WxrMenuReferenceRow>();
        if (!Array.isArray(result.results)) {
          throw new TypeError('D1 returned invalid imported Menu references.');
        }
        for (const row of result.results) {
          const id = menuItemIdSchema.safeParse(row.id);
          const sourceKey = kind === 'post' || kind === 'page'
            ? Number(row.source_key)
            : String(row.source_key ?? '');
          const validSourceKey = kind === 'post' || kind === 'page'
            ? Number.isSafeInteger(sourceKey) && Number(sourceKey) > 0
            : sourceKey !== '';
          if (!id.success || !validSourceKey) {
            throw new TypeError('D1 returned invalid imported Menu references.');
          }
          if (kind === 'post' || kind === 'page') {
            (resolved[kind] as Map<number, string>).set(Number(sourceKey), id.data);
          } else {
            (resolved[kind] as Map<string, string>).set(String(sourceKey), id.data);
          }
        }
      }
    }
  } catch (error) {
    throw queryFailure(error, 'resolve_wxr_menu_references');
  }
  for (const kind of ['post', 'page', 'category', 'tag'] as const) {
    if (requested[kind].size !== resolved[kind].size) return null;
  }

  const convert = (items: readonly WxrImportMenuItem[]): MenuItem[] => (
    items.map((item) => {
      let link: MenuItem['link'];
      if (item.link.kind === 'custom') {
        link = item.link;
      } else if (item.link.kind === 'post' || item.link.kind === 'page') {
        link = {
          kind: item.link.kind,
          reference_id: (resolved[item.link.kind] as Map<number, string>)
            .get(item.link.public_id)!,
        };
      } else {
        link = {
          kind: item.link.kind,
          reference_id: (resolved[item.link.kind] as Map<string, string>)
            .get(item.link.slug)!,
        };
      }
      return {
        id: item.id,
        title: item.title,
        link,
        target: item.target,
        children: convert(item.children),
      };
    })
  );
  return canonicalizeMenuItems(convert(input.row.items));
}

async function importMenu(input: {
  db: D1Database;
  row: WxrImportMenuRow;
  nowIso: string;
  createRevision?: () => string;
}): Promise<RowResult> {
  const items = await resolveWxrMenuReferences({ db: input.db, row: input.row });
  if (!items) return { kind: 'failed', code: 'MENU_REFERENCE_NOT_FOUND' };
  const itemsJson = JSON.stringify(items);
  const current = await readWxrMenu(input.db, input.row.menu_id);
  if (
    current
    && current.name === input.row.name
    && current.enabled
    && JSON.stringify(current.items) === itemsJson
  ) return { kind: 'unchanged' };

  if (!current && await countWxrMenus(input.db) >= MENU_MAX_COUNT) {
    return { kind: 'failed', code: 'MENU_LIMIT_REACHED' };
  }

  try {
    if (!current) {
      const revision = createRevision(input.createRevision);
      const result = await input.db.prepare(`
        INSERT OR IGNORE INTO menus (
          menu_id, name, enabled, items, revision,
          created_at_iso, updated_at_iso
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).bind(
        input.row.menu_id,
        input.row.name,
        itemsJson,
        revision,
        input.nowIso,
        input.nowIso,
      ).run();
      if (readChanges(result) === 1) return { kind: 'created' };
      return { kind: 'failed', code: 'REVISION_CONFLICT' };
    }

    const revision = createRevision(input.createRevision);
    if (revision === current.revision) {
      throw new TypeError('Imported Menu revision must advance.');
    }
    const result = await input.db.prepare(`
      UPDATE menus
      SET name = ?, enabled = 1, items = ?, revision = ?, updated_at_iso = ?
      WHERE menu_id = ? AND revision = ?
    `).bind(
      input.row.name,
      itemsJson,
      revision,
      input.nowIso,
      input.row.menu_id,
      current.revision,
    ).run();
    return readChanges(result) === 1
      ? { kind: 'updated' }
      : { kind: 'failed', code: 'REVISION_CONFLICT' };
  } catch (error) {
    throw writeFailure(error, 'upsert_wxr_menu');
  }
}

export async function importWxrCoreChunk(input: {
  db: D1Database;
  request: WxrCoreImportChunkRequest;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<WxrCoreImportChunkResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const summary: WxrCoreImportChunkResult['summary'] = {
    phase: input.request.phase,
    processed: input.request.rows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    failures: [],
  };
  const metadataResults = (
    input.request.phase === 'authors' || input.request.phase === 'categories'
    || input.request.phase === 'tags' || input.request.phase === 'media'
  ) ? await importMetadataChunk({ ...input, request: input.request, nowIso }) : null;
  for (const [rowIndex, row] of input.request.rows.entries()) {
    let result: RowResult;
    if (metadataResults) {
      result = metadataResults[rowIndex]!;
    } else if (input.request.phase === 'posts') {
      result = await importPost({
        db: input.db,
        row: row as WxrImportPostRow,
        nowIso,
        createId: input.createId,
        createRevision: input.createRevision,
      });
    } else if (input.request.phase === 'pages') {
      result = await importPage({
        db: input.db,
        row: row as WxrImportPageRow,
        nowIso,
        createId: input.createId,
        createRevision: input.createRevision,
      });
    } else if (input.request.phase === 'menus') {
      result = await importMenu({
        db: input.db,
        row: row as WxrImportMenuRow,
        nowIso,
        createRevision: input.createRevision,
      });
    } else {
      throw new TypeError('Comment chunks must use the EDGE_DB importer.');
    }

    if (result.kind === 'failed') {
      summary.failed += 1;
      summary.failures.push({
        row_index: rowIndex,
        key: rowKey(input.request.phase, row),
        code: result.code,
      });
      continue;
    }
    summary[result.kind] += 1;
  }

  return { summary };
}
