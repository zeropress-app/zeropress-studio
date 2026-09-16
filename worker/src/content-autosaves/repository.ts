import type { z } from 'zod';
import {
  CONTENT_AUTOSAVE_TTL_SECONDS,
  CONTENT_SNAPSHOT_VERSION,
} from '../../../contracts/content-snapshots';
import {
  postAutosaveDocumentSchema,
  postContentSnapshotSchema,
  type PostAutosaveDocument,
  type PutPostAutosaveRequest,
} from '../../../contracts/post-autosaves';
import {
  pageAutosaveDocumentSchema,
  pageContentSnapshotSchema,
  type PageAutosaveDocument,
  type PutPageAutosaveRequest,
} from '../../../contracts/page-autosaves';
import { StudioOperationalError } from '../lib/operational-error';

type AutosaveKind = 'post' | 'page';
type AutosaveLocator =
  | { draftId: string; targetId?: never }
  | { draftId?: never; targetId: string };

type AutosaveRow = {
  draft_id: unknown;
  target_id: unknown;
  base_revision: unknown;
  snapshot_version: unknown;
  snapshot_json: unknown;
  snapshot_sha256: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
  expires_at_iso: unknown;
};

type AutosaveConfig = {
  table: 'post_autosaves' | 'page_autosaves';
  targetTable: 'posts' | 'pages';
  targetColumn: 'post_id' | 'page_id';
  queryFailureCode:
    | 'POST_MANAGEMENT_DATABASE_QUERY_FAILED'
    | 'PAGE_MANAGEMENT_DATABASE_QUERY_FAILED';
  writeFailureCode:
    | 'POST_MANAGEMENT_DATABASE_WRITE_FAILED'
    | 'PAGE_MANAGEMENT_DATABASE_WRITE_FAILED';
  dataInvalidCode:
    | 'POST_MANAGEMENT_DATA_INVALID'
    | 'PAGE_MANAGEMENT_DATA_INVALID';
  snapshotSchema: z.ZodType;
  documentSchema: z.ZodType;
};

const CONFIG: Record<AutosaveKind, AutosaveConfig> = {
  post: {
    table: 'post_autosaves',
    targetTable: 'posts',
    targetColumn: 'post_id',
    queryFailureCode: 'POST_MANAGEMENT_DATABASE_QUERY_FAILED',
    writeFailureCode: 'POST_MANAGEMENT_DATABASE_WRITE_FAILED',
    dataInvalidCode: 'POST_MANAGEMENT_DATA_INVALID',
    snapshotSchema: postContentSnapshotSchema,
    documentSchema: postAutosaveDocumentSchema,
  },
  page: {
    table: 'page_autosaves',
    targetTable: 'pages',
    targetColumn: 'page_id',
    queryFailureCode: 'PAGE_MANAGEMENT_DATABASE_QUERY_FAILED',
    writeFailureCode: 'PAGE_MANAGEMENT_DATABASE_WRITE_FAILED',
    dataInvalidCode: 'PAGE_MANAGEMENT_DATA_INVALID',
    snapshotSchema: pageContentSnapshotSchema,
    documentSchema: pageAutosaveDocumentSchema,
  },
};

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function operationMetadata(kind: AutosaveKind, action: string) {
  return { resource: 'DB', action, content_type: kind };
}

async function snapshotDigest(snapshotJson: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotJson),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function parseDocument(
  kind: AutosaveKind,
  row: AutosaveRow,
): Promise<unknown> {
  const config = CONFIG[kind];
  try {
    if (typeof row.snapshot_json !== 'string') throw new TypeError();
    const snapshot = config.snapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (
      (row.snapshot_version !== 1 && row.snapshot_version !== 2)
      || (snapshot as { version?: unknown }).version !== row.snapshot_version
      || await snapshotDigest(row.snapshot_json) !== row.snapshot_sha256
    ) throw new TypeError('Stored autosave integrity metadata does not match.');
    return config.documentSchema.parse({
      draft_id: row.draft_id,
      target_id: row.target_id,
      base_revision: row.base_revision,
      snapshot,
      snapshot_sha256: row.snapshot_sha256,
      created_at_iso: row.created_at_iso,
      updated_at_iso: row.updated_at_iso,
      expires_at_iso: row.expires_at_iso,
    });
  } catch (cause) {
    throw new StudioOperationalError(config.dataInvalidCode, {
      cause,
      metadata: operationMetadata(kind, 'read_content_autosave'),
    });
  }
}

