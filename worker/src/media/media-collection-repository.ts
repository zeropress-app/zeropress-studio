import {
  MEDIA_COLLECTION_MAX_ITEMS,
  mediaCollectionIdSchema,
  mediaCollectionSchema,
  type BulkMoveMediaRequest,
  type CreateMediaCollectionRequest,
  type MediaCollection,
  type UpdateMediaCollectionRequest,
} from '../../../contracts/media';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

type CollectionRow = {
  id: unknown;
  name: unknown;
  media_count: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
};

type MediaCountRow = {
  total_media_count: unknown;
  unfiled_media_count: unknown;
};

type MoveRow = {
  id: unknown;
  revision: unknown;
  collection_id: unknown;
};

export type MediaCollectionCatalog = {
  items: MediaCollection[];
  total_media_count: number;
  unfiled_media_count: number;
};

export type CreateMediaCollectionResult =
  | { kind: 'completed'; collection: MediaCollection }
  | { kind: 'name_conflict' }
  | { kind: 'limit_reached' };

export type UpdateMediaCollectionResult =
  | { kind: 'completed'; collection: MediaCollection }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'name_conflict' };

export type DeleteMediaCollectionResult =
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'not_empty' };

export type BulkMoveMediaResult =
  | { kind: 'completed'; movedCount: number; unchangedCount: number }
  | { kind: 'collection_not_found' }
  | { kind: 'conflict' };

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
    metadata: { resource: 'DB', action: 'validate_media_collection_data' },
  });
}

function parseCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`D1 returned an invalid ${label}.`);
  }
  return value as number;
}

function isNameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:idx_media_collections_name|unique constraint failed:\s*media_collections\.name)/iu
    .test(message);
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

function canonicalCollectionRows(rows: CollectionRow[]): MediaCollection[] {
  if (rows.length > MEDIA_COLLECTION_MAX_ITEMS) {
    throw dataInvalid(new TypeError('The Media collection limit was exceeded.'));
  }

  const items: MediaCollection[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const id = mediaCollectionIdSchema.safeParse(row.id);
    if (!id.success || typeof row.name !== 'string') {
      throw dataInvalid(new TypeError('D1 returned malformed Media collection identity data.'));
    }
    if (ids.has(id.data)) {
      throw dataInvalid(new TypeError('D1 returned duplicate Media collection identities.'));
    }
    ids.add(id.data);
    const parsed = mediaCollectionSchema.safeParse({
      id: id.data,
      name: row.name,
      media_count: row.media_count,
      revision: row.revision,
      created_at_iso: row.created_at_iso,
      updated_at_iso: row.updated_at_iso,
    });
    if (!parsed.success) throw dataInvalid(parsed.error);
    items.push(parsed.data);
  }
  return items;
}

async function readCatalog(db: D1Database): Promise<MediaCollectionCatalog> {
  const results = await db.batch([
    db.prepare(`
      SELECT
        media_collections.id,
        media_collections.name,
        COUNT(media.id) AS media_count,
        media_collections.revision,
        media_collections.created_at_iso,
        media_collections.updated_at_iso
      FROM media_collections
      LEFT JOIN media ON media.collection_id = media_collections.id
      GROUP BY media_collections.id
      ORDER BY media_collections.name COLLATE NOCASE,
        media_collections.name,
        media_collections.id
      LIMIT ${MEDIA_COLLECTION_MAX_ITEMS + 1}
    `),
    db.prepare(`
      SELECT
        COUNT(*) AS total_media_count,
        COALESCE(SUM(CASE WHEN collection_id IS NULL THEN 1 ELSE 0 END), 0)
          AS unfiled_media_count
      FROM media
    `),
  ]);
  const collectionRows = results[0]?.results;
  const counts = results[1]?.results?.[0] as MediaCountRow | undefined;
  if (!Array.isArray(collectionRows) || !counts) {
    throw new TypeError('D1 returned an invalid Media collection catalog.');
  }
  return {
    items: canonicalCollectionRows(collectionRows as CollectionRow[]),
    total_media_count: parseCount(counts.total_media_count, 'Media total'),
    unfiled_media_count: parseCount(
      counts.unfiled_media_count,
      'unfiled Media total',
    ),
  };
}

export async function listMediaCollections(input: {
  db: D1Database;
}): Promise<MediaCollectionCatalog> {
  try {
    return await readCatalog(input.db);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_media_collections');
  }
}

async function readCollection(
  db: D1Database,
  id: string,
): Promise<MediaCollection | null> {
  const catalog = await readCatalog(db);
  return catalog.items.find((item) => item.id === id) ?? null;
}

