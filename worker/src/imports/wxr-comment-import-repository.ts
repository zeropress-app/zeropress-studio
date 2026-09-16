import type {
  WxrCoreImportChunkRequest,
  WxrImportCommentRow,
  WxrImportRowFailureCode,
} from '../../../contracts/wxr-import';
import { StudioOperationalError } from '../lib/operational-error';
import type { WxrCoreImportChunkResult } from './wxr-core-import-repository';

type CommentRequest = Extract<WxrCoreImportChunkRequest, { phase: 'comments' }>;

type TargetRow = {
  id?: unknown;
  target_type?: unknown;
  public_id?: unknown;
};

type ExistingCommentRow = {
  public_id?: unknown;
  target_id?: unknown;
  parent_public_id?: unknown;
  author_name?: unknown;
  author_email?: unknown;
  content?: unknown;
  status?: unknown;
  imported?: unknown;
  ip_address?: unknown;
  ip_address_recorded_at?: unknown;
  ip_hash?: unknown;
  user_agent?: unknown;
  asn?: unknown;
  as_organization?: unknown;
  country_code?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  author_user_id?: unknown;
  author_kind?: unknown;
  author_identity_issuer?: unknown;
};

type AcceptedComment = {
  targetId: number;
  imported: true;
};

const IN_QUERY_CHUNK_SIZE = 89;

function queryFailure(error: unknown, action: string) {
  return new StudioOperationalError(
    'WXR_COMMENT_IMPORT_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'EDGE_DB', action },
    },
  );
}

function writeFailure(error: unknown, action: string) {
  if (error instanceof StudioOperationalError) return error;
  return new StudioOperationalError(
    'WXR_COMMENT_IMPORT_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'EDGE_DB', action },
    },
  );
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function targetKey(type: 'post' | 'page', publicId: number): string {
  return `${type}:${publicId}`;
}

