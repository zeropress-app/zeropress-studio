import type {
  ContentSearchIndexRebuildStepRequest,
  ContentSearchIndexStatus,
} from '../../../contracts/content-search-index';
import type { OperationsInitiator } from '../operations/initiator';
import {
  CONTENT_SEARCH_REBUILD_BATCH_SIZE,
  prepareContentSearchReplaceStatements,
  readContentSearchIndexState,
  type SearchIndexDocument,
  type ContentSearchIndexState,
} from './index-repository';

export const POST_SEARCH_FTS_CREATE_SQL = `
  CREATE VIRTUAL TABLE post_search_fts USING fts5(
    revision UNINDEXED,
    title,
    slug,
    excerpt,
    body,
    tokenize='trigram case_sensitive 0 remove_diacritics 1'
  )
`;

export const PAGE_SEARCH_FTS_CREATE_SQL = `
  CREATE VIRTUAL TABLE page_search_fts USING fts5(
    revision UNINDEXED,
    title,
    slug,
    excerpt,
    body,
    tokenize='trigram case_sensitive 0 remove_diacritics 1'
  )
`;

export const POST_SEARCH_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER trg_posts_search_delete
  AFTER DELETE ON posts
  BEGIN
    DELETE FROM post_search_fts WHERE rowid = OLD.public_id;
  END
`;

export const PAGE_SEARCH_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER trg_pages_search_delete
  AFTER DELETE ON pages
  BEGIN
    DELETE FROM page_search_fts WHERE rowid = OLD.public_id;
  END
`;

type ContentRow = {
  public_id?: unknown;
  revision?: unknown;
  title?: unknown;
  slug?: unknown;
  excerpt?: unknown;
  content?: unknown;
  document_type?: unknown;
};

type CountRow = {
  post_count?: unknown;
  page_count?: unknown;
};

type ParityRow = {
  canonical_count?: unknown;
  indexed_count?: unknown;
  missing_count?: unknown;
  orphan_count?: unknown;
};

export class ContentSearchRebuildError extends Error {
  constructor(
    readonly issue:
      | 'not_available'
      | 'state_conflict'
      | 'integrity_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ContentSearchRebuildError';
  }
}

function hexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function changes(result: D1Result<unknown> | undefined): number {
  const value = result?.meta?.changes;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function count(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('D1 returned an invalid content-search count.');
  }
  return parsed;
}

function parseContentRow(row: ContentRow): SearchIndexDocument {
  const publicId = Number(row.public_id);
  if (
    !Number.isSafeInteger(publicId)
    || publicId <= 0
    || typeof row.revision !== 'string'
    || !/^[0-9a-f]{32}$/u.test(row.revision)
    || typeof row.title !== 'string'
    || typeof row.slug !== 'string'
    || typeof row.excerpt !== 'string'
    || typeof row.content !== 'string'
    || (
      row.document_type !== 'html'
      && row.document_type !== 'markdown'
      && row.document_type !== 'plaintext'
    )
  ) throw new TypeError('D1 returned invalid canonical search content.');
  return {
    publicId,
    revision: row.revision,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    documentType: row.document_type,
  };
}

export function materializeContentSearchIndexStatus(
  state: ContentSearchIndexState,
  available: boolean,
): ContentSearchIndexStatus {
  return {
    state: state.state,
    reason: state.reason,
    phase: state.phase,
    operation_id: state.operationId,
    post_public_id_cursor: state.postPublicIdCursor,
    page_public_id_cursor: state.pagePublicIdCursor,
    processed_posts: state.processedPosts,
    processed_pages: state.processedPages,
    total_posts: state.totalPosts,
    total_pages: state.totalPages,
    available,
  };
}

export const unavailableContentSearchIndexStatus: ContentSearchIndexStatus = {
  state: 'unavailable',
  reason: null,
  phase: null,
  operation_id: null,
  post_public_id_cursor: 0,
  page_public_id_cursor: 0,
  processed_posts: 0,
  processed_pages: 0,
  total_posts: 0,
  total_pages: 0,
  available: false,
};

export async function inspectContentSearchIndex(input: {
  db: D1Database;
  available: boolean;
}): Promise<ContentSearchIndexStatus> {
  return materializeContentSearchIndexStatus(
    await readContentSearchIndexState(input.db),
    input.available,
  );
}