export async function createMediaCollection(input: {
  db: D1Database;
  authored: CreateMediaCollectionRequest;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<CreateMediaCollectionResult> {
  try {
    const catalog = await readCatalog(input.db);
    if (catalog.items.length >= MEDIA_COLLECTION_MAX_ITEMS) {
      return { kind: 'limit_reached' };
    }
    const id = mediaCollectionIdSchema.parse((input.createId ?? createHexId)());
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO media_collections (
        id, name, revision, created_at_iso, updated_at_iso
      )
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM media_collections) < ?
    `).bind(
      id,
      input.authored.name,
      revision,
      nowIso,
      nowIso,
      MEDIA_COLLECTION_MAX_ITEMS,
    ).run();
    if (readChanges(result) !== 1) {
      const latest = await readCatalog(input.db);
      if (latest.items.length >= MEDIA_COLLECTION_MAX_ITEMS) {
        return { kind: 'limit_reached' };
      }
      return { kind: 'name_conflict' };
    }
    const collection = await readCollection(input.db, id);
    if (!collection) throw new TypeError('D1 did not return the created Media collection.');
    return { kind: 'completed', collection };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isNameConflict(error)) return { kind: 'name_conflict' };
    throw writeFailure(error, 'create_media_collection');
  }
}

export async function updateMediaCollection(input: {
  db: D1Database;
  id: string;
  authored: UpdateMediaCollectionRequest;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdateMediaCollectionResult> {
  try {
    const catalog = await readCatalog(input.db);
    const current = catalog.items.find((item) => item.id === input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.authored.expected_revision) {
      return { kind: 'revision_conflict' };
    }
    if (current.name === input.authored.name) {
      return { kind: 'completed', collection: current };
    }

    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Media collection revision must advance.');
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const result = await input.db.prepare(`
      UPDATE media_collections
      SET name = ?, revision = ?, updated_at_iso = ?
      WHERE id = ? AND revision = ?
    `).bind(
      input.authored.name,
      revision,
      nowIso,
      input.id,
      input.authored.expected_revision,
    ).run();
    if (readChanges(result) !== 1) {
      const latest = await readCatalog(input.db);
      const collection = latest.items.find((item) => item.id === input.id);
      if (!collection) return { kind: 'not_found' };
      return { kind: 'revision_conflict' };
    }
    const collection = await readCollection(input.db, input.id);
    if (!collection) throw new TypeError('D1 did not return the updated Media collection.');
    return { kind: 'completed', collection };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isNameConflict(error)) return { kind: 'name_conflict' };
    throw writeFailure(error, 'update_media_collection');
  }
}

export async function deleteMediaCollection(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
}): Promise<DeleteMediaCollectionResult> {
  try {
    const result = await input.db.prepare(`
      DELETE FROM media_collections
      WHERE id = ? AND revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM media WHERE collection_id = media_collections.id
        )
    `).bind(input.id, input.expectedRevision).run();
    if (readChanges(result) === 1) return { kind: 'completed' };
    const current = await readCollection(input.db, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    return { kind: 'not_empty' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isForeignKeyConstraint(error)) return { kind: 'not_empty' };
    throw writeFailure(error, 'delete_media_collection');
  }
}

export async function bulkMoveMedia(input: {
  db: D1Database;
  authored: BulkMoveMediaRequest;
  now?: Date;
}): Promise<BulkMoveMediaResult> {
  const requestJson = JSON.stringify(input.authored.items);
  try {
    if (input.authored.target_collection_id !== null) {
      const target = await input.db.prepare(`
        SELECT id FROM media_collections WHERE id = ? LIMIT 1
      `).bind(input.authored.target_collection_id).first<{ id: unknown }>();
      if (!target) return { kind: 'collection_not_found' };
    }
    const existing = await input.db.prepare(`
      WITH requested AS (
        SELECT
          json_extract(value, '$.id') AS id,
          json_extract(value, '$.expected_revision') AS expected_revision
        FROM json_each(?)
      )
      SELECT media.id, media.revision, media.collection_id
      FROM requested
      LEFT JOIN media ON media.id = requested.id
      ORDER BY requested.id
    `).bind(requestJson).all<MoveRow>();
    if (!Array.isArray(existing.results)) {
      throw new TypeError('D1 returned invalid Media bulk-move rows.');
    }
    if (existing.results.length !== input.authored.items.length) {
      return { kind: 'conflict' };
    }
    const expectedById = new Map(input.authored.items.map((item) => [
      item.id,
      item.expected_revision,
    ]));
    let unchangedCount = 0;
    for (const row of existing.results) {
      if (
        typeof row.id !== 'string'
        || typeof row.revision !== 'string'
        || expectedById.get(row.id) !== row.revision
      ) return { kind: 'conflict' };
      if (row.collection_id === input.authored.target_collection_id) {
        unchangedCount += 1;
      }
    }
    const movedCount = input.authored.items.length - unchangedCount;
    if (movedCount === 0) {
      return { kind: 'completed', movedCount: 0, unchangedCount };
    }

    const result = await input.db.prepare(`
      WITH
      requested(id, expected_revision) AS MATERIALIZED (
        SELECT
          json_extract(value, '$.id'),
          json_extract(value, '$.expected_revision')
        FROM json_each(?)
      ),
      valid_request(exact_count) AS MATERIALIZED (
        SELECT COUNT(*)
        FROM requested
        JOIN media
          ON media.id = requested.id
          AND media.revision = requested.expected_revision
      )
      UPDATE media
      SET
        collection_id = ?,
        revision = lower(hex(randomblob(16))),
        updated_at_iso = ?
      WHERE id IN (SELECT id FROM requested)
        AND (SELECT exact_count FROM valid_request) = ?
        AND collection_id IS NOT ?
    `).bind(
      requestJson,
      input.authored.target_collection_id,
      (input.now ?? new Date()).toISOString(),
      input.authored.items.length,
      input.authored.target_collection_id,
    ).run();
    if (readChanges(result) !== movedCount) return { kind: 'conflict' };
    return { kind: 'completed', movedCount, unchangedCount };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isForeignKeyConstraint(error)) return { kind: 'collection_not_found' };
    throw writeFailure(error, 'bulk_move_media');
  }
}