async function readAutosave(input: {
  db: D1Database;
  kind: AutosaveKind;
  userId: string;
  locator: AutosaveLocator;
  now?: Date;
}): Promise<unknown | null> {
  const config = CONFIG[input.kind];
  const byDraft = input.locator.draftId !== undefined;
  try {
    const row = await input.db.prepare(`
      SELECT draft_id, ${config.targetColumn} AS target_id, base_revision,
             snapshot_version, snapshot_json, snapshot_sha256,
             created_at_iso, updated_at_iso, expires_at_iso
      FROM ${config.table}
      WHERE user_id = ?
        AND ${byDraft ? 'draft_id' : config.targetColumn} = ?
        AND (expires_at_iso IS NULL OR expires_at_iso > ?)
      LIMIT 1
    `).bind(
      input.userId,
      byDraft ? input.locator.draftId : input.locator.targetId,
      (input.now ?? new Date()).toISOString(),
    ).first<AutosaveRow>();
    return row ? await parseDocument(input.kind, row) : null;
  } catch (cause) {
    if (cause instanceof StudioOperationalError) throw cause;
    throw new StudioOperationalError(config.queryFailureCode, {
      cause,
      metadata: operationMetadata(input.kind, 'read_content_autosave'),
    });
  }
}

async function readLatestUnboundAutosave(input: {
  db: D1Database;
  kind: AutosaveKind;
  userId: string;
  authorId?: string;
  now?: Date;
}): Promise<unknown | null> {
  const config = CONFIG[input.kind];
  try {
    const row = await input.db.prepare(`
      SELECT draft_id, ${config.targetColumn} AS target_id, base_revision,
             snapshot_version, snapshot_json, snapshot_sha256,
             created_at_iso, updated_at_iso, expires_at_iso
      FROM ${config.table}
      WHERE user_id = ?
        AND ${config.targetColumn} IS NULL
        AND expires_at_iso > ?
        ${input.authorId === undefined ? '' : `
          AND json_extract(snapshot_json, '$.draft.author_id') = ?
        `}
      ORDER BY updated_at_iso DESC, draft_id DESC
      LIMIT 1
    `).bind(
      input.userId,
      (input.now ?? new Date()).toISOString(),
      ...(input.authorId === undefined ? [] : [input.authorId]),
    ).first<AutosaveRow>();
    return row ? await parseDocument(input.kind, row) : null;
  } catch (cause) {
    if (cause instanceof StudioOperationalError) throw cause;
    throw new StudioOperationalError(config.queryFailureCode, {
      cause,
      metadata: operationMetadata(input.kind, 'read_recent_content_autosave'),
    });
  }
}

type PutAutosaveResult<T> =
  | { kind: 'completed'; autosave: T }
  | { kind: 'target_not_found' | 'revision_conflict' | 'draft_conflict' };