export async function isContentSearchIndexRebuildInProgress(
  db: D1Database,
): Promise<boolean> {
  return (await readContentSearchIndexState(db)).state === 'in_progress';
}

export async function startContentSearchIndexRebuild(input: {
  db: D1Database;
  initiator: OperationsInitiator;
  operationId?: string;
  now?: Date;
  expectedState?: 'rebuild_required';
}): Promise<ContentSearchIndexStatus> {
  const current = await readContentSearchIndexState(input.db);
  // Keep this check inside the same read/CAS path as the destructive batch.
  // A dashboard request must never restart another administrator's rebuild.
  if (input.expectedState && current.state !== input.expectedState) {
    throw new ContentSearchRebuildError(
      'state_conflict',
      'Content-search rebuild is no longer required. Refresh its status.',
    );
  }
  const operationId = input.operationId ?? hexId();
  const nowIso = (input.now ?? new Date()).toISOString();
  const counts = await input.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts) AS post_count,
      (SELECT COUNT(*) FROM pages) AS page_count
  `).first<CountRow>();
  const postCount = count(counts?.post_count);
  const pageCount = count(counts?.page_count);
  const stateStatement = input.db.prepare(`
      UPDATE content_search_index_state
      SET state = CASE
            WHEN state = ?
              AND operation_id IS ?
              AND updated_at_iso = ?
            THEN 'in_progress'
            ELSE 'invalid'
          END,
          reason = 'manual_rebuild',
          phase = 'posts',
          operation_id = ?,
          post_public_id_cursor = 0,
          page_public_id_cursor = 0,
          processed_posts = 0,
          processed_pages = 0,
          total_posts = ?,
          total_pages = ?,
          started_at_iso = ?,
          initiated_by_user_id = ?,
          initiated_by_user_email = ?,
          updated_at_iso = ?
      WHERE id = 1
    `).bind(
      current.state,
      current.operationId,
      current.updatedAtIso,
      operationId,
      postCount,
      pageCount,
      nowIso,
      input.initiator.userId,
      input.initiator.userEmail,
      nowIso,
    );
  const results = await input.db.batch([
    // A stale state writes the deliberately invalid CHECK value first, so D1
    // rolls back this whole batch before any destructive FTS DDL can commit.
    stateStatement,
    input.db.prepare('DROP TRIGGER IF EXISTS trg_posts_search_delete'),
    input.db.prepare('DROP TRIGGER IF EXISTS trg_pages_search_delete'),
    input.db.prepare('DROP TABLE IF EXISTS post_search_fts'),
    input.db.prepare('DROP TABLE IF EXISTS page_search_fts'),
    input.db.prepare(POST_SEARCH_FTS_CREATE_SQL),
    input.db.prepare(PAGE_SEARCH_FTS_CREATE_SQL),
    input.db.prepare(POST_SEARCH_DELETE_TRIGGER_SQL),
    input.db.prepare(PAGE_SEARCH_DELETE_TRIGGER_SQL),
  ]).catch(async (error: unknown) => {
    try {
      const latest = await readContentSearchIndexState(input.db);
      if (
        latest.state !== current.state
        || latest.operationId !== current.operationId
        || latest.updatedAtIso !== current.updatedAtIso
      ) {
        throw new ContentSearchRebuildError(
          'state_conflict',
          'Content-search rebuild state changed concurrently.',
        );
      }
    } catch (inspectionError) {
      if (inspectionError instanceof ContentSearchRebuildError) {
        throw inspectionError;
      }
    }
    throw error;
  });
  if (changes(results[0]) === 0) {
    throw new ContentSearchRebuildError(
      'state_conflict',
      'Content-search rebuild state changed concurrently.',
    );
  }
  return inspectContentSearchIndex({ db: input.db, available: true });
}

function expectedStateMatches(
  state: ContentSearchIndexState,
  request: ContentSearchIndexRebuildStepRequest,
): boolean {
  return state.state === 'in_progress'
    && state.operationId === request.operation_id
    && state.phase === request.expected_phase
    && state.postPublicIdCursor === request.expected_post_public_id_cursor
    && state.pagePublicIdCursor === request.expected_page_public_id_cursor;
}

async function markIntegrityFailure(input: {
  db: D1Database;
  operationId: string;
  nowIso: string;
}) {
  await input.db.prepare(`
    UPDATE content_search_index_state
    SET state = 'recovery_required',
        reason = 'integrity_failure',
        phase = NULL,
        operation_id = NULL,
        started_at_iso = NULL,
        initiated_by_user_id = NULL,
        initiated_by_user_email = NULL,
        updated_at_iso = ?
    WHERE id = 1 AND state = 'in_progress' AND operation_id = ?
  `).bind(input.nowIso, input.operationId).run();
}

async function verifyContentSearchIndex(input: {
  db: D1Database;
  state: ContentSearchIndexState;
  nowIso: string;
}): Promise<ContentSearchIndexStatus> {
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM posts) AS canonical_count,
          (SELECT COUNT(*) FROM post_search_fts) AS indexed_count,
          (SELECT COUNT(*)
           FROM posts
           LEFT JOIN post_search_fts AS search_fts
             ON search_fts.rowid = posts.public_id
            AND search_fts.revision = posts.revision
           WHERE search_fts.rowid IS NULL) AS missing_count,
          (SELECT COUNT(*)
           FROM post_search_fts AS search_fts
           LEFT JOIN posts ON posts.public_id = search_fts.rowid
                          AND posts.revision = search_fts.revision
           WHERE posts.id IS NULL) AS orphan_count
      `),
      input.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM pages) AS canonical_count,
          (SELECT COUNT(*) FROM page_search_fts) AS indexed_count,
          (SELECT COUNT(*)
           FROM pages
           LEFT JOIN page_search_fts AS search_fts
             ON search_fts.rowid = pages.public_id
            AND search_fts.revision = pages.revision
           WHERE search_fts.rowid IS NULL) AS missing_count,
          (SELECT COUNT(*)
           FROM page_search_fts AS search_fts
           LEFT JOIN pages ON pages.public_id = search_fts.rowid
                          AND pages.revision = search_fts.revision
           WHERE pages.id IS NULL) AS orphan_count
      `),
      input.db.prepare(`
        INSERT INTO post_search_fts(post_search_fts)
        VALUES ('integrity-check')
      `),
      input.db.prepare(`
        INSERT INTO page_search_fts(page_search_fts)
        VALUES ('integrity-check')
      `),
    ]);
    for (const result of results.slice(0, 2)) {
      const row = result.results?.[0] as ParityRow | undefined;
      const canonical = count(row?.canonical_count);
      if (
        count(row?.indexed_count) !== canonical
        || count(row?.missing_count) !== 0
        || count(row?.orphan_count) !== 0
      ) throw new TypeError('Content-search revision parity failed.');
    }
    const completion = await input.db.prepare(`
      UPDATE content_search_index_state
      SET state = 'ready',
          reason = NULL,
          phase = NULL,
          operation_id = NULL,
          started_at_iso = NULL,
          initiated_by_user_id = NULL,
          initiated_by_user_email = NULL,
          updated_at_iso = ?
      WHERE id = 1
        AND state = 'in_progress'
        AND operation_id = ?
        AND phase = 'verify'
        AND post_public_id_cursor = ?
        AND page_public_id_cursor = ?
    `).bind(
      input.nowIso,
      input.state.operationId,
      input.state.postPublicIdCursor,
      input.state.pagePublicIdCursor,
    ).run();
    if (changes(completion) === 0) {
      throw new ContentSearchRebuildError(
        'state_conflict',
        'Content-search verification state changed concurrently.',
      );
    }
    return inspectContentSearchIndex({ db: input.db, available: true });
  } catch (error) {
    if (error instanceof ContentSearchRebuildError) throw error;
    await markIntegrityFailure({
      db: input.db,
      operationId: input.state.operationId!,
      nowIso: input.nowIso,
    });
    throw new ContentSearchRebuildError(
      'integrity_failed',
      error instanceof Error ? error.message : 'Content-search integrity failed.',
    );
  }
}

export async function applyContentSearchIndexRebuildStep(input: {
  db: D1Database;
  request: ContentSearchIndexRebuildStepRequest;
  now?: Date;
}): Promise<ContentSearchIndexStatus> {
  const state = await readContentSearchIndexState(input.db);
  if (!expectedStateMatches(state, input.request)) {
    throw new ContentSearchRebuildError(
      'state_conflict',
      'Content-search rebuild cursor changed. Refresh status before resuming.',
    );
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  if (state.phase === 'verify') {
    return verifyContentSearchIndex({ db: input.db, state, nowIso });
  }
  const targetType = state.phase === 'posts' ? 'post' : 'page';
  const table = targetType === 'post' ? 'posts' : 'pages';
  const cursor = targetType === 'post'
    ? state.postPublicIdCursor
    : state.pagePublicIdCursor;
  const result = await input.db.prepare(`
    SELECT public_id, revision, title, slug, excerpt, content, document_type
    FROM ${table}
    WHERE public_id > ?
    ORDER BY public_id
    LIMIT ?
  `).bind(cursor, CONTENT_SEARCH_REBUILD_BATCH_SIZE).all<ContentRow>();
  if (!Array.isArray(result.results)) {
    throw new TypeError('D1 returned invalid content-search rebuild rows.');
  }
  const documents = result.results.map(parseContentRow);
  const nextCursor = documents.at(-1)?.publicId ?? cursor;
  const exhausted = documents.length < CONTENT_SEARCH_REBUILD_BATCH_SIZE;
  const nextPhase = exhausted
    ? targetType === 'post' ? 'pages' : 'verify'
    : state.phase;
  const replacementStatements = documents.flatMap((document) => (
    prepareContentSearchReplaceStatements({
      db: input.db,
      targetType,
      document,
    })
  ));
  const stateStatement = input.db.prepare(`
    UPDATE content_search_index_state
    SET state = CASE
          WHEN state = 'in_progress'
            AND operation_id = ?
            AND phase = ?
            AND post_public_id_cursor = ?
            AND page_public_id_cursor = ?
          THEN state
          ELSE 'invalid'
        END,
        phase = ?,
        post_public_id_cursor = ?,
        page_public_id_cursor = ?,
        processed_posts = ?,
        processed_pages = ?,
        updated_at_iso = ?
    WHERE id = 1
  `).bind(
    input.request.operation_id,
    input.request.expected_phase,
    input.request.expected_post_public_id_cursor,
    input.request.expected_page_public_id_cursor,
    nextPhase,
    targetType === 'post' ? nextCursor : state.postPublicIdCursor,
    targetType === 'page' ? nextCursor : state.pagePublicIdCursor,
    state.processedPosts + (targetType === 'post' ? documents.length : 0),
    state.processedPages + (targetType === 'page' ? documents.length : 0),
    nowIso,
  );
  const results = await input.db.batch([
    // Advance the cursor first. A stale request violates the state CHECK and
    // atomically rolls back every following replacement statement.
    stateStatement,
    ...replacementStatements,
  ]).catch(
    async (error: unknown) => {
      try {
        const latest = await readContentSearchIndexState(input.db);
        if (!expectedStateMatches(latest, input.request)) {
          throw new ContentSearchRebuildError(
            'state_conflict',
            'Content-search rebuild cursor changed concurrently.',
          );
        }
      } catch (inspectionError) {
        if (inspectionError instanceof ContentSearchRebuildError) {
          throw inspectionError;
        }
      }
      throw error;
    },
  );
  if (changes(results[0]) === 0) {
    throw new ContentSearchRebuildError(
      'state_conflict',
      'Content-search rebuild cursor changed concurrently.',
    );
  }
  return inspectContentSearchIndex({ db: input.db, available: true });
}

export async function readContentSearchRebuildInitiator(input: {
  db: D1Database;
  operationId: string;
}): Promise<OperationsInitiator> {
  const row = await input.db.prepare(`
    SELECT initiated_by_user_id, initiated_by_user_email
    FROM content_search_index_state
    WHERE id = 1 AND state = 'in_progress' AND operation_id = ?
    LIMIT 1
  `).bind(input.operationId).first<{
    initiated_by_user_id?: unknown;
    initiated_by_user_email?: unknown;
  }>();
  if (
    typeof row?.initiated_by_user_id !== 'string'
    || !/^[0-9a-f]{32}$/u.test(row.initiated_by_user_id)
    || typeof row.initiated_by_user_email !== 'string'
  ) {
    throw new ContentSearchRebuildError(
      'state_conflict',
      'Content-search rebuild initiator is unavailable.',
    );
  }
  return {
    userId: row.initiated_by_user_id,
    userEmail: row.initiated_by_user_email,
  };
}
