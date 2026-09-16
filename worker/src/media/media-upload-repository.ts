import {
  MANAGED_MEDIA_UPLOAD_INTENT_TTL_SECONDS,
  MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT,
  resolveManagedMediaFileDescriptor,
  type CreateManagedMediaUploadRequest,
  type ManagedMediaFileDescriptor,
} from '../../../contracts/media-upload';
import {
  mediaIdSchema,
  type Media,
} from '../../../contracts/media';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import {
  serializeMediaAiGeneration,
  type MediaAiGeneration,
} from '../../../contracts/media-ai-generation';
import { StudioOperationalError } from '../lib/operational-error';
import { getMedia } from './media-repository';

type UploadIntentRow = {
  id: unknown;
  media_id: unknown;
  user_id: unknown;
  filename: unknown;
  kind: unknown;
  mime_type: unknown;
  extension: unknown;
  signature: unknown;
  disposition: unknown;
  storage_key: unknown;
  size_bytes: unknown;
  width: unknown;
  height: unknown;
  duration_ms: unknown;
  alt: unknown;
  created_at_iso: unknown;
  expires_at_iso: unknown;
};

export type ManagedMediaUploadIntent = {
  id: string;
  mediaId: string;
  userId: string;
  filename: string;
  descriptor: ManagedMediaFileDescriptor;
  storageKey: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  alt: string;
  createdAtIso: string;
  expiresAtIso: string;
};

export type CreateManagedMediaUploadIntentResult =
  | { kind: 'completed'; intent: ManagedMediaUploadIntent }
  | { kind: 'limit_reached' };

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
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

function parseNullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned invalid managed-upload metadata.');
  }
  return value as number;
}

function parseIntent(row: UploadIntentRow): ManagedMediaUploadIntent {
  const id = mediaIdSchema.parse(row.id);
  const mediaId = mediaIdSchema.parse(row.media_id);
  const userId = mediaIdSchema.parse(row.user_id);
  if (
    typeof row.filename !== 'string'
    || typeof row.storage_key !== 'string'
    || typeof row.size_bytes !== 'number'
    || !Number.isSafeInteger(row.size_bytes)
    || typeof row.alt !== 'string'
    || typeof row.created_at_iso !== 'string'
    || typeof row.expires_at_iso !== 'string'
  ) {
    throw new TypeError('D1 returned an invalid managed-upload intent.');
  }
  const descriptor = resolveManagedMediaFileDescriptor(row.filename);
  if (
    !descriptor
    || descriptor.kind !== row.kind
    || descriptor.mime_type !== row.mime_type
    || descriptor.extension !== row.extension
    || descriptor.signature !== row.signature
    || descriptor.disposition !== row.disposition
  ) {
    throw new TypeError('D1 returned a non-canonical managed-upload descriptor.');
  }
  return {
    id,
    mediaId,
    userId,
    filename: row.filename,
    descriptor,
    storageKey: row.storage_key,
    sizeBytes: row.size_bytes,
    width: parseNullableInteger(row.width),
    height: parseNullableInteger(row.height),
    durationMs: parseNullableInteger(row.duration_ms),
    alt: row.alt,
    createdAtIso: row.created_at_iso,
    expiresAtIso: row.expires_at_iso,
  };
}

function uploadStorageKey(input: {
  mediaId: string;
  extension: string;
  now: Date;
}): string {
  const year = String(input.now.getUTCFullYear()).padStart(4, '0');
  const month = String(input.now.getUTCMonth() + 1).padStart(2, '0');
  return `uploads/${year}/${month}/${input.mediaId}.${input.extension}`;
}

export async function createManagedMediaUploadIntent(input: {
  db: D1Database;
  userId: string;
  authored: CreateManagedMediaUploadRequest;
  /** Internal generated output has already consumed provider quota. */
  enforceQueueLimit?: boolean;
  now?: Date;
  createId?: () => string;
}): Promise<CreateManagedMediaUploadIntentResult> {
  const descriptor = resolveManagedMediaFileDescriptor(input.authored.filename);
  if (!descriptor) throw new TypeError('Managed upload descriptor is missing.');
  const createId = input.createId ?? createHexId;
  const id = mediaIdSchema.parse(createId());
  const mediaId = mediaIdSchema.parse(createId());
  if (id === mediaId) throw new TypeError('Upload and Media IDs must differ.');
  const userId = mediaIdSchema.parse(input.userId);
  const now = input.now ?? new Date();
  const createdAtIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + MANAGED_MEDIA_UPLOAD_INTENT_TTL_SECONDS * 1_000,
  ).toISOString();
  const storageKey = uploadStorageKey({
    mediaId,
    extension: descriptor.extension,
    now,
  });

  try {
    const columns = `
      id, media_id, user_id, filename, kind, mime_type, extension,
      signature, disposition, storage_key, size_bytes, width, height,
      duration_ms, alt, created_at_iso, expires_at_iso
    `;
    const values = [
      id,
      mediaId,
      userId,
      input.authored.filename,
      descriptor.kind,
      descriptor.mime_type,
      descriptor.extension,
      descriptor.signature,
      descriptor.disposition,
      storageKey,
      input.authored.size_bytes,
      input.authored.width,
      input.authored.height,
      input.authored.duration_ms,
      input.authored.alt,
      createdAtIso,
      expiresAtIso,
    ];
    const statement = input.enforceQueueLimit === false
      ? input.db.prepare(`
          INSERT INTO media_upload_intents (${columns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(...values)
      : input.db.prepare(`
          INSERT INTO media_upload_intents (${columns})
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*)
            FROM media_upload_intents
            WHERE user_id = ? AND expires_at_iso > ?
          ) < ?
        `).bind(
          ...values,
          userId,
          createdAtIso,
          MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT,
        );
    const result = await statement.run();
    if (readChanges(result) === 0) return { kind: 'limit_reached' };
    return {
      kind: 'completed',
      intent: {
        id,
        mediaId,
        userId,
        filename: input.authored.filename,
        descriptor,
        storageKey,
        sizeBytes: input.authored.size_bytes,
        width: input.authored.width,
        height: input.authored.height,
        durationMs: input.authored.duration_ms,
        alt: input.authored.alt,
        createdAtIso,
        expiresAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'create_media_upload_intent');
  }
}

export async function getManagedMediaUploadIntent(input: {
  db: D1Database;
  id: string;
  userId: string;
}): Promise<ManagedMediaUploadIntent | null> {
  try {
    const row = await input.db.prepare(`
      SELECT * FROM media_upload_intents
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).bind(input.id, input.userId).first<UploadIntentRow>();
    return row ? parseIntent(row) : null;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_media_upload_intent');
  }
}