async function putAutosave(input: {
  db: D1Database;
  kind: AutosaveKind;
  userId: string;
  request: PutPostAutosaveRequest | PutPageAutosaveRequest;
  now?: Date;
}): Promise<PutAutosaveResult<unknown>> {
  const config = CONFIG[input.kind];
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + CONTENT_AUTOSAVE_TTL_SECONDS * 1_000,
  ).toISOString();
  const snapshotJson = JSON.stringify(input.request.snapshot);
  let digest: string;
  try {
    digest = await snapshotDigest(snapshotJson);
  } catch (cause) {
    throw new StudioOperationalError(config.writeFailureCode, {
      cause,
      metadata: {
        ...operationMetadata(input.kind, 'digest_content_autosave'),
        component: 'web_crypto',
      },
    });
  }

  try {
    let result: D1Result<unknown> | undefined;
    if (input.request.target_id === null) {
      result = await input.db.prepare(`
        INSERT INTO ${config.table} (
          user_id, draft_id, ${config.targetColumn}, base_revision,
          snapshot_version, snapshot_json, snapshot_sha256,
          created_at_iso, updated_at_iso, expires_at_iso
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, draft_id) DO UPDATE SET
          snapshot_version = excluded.snapshot_version,
          snapshot_json = excluded.snapshot_json,
          snapshot_sha256 = excluded.snapshot_sha256,
          updated_at_iso = excluded.updated_at_iso,
          expires_at_iso = excluded.expires_at_iso
        WHERE ${config.table}.${config.targetColumn} IS NULL
      `).bind(
        input.userId,
        input.request.draft_id,
        CONTENT_SNAPSHOT_VERSION,
        snapshotJson,
        digest,
        nowIso,
        nowIso,
        expiresAtIso,
      ).run();
    } else {
      const results = await input.db.batch([
        input.db.prepare(`
          DELETE FROM ${config.table}
          WHERE user_id = ?
            AND ${config.targetColumn} = ?
            AND draft_id != ?
            AND NOT EXISTS (
              SELECT 1 FROM ${config.table} AS existing_draft
              WHERE existing_draft.user_id = ?
                AND existing_draft.draft_id = ?
                AND existing_draft.${config.targetColumn} IS NOT NULL
                AND existing_draft.${config.targetColumn} != ?
            )
            AND EXISTS (
              SELECT 1 FROM ${config.targetTable}
              WHERE id = ? AND revision = ?
            )
        `).bind(
          input.userId,
          input.request.target_id,
          input.request.draft_id,
          input.userId,
          input.request.draft_id,
          input.request.target_id,
          input.request.target_id,
          input.request.base_revision,
        ),
        input.db.prepare(`
          INSERT INTO ${config.table} (
            user_id, draft_id, ${config.targetColumn}, base_revision,
            snapshot_version, snapshot_json, snapshot_sha256,
            created_at_iso, updated_at_iso, expires_at_iso
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
          FROM ${config.targetTable}
          WHERE id = ? AND revision = ?
          ON CONFLICT(user_id, draft_id) DO UPDATE SET
            ${config.targetColumn} = excluded.${config.targetColumn},
            base_revision = excluded.base_revision,
            snapshot_version = excluded.snapshot_version,
            snapshot_json = excluded.snapshot_json,
            snapshot_sha256 = excluded.snapshot_sha256,
            updated_at_iso = excluded.updated_at_iso,
            expires_at_iso = NULL
          WHERE ${config.table}.${config.targetColumn} IS NULL
             OR ${config.table}.${config.targetColumn} = excluded.${config.targetColumn}
        `).bind(
          input.userId,
          input.request.draft_id,
          input.request.target_id,
          input.request.base_revision,
          CONTENT_SNAPSHOT_VERSION,
          snapshotJson,
          digest,
          nowIso,
          nowIso,
          input.request.target_id,
          input.request.base_revision,
        ),
      ]);
      result = results[1];
    }

    if (readChanges(result) === 0) {
      if (input.request.target_id === null) return { kind: 'draft_conflict' };
      const target = await input.db.prepare(`
        SELECT revision FROM ${config.targetTable} WHERE id = ? LIMIT 1
      `).bind(input.request.target_id).first<{ revision?: unknown }>();
      if (!target) return { kind: 'target_not_found' };
      if (target.revision !== input.request.base_revision) {
        return { kind: 'revision_conflict' };
      }
      return { kind: 'draft_conflict' };
    }
    const autosave = await readAutosave({
      db: input.db,
      kind: input.kind,
      userId: input.userId,
      locator: { draftId: input.request.draft_id },
      now,
    });
    if (!autosave) throw new TypeError('D1 did not return the saved autosave.');
    return { kind: 'completed', autosave };
  } catch (cause) {
    if (cause instanceof StudioOperationalError) throw cause;
    throw new StudioOperationalError(config.writeFailureCode, {
      cause,
      metadata: operationMetadata(input.kind, 'write_content_autosave'),
    });
  }
}