function nullable(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? null : value;
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const value = Number(result?.meta?.changes);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function loadTargets(input: {
  edgeDb: D1Database;
  rows: readonly WxrImportCommentRow[];
}): Promise<Map<string, number>> {
  const targets = new Map<string, number>();
  try {
    for (const type of ['post', 'page'] as const) {
      const publicIds = [...new Set(input.rows
        .filter((row) => row.target_type === type)
        .map((row) => row.target_public_id))];
      for (let index = 0; index < publicIds.length; index += IN_QUERY_CHUNK_SIZE) {
        const chunk = publicIds.slice(index, index + IN_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = await input.edgeDb.prepare(`
          SELECT id, target_type, public_id
          FROM edge_comment_targets
          WHERE target_type = ? AND public_id IN (${placeholders})
        `).bind(type, ...chunk).all<TargetRow>();
        for (const row of result.results ?? []) {
          const id = positiveInteger(row.id);
          const publicId = positiveInteger(row.public_id);
          if (!id || !publicId || row.target_type !== type) {
            throw new TypeError('EDGE_DB returned an invalid comment target.');
          }
          targets.set(targetKey(type, publicId), id);
        }
      }
    }
  } catch (error) {
    throw queryFailure(error, 'resolve_wxr_comment_targets');
  }
  return targets;
}

async function loadExistingComments(input: {
  edgeDb: D1Database;
  rows: readonly WxrImportCommentRow[];
}): Promise<Map<number, ExistingCommentRow>> {
  const publicIds = [...new Set(input.rows.flatMap((row) => [
    row.public_id,
    ...(row.parent_public_id === null ? [] : [row.parent_public_id]),
  ]))];
  const comments = new Map<number, ExistingCommentRow>();
  try {
    for (let index = 0; index < publicIds.length; index += IN_QUERY_CHUNK_SIZE) {
      const chunk = publicIds.slice(index, index + IN_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await input.edgeDb.prepare(`
        SELECT public_id, target_id, parent_public_id, author_name,
          author_email, content, status, imported, ip_address,
          ip_address_recorded_at, ip_hash, user_agent, asn,
          as_organization, country_code, created_at, updated_at,
          author_user_id, author_kind, author_identity_issuer
        FROM comments
        WHERE public_id IN (${placeholders})
      `).bind(...chunk).all<ExistingCommentRow>();
      for (const row of result.results ?? []) {
        const publicId = positiveInteger(row.public_id);
        const targetId = positiveInteger(row.target_id);
        if (!publicId || !targetId) {
          throw new TypeError('EDGE_DB returned an invalid imported comment.');
        }
        comments.set(publicId, row);
      }
    }
  } catch (error) {
    throw queryFailure(error, 'read_wxr_comments');
  }
  return comments;
}

function isSameImportedComment(
  current: ExistingCommentRow,
  row: WxrImportCommentRow,
  targetId: number,
): boolean {
  return positiveInteger(current.target_id) === targetId
    && (current.parent_public_id === null
      ? null
      : positiveInteger(current.parent_public_id)) === row.parent_public_id
    && current.author_name === row.author_name
    && current.author_email === row.author_email
    && current.content === row.content_text
    && current.status === row.status
    && Number(current.imported) === 1
    && nullable(current.ip_address) === null
    && nullable(current.ip_address_recorded_at) === null
    && nullable(current.ip_hash) === null
    && nullable(current.user_agent) === null
    && nullable(current.asn) === null
    && nullable(current.as_organization) === null
    && nullable(current.country_code) === null
    && current.created_at === row.created_at_iso
    && current.updated_at === row.created_at_iso
    && nullable(current.author_user_id) === null
    && current.author_kind === 'guest'
    && nullable(current.author_identity_issuer) === null;
}

function addFailure(
  summary: WxrCoreImportChunkResult['summary'],
  rowIndex: number,
  row: WxrImportCommentRow,
  code: WxrImportRowFailureCode,
) {
  summary.failed += 1;
  summary.failures.push({
    row_index: rowIndex,
    key: String(row.public_id),
    code,
  });
}

export async function importWxrCommentChunk(input: {
  edgeDb: D1Database;
  request: CommentRequest;
}): Promise<WxrCoreImportChunkResult> {
  const summary: WxrCoreImportChunkResult['summary'] = {
    phase: 'comments',
    processed: input.request.rows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    failures: [],
  };
  const [targets, existingComments] = await Promise.all([
    loadTargets({ edgeDb: input.edgeDb, rows: input.request.rows }),
    loadExistingComments({ edgeDb: input.edgeDb, rows: input.request.rows }),
  ]);
  const accepted = new Map<number, AcceptedComment>();
  const writes: D1PreparedStatement[] = [];
  const touchedTargetIds = new Set<number>();

  for (const [rowIndex, row] of input.request.rows.entries()) {
    const targetId = targets.get(targetKey(
      row.target_type,
      row.target_public_id,
    ));
    if (!targetId) {
      addFailure(summary, rowIndex, row, 'COMMENT_TARGET_NOT_FOUND');
      continue;
    }

    if (row.parent_public_id !== null) {
      const loadedParent = existingComments.get(row.parent_public_id);
      const parent = accepted.get(row.parent_public_id) ?? (
        loadedParent && Number(loadedParent.imported) === 1
          ? {
              targetId: positiveInteger(loadedParent.target_id) ?? 0,
              imported: true as const,
            }
          : undefined
      );
      if (!parent || parent.targetId !== targetId) {
        addFailure(summary, rowIndex, row, 'COMMENT_PARENT_NOT_FOUND');
        continue;
      }
    }

    const current = existingComments.get(row.public_id);
    if (current && (
      Number(current.imported) !== 1
      || positiveInteger(current.target_id) !== targetId
    )) {
      addFailure(summary, rowIndex, row, 'COMMENT_PUBLIC_ID_CONFLICT');
      continue;
    }

    accepted.set(row.public_id, { targetId, imported: true });
    if (current && isSameImportedComment(current, row, targetId)) {
      summary.unchanged += 1;
      continue;
    }

    if (current) {
      writes.push(input.edgeDb.prepare(`
        UPDATE comments
        SET parent_public_id = ?, author_name = ?, author_email = ?,
          content = ?, status = ?, imported = 1, ip_address = NULL,
          ip_address_recorded_at = NULL, ip_hash = NULL, user_agent = NULL,
          asn = NULL, as_organization = NULL, country_code = NULL,
          created_at = ?, updated_at = ?, author_user_id = NULL,
          author_kind = 'guest', author_identity_issuer = NULL
        WHERE public_id = ? AND target_id = ? AND imported = 1
      `).bind(
        row.parent_public_id,
        row.author_name,
        row.author_email,
        row.content_text,
        row.status,
        row.created_at_iso,
        row.created_at_iso,
        row.public_id,
        targetId,
      ));
      summary.updated += 1;
    } else {
      writes.push(input.edgeDb.prepare(`
        INSERT INTO comments (
          public_id, target_id, parent_public_id, author_name, author_email,
          content, status, imported, ip_address, ip_address_recorded_at,
          ip_hash, user_agent, asn, as_organization, country_code,
          created_at, updated_at, author_user_id, author_kind,
          author_identity_issuer
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          ?, ?, NULL, 'guest', NULL
        )
      `).bind(
        row.public_id,
        targetId,
        row.parent_public_id,
        row.author_name,
        row.author_email,
        row.content_text,
        row.status,
        row.created_at_iso,
        row.created_at_iso,
      ));
      summary.created += 1;
    }
    touchedTargetIds.add(targetId);
  }

  if (writes.length === 0) return { summary };

  const touched = [...touchedTargetIds].sort((left, right) => left - right);
  const placeholders = touched.map(() => '?').join(', ');
  const revisionWrite = input.edgeDb.prepare(`
    UPDATE edge_comment_targets
    SET comments_cache_revision = lower(hex(randomblob(16)))
    WHERE id IN (${placeholders})
  `).bind(...touched);
  try {
    const results = await input.edgeDb.batch([...writes, revisionWrite]);
    const writeResults = results.slice(0, writes.length);
    const revisionResult = results.at(-1);
    if (
      writeResults.some((result) => readChanges(result) !== 1)
      || readChanges(revisionResult) !== touched.length
    ) {
      throw new TypeError('EDGE_DB did not commit the complete WXR comment chunk.');
    }
  } catch (error) {
    throw writeFailure(error, 'upsert_wxr_comments');
  }
  return { summary };
}