export async function cancelManagedMediaUploadIntent(input: {
  db: D1Database;
  id: string;
  userId: string;
  now?: Date;
}): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      // Conservatively enqueue the key before removing the intent. R2 delete
      // is idempotent, and this closes the termination window where an object
      // write completed but its Media row was never committed.
      input.db.prepare(`
        INSERT OR IGNORE INTO media_object_deletions (
          storage_key, attempt_count, created_at_iso, last_attempt_at_iso
        )
        SELECT storage_key, 0, ?, NULL
        FROM media_upload_intents
        WHERE id = ? AND user_id = ?
      `).bind(nowIso, input.id, input.userId),
      input.db.prepare(`
        DELETE FROM media_upload_intents WHERE id = ? AND user_id = ?
      `).bind(input.id, input.userId),
    ]);
    return readChanges(results[1]) === 1;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'cancel_media_upload_intent');
  }
}

export async function completeManagedMediaUpload(input: {
  db: D1Database;
  intent: ManagedMediaUploadIntent;
  storedSizeBytes?: number;
  aiGeneration?: MediaAiGeneration;
  now?: Date;
  createRevision?: () => string;
}): Promise<Media> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const storedSizeBytes = input.storedSizeBytes ?? input.intent.sizeBytes;
  if (!Number.isSafeInteger(storedSizeBytes) || storedSizeBytes < 1) {
    throw new TypeError('Stored managed Media size must be a positive safe integer.');
  }
  const revision = settingsRevisionSchema.parse(
    (input.createRevision ?? createHexId)(),
  );
  const aiGenerationJson = input.aiGeneration
    ? serializeMediaAiGeneration(input.aiGeneration)
    : null;
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        INSERT INTO media (
          id, kind, filename, mime_type, storage_type, storage_key,
          external_url, size_bytes, width, height, duration_ms, alt,
          revision, created_at_iso, updated_at_iso, ai_generation_json
        )
        SELECT media_id, kind, filename, mime_type, 'r2', storage_key,
          NULL, ?, width, height, duration_ms, alt, ?, ?, ?, ?
        FROM media_upload_intents
        WHERE id = ? AND user_id = ? AND expires_at_iso > ?
      `).bind(
        storedSizeBytes,
        revision,
        nowIso,
        nowIso,
        aiGenerationJson,
        input.intent.id,
        input.intent.userId,
        nowIso,
      ),
      input.db.prepare(`
        DELETE FROM media_upload_intents
        WHERE id = ? AND user_id = ?
      `).bind(input.intent.id, input.intent.userId),
    ]);
    if (readChanges(results[0]) !== 1 || readChanges(results[1]) !== 1) {
      throw new TypeError('D1 could not atomically complete the managed upload.');
    }
    const media = await getMedia({ db: input.db, id: input.intent.mediaId });
    if (!media) throw new TypeError('D1 did not return completed Media.');
    return media;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'complete_media_upload');
  }
}

export async function garbageCollectExpiredMediaUploadIntents(input: {
  db: D1Database;
  now?: Date;
}): Promise<{ deletedRows: number; queuedObjectRows: number }> {
  const cutoffAtIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      // An expired intent usually has no object. Queueing its immutable key is
      // nevertheless required because a Worker may have terminated after the
      // R2 put and before D1 materialization or compensation.
      input.db.prepare(`
        INSERT OR IGNORE INTO media_object_deletions (
          storage_key, attempt_count, created_at_iso, last_attempt_at_iso
        )
        SELECT storage_key, 0, ?, NULL
        FROM media_upload_intents
        WHERE expires_at_iso <= ?
      `).bind(cutoffAtIso, cutoffAtIso),
      input.db.prepare(`
        DELETE FROM media_upload_intents WHERE expires_at_iso <= ?
      `).bind(cutoffAtIso),
    ]);
    return {
      queuedObjectRows: readChanges(results[0]),
      deletedRows: readChanges(results[1]),
    };
  } catch (error) {
    throw new StudioOperationalError(
      'MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'garbage_collect_media_upload_intents',
        },
      },
    );
  }
}
