import {
  logOperationalFailure,
  StudioOperationalError,
} from '../lib/operational-error';
import { isDeletableR2MediaStorageKey } from '../../../contracts/media';

const DELETE_BATCH_LIMIT = 1_000;
// Keep one binding available for the retry timestamp and stay comfortably
// below D1's per-statement binding ceiling while avoiding one query per key.
const DATABASE_KEY_CHUNK_SIZE = 90;

type PendingDeletionRow = { storage_key?: unknown };

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function chunkStorageKeys(storageKeys: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < storageKeys.length; index += DATABASE_KEY_CHUNK_SIZE) {
    chunks.push(storageKeys.slice(index, index + DATABASE_KEY_CHUNK_SIZE));
  }
  return chunks;
}

function inPlaceholders(length: number): string {
  return Array.from({ length }, () => '?').join(', ');
}

export async function queueMediaObjectDeletion(input: {
  db: D1Database;
  storageKey: string;
  now?: Date;
}): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    await input.db.prepare(`
      INSERT OR IGNORE INTO media_object_deletions (
        storage_key, attempt_count, created_at_iso, last_attempt_at_iso
      ) VALUES (?, 0, ?, NULL)
    `).bind(input.storageKey, nowIso).run();
  } catch (error) {
    throw new StudioOperationalError('MEDIA_OBJECT_CLEANUP_QUEUE_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'queue_media_object_deletion',
        storage_key: input.storageKey,
      },
    });
  }
}

async function recordFailedAttempt(input: {
  db: D1Database;
  storageKeys: string[];
  now: Date;
}): Promise<void> {
  if (input.storageKeys.length === 0) return;
  await input.db.batch(chunkStorageKeys(input.storageKeys).map((storageKeys) => (
    input.db.prepare(`
      UPDATE media_object_deletions
      SET attempt_count = attempt_count + 1, last_attempt_at_iso = ?
      WHERE storage_key IN (${inPlaceholders(storageKeys.length)})
    `).bind(input.now.toISOString(), ...storageKeys)
  )));
}

async function removeCompletedRows(input: {
  db: D1Database;
  storageKeys: string[];
}): Promise<number> {
  if (input.storageKeys.length === 0) return 0;
  try {
    const results = await input.db.batch(chunkStorageKeys(input.storageKeys).map((storageKeys) => (
      input.db.prepare(`
        DELETE FROM media_object_deletions
        WHERE storage_key IN (${inPlaceholders(storageKeys.length)})
      `).bind(...storageKeys)
    )));
    return results.reduce((total, result) => total + readChanges(result), 0);
  } catch (error) {
    throw new StudioOperationalError(
      'MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'remove_completed_media_object_deletions',
          affected_rows: input.storageKeys.length,
        },
      },
    );
  }
}

export async function deleteQueuedMediaObject(input: {
  db: D1Database;
  bucket: R2Bucket;
  storageKey: string;
  now?: Date;
}): Promise<'completed' | 'pending'> {
  const now = input.now ?? new Date();
  try {
    await input.bucket.delete(input.storageKey);
  } catch (error) {
    try {
      await recordFailedAttempt({
        db: input.db,
        storageKeys: [input.storageKey],
        now,
      });
    } catch {
      // The durable queue row already exists. A later scheduled pass can retry
      // even if recording this particular attempt also fails.
    }
    logOperationalFailure('MEDIA_OBJECT_CLEANUP_DEFERRED', {
      cause: error,
      metadata: {
        resource: 'MEDIA_BUCKET',
        related_resource: 'DB',
        action: 'delete_media_object',
        storage_key: input.storageKey,
      },
    });
    return 'pending';
  }
  try {
    await removeCompletedRows({
      db: input.db,
      storageKeys: [input.storageKey],
    });
    return 'completed';
  } catch (error) {
    if (error instanceof StudioOperationalError) {
      logOperationalFailure(error.code, {
        cause: error.originalCause,
        metadata: error.operationalMetadata,
      });
    }
    // The R2 object is already gone and the durable row is harmless. Report a
    // pending cleanup so the next daily pass can remove the stale queue row.
    return 'pending';
  }
}

export async function drainMediaObjectDeletionQueue(input: {
  db: D1Database;
  bucket?: R2Bucket;
  now?: Date;
  limit?: number;
}): Promise<{ pendingRows: number; deletedRows: number }> {
  let rows: PendingDeletionRow[];
  try {
    const result = await input.db.prepare(`
      SELECT storage_key
      FROM media_object_deletions
      ORDER BY last_attempt_at_iso, created_at_iso, storage_key
      LIMIT ?
    `).bind(Math.min(DELETE_BATCH_LIMIT, input.limit ?? DELETE_BATCH_LIMIT))
      .all<PendingDeletionRow>();
    rows = result.results ?? [];
  } catch (error) {
    throw new StudioOperationalError('MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'list_media_object_deletions' },
    });
  }
  const storageKeys = rows.map((row) => {
    if (
      typeof row.storage_key !== 'string'
      || !isDeletableR2MediaStorageKey(row.storage_key)
    ) {
      throw new StudioOperationalError(
        'MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED',
        {
          cause: new TypeError('D1 returned an invalid Media cleanup key.'),
          metadata: {
            resource: 'DB',
            action: 'validate_media_object_deletions',
          },
        },
      );
    }
    return row.storage_key;
  });
  if (storageKeys.length === 0) return { pendingRows: 0, deletedRows: 0 };
  if (!input.bucket) {
    throw new StudioOperationalError('MEDIA_UPLOAD_R2_BINDING_NOT_CONFIGURED', {
      metadata: {
        resource: 'MEDIA_BUCKET',
        action: 'delete_queued_media_objects',
        pending_rows: storageKeys.length,
      },
    });
  }

  try {
    await input.bucket.delete(storageKeys);
  } catch (error) {
    try {
      await recordFailedAttempt({
        db: input.db,
        storageKeys,
        now: input.now ?? new Date(),
      });
    } catch {
      // Preserve the original R2 failure classification.
    }
    throw new StudioOperationalError('MEDIA_OBJECT_CLEANUP_FAILED', {
      cause: error,
      metadata: {
        resource: 'MEDIA_BUCKET',
        related_resource: 'DB',
        action: 'delete_queued_media_objects',
        pending_rows: storageKeys.length,
      },
    });
  }
  const deletedRows = await removeCompletedRows({ db: input.db, storageKeys });
  return { pendingRows: storageKeys.length, deletedRows };
}