async function deleteAutosave(input: {
  db: D1Database;
  kind: AutosaveKind;
  userId: string;
  draftId: string;
}): Promise<boolean> {
  const config = CONFIG[input.kind];
  try {
    const result = await input.db.prepare(`
      DELETE FROM ${config.table} WHERE user_id = ? AND draft_id = ?
    `).bind(input.userId, input.draftId).run();
    return readChanges(result) > 0;
  } catch (cause) {
    throw new StudioOperationalError(config.writeFailureCode, {
      cause,
      metadata: operationMetadata(input.kind, 'delete_content_autosave'),
    });
  }
}

export async function readPostAutosave(input: {
  db: D1Database; userId: string; locator: AutosaveLocator; now?: Date;
}): Promise<PostAutosaveDocument | null> {
  return await readAutosave({ ...input, kind: 'post' }) as PostAutosaveDocument | null;
}

export async function readPageAutosave(input: {
  db: D1Database; userId: string; locator: AutosaveLocator; now?: Date;
}): Promise<PageAutosaveDocument | null> {
  return await readAutosave({ ...input, kind: 'page' }) as PageAutosaveDocument | null;
}

export async function readRecentPostAutosave(input: {
  db: D1Database;
  userId: string;
  authorId?: string;
  now?: Date;
}): Promise<PostAutosaveDocument | null> {
  return await readLatestUnboundAutosave({
    ...input,
    kind: 'post',
  }) as PostAutosaveDocument | null;
}

export async function readRecentPageAutosave(input: {
  db: D1Database;
  userId: string;
  now?: Date;
}): Promise<PageAutosaveDocument | null> {
  return await readLatestUnboundAutosave({
    ...input,
    kind: 'page',
  }) as PageAutosaveDocument | null;
}

export async function putPostAutosave(input: {
  db: D1Database; userId: string; request: PutPostAutosaveRequest; now?: Date;
}): Promise<PutAutosaveResult<PostAutosaveDocument>> {
  return await putAutosave({ ...input, kind: 'post' }) as PutAutosaveResult<PostAutosaveDocument>;
}

export async function putPageAutosave(input: {
  db: D1Database; userId: string; request: PutPageAutosaveRequest; now?: Date;
}): Promise<PutAutosaveResult<PageAutosaveDocument>> {
  return await putAutosave({ ...input, kind: 'page' }) as PutAutosaveResult<PageAutosaveDocument>;
}

export function deletePostAutosave(input: {
  db: D1Database; userId: string; draftId: string;
}) {
  return deleteAutosave({ ...input, kind: 'post' });
}

export function deletePageAutosave(input: {
  db: D1Database; userId: string; draftId: string;
}) {
  return deleteAutosave({ ...input, kind: 'page' });
}

export async function garbageCollectExpiredContentAutosaves(input: {
  db: D1Database;
  now?: Date;
}): Promise<{ deletedRows: number; cutoffAtIso: string }> {
  const cutoffAtIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      input.db.prepare(
        'DELETE FROM post_autosaves WHERE expires_at_iso IS NOT NULL AND expires_at_iso <= ?',
      ).bind(cutoffAtIso),
      input.db.prepare(
        'DELETE FROM page_autosaves WHERE expires_at_iso IS NOT NULL AND expires_at_iso <= ?',
      ).bind(cutoffAtIso),
    ]);
    return {
      deletedRows: results.reduce((total, result) => (
        total + readChanges(result)
      ), 0),
      cutoffAtIso,
    };
  } catch (cause) {
    throw new StudioOperationalError(
      'CONTENT_AUTOSAVE_GARBAGE_COLLECTION_FAILED',
      {
        cause,
        metadata: {
          resource: 'DB',
          action: 'garbage_collect_content_autosaves',
        },
      },
    );
  }
}
