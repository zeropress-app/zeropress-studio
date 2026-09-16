import {
  COMMENT_TARGET_OPTIONS_MAX_ITEMS,
  commentTargetSchema,
  managedCommentSchema,
  type CommentListQuery,
  type CommentBulkModerationData,
  type CommentBulkModerationRequest,
  type CommentBulkModerationResult,
  type CommentStatus,
  type CommentTarget,
  type CommentTargetOptionsQuery,
  type CommentTargetType,
  type CreateStudioCommentRequest,
  type ManagedComment,
  type UpdateCommentRequest,
} from '../../../contracts/comments';
import { ZEROPRESS_NATIVE_PUBLIC_ID_BASE } from '../../../contracts/content-public-id';
import type { AuthenticatedUser } from '../../../contracts/session';
import { StudioOperationalError } from '../lib/operational-error';

type CommentRow = {
  id?: unknown;
  public_id?: unknown;
  target_id?: unknown;
  target_type?: unknown;
  target_public_id?: unknown;
  target_status?: unknown;
  target_allow_comments?: unknown;
  parent_public_id?: unknown;
  thread_depth?: unknown;
  thread_comments?: unknown;
  thread_comments_depth?: unknown;
  author_name?: unknown;
  author_email?: unknown;
  author_kind?: unknown;
  content?: unknown;
  status?: unknown;
  ip_address?: unknown;
  user_agent?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type CommentIdentityRow = {
  id?: unknown;
  target_id?: unknown;
  public_id?: unknown;
  content?: unknown;
  status?: unknown;
  updated_at?: unknown;
};

type TargetRow = {
  id?: unknown;
  public_id?: unknown;
  title?: unknown;
  slug?: unknown;
  status?: unknown;
  allow_comments?: unknown;
};

type CreateTargetRow = {
  id?: unknown;
  status?: unknown;
  allow_comments?: unknown;
  thread_comments?: unknown;
  thread_comments_depth?: unknown;
};

type ParentRow = {
  public_id?: unknown;
  parent_public_id?: unknown;
  status?: unknown;
  updated_at?: unknown;
};

type CountRow = {
  total?: unknown;
  all_count?: unknown;
  pending_count?: unknown;
  approved_count?: unknown;
  spam_count?: unknown;
  trash_count?: unknown;
};

type CommentFilter = {
  whereSql: string;
  parameters: Array<string | number>;
};

type CommentTargetMetadata = {
  target: CommentTarget;
  authoringAvailable: boolean;
};

export type CommentListResult = {
  items: ManagedComment[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
  status_counts: {
    all: number;
    pending: number;
    approved: number;
    spam: number;
    trash: number;
  };
};

export type UpdateManagedCommentResult =
  | { kind: 'completed'; comment: ManagedComment }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' };

export type DeleteManagedCommentResult =
  | { kind: 'moved_to_trash'; comment: ManagedComment }
  | { kind: 'permanently_deleted'; deletedCount: number }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' };

export type CreateStudioCommentResult =
  | { kind: 'completed'; comment: ManagedComment }
  | { kind: 'target_not_available' }
  | { kind: 'reply_not_available' }
  | { kind: 'state_conflict' };

const COMMENT_SELECT = `
  SELECT
    c.id,
    c.public_id,
    c.target_id,
    t.target_type,
    t.public_id AS target_public_id,
    t.status AS target_status,
    t.allow_comments AS target_allow_comments,
    c.parent_public_id,
    (
      WITH RECURSIVE ancestry(
        public_id,
        parent_public_id,
        depth,
        path,
        invalid
      ) AS (
        SELECT
          c.public_id,
          c.parent_public_id,
          1,
          ',' || CAST(c.public_id AS TEXT) || ',',
          0
        UNION ALL
        SELECT
          parent.public_id,
          parent.parent_public_id,
          ancestry.depth + 1,
          ancestry.path || CAST(parent.public_id AS TEXT) || ',',
          CASE
            WHEN instr(
              ancestry.path,
              ',' || CAST(parent.public_id AS TEXT) || ','
            ) > 0 THEN 1
            ELSE 0
          END
        FROM ancestry
        INNER JOIN comments parent
          ON parent.public_id = ancestry.parent_public_id
          AND parent.target_id = c.target_id
          AND parent.status = 'approved'
        WHERE ancestry.parent_public_id IS NOT NULL
          AND ancestry.invalid = 0
          AND ancestry.depth < 10
      )
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM ancestry WHERE invalid = 1
        ) THEN -1
        WHEN EXISTS (
          SELECT 1
          FROM ancestry node
          WHERE node.parent_public_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM comments parent
              WHERE parent.public_id = node.parent_public_id
                AND parent.target_id = c.target_id
                AND parent.status = 'approved'
            )
        ) THEN -1
        WHEN EXISTS (
          SELECT 1
          FROM ancestry
          WHERE depth = 10 AND parent_public_id IS NOT NULL
        ) THEN -1
        ELSE COALESCE(MAX(depth), -1)
      END
      FROM ancestry
    ) AS thread_depth,
    (
      SELECT thread_comments
      FROM edge_comment_settings
      WHERE id = 1
    ) AS thread_comments,
    (
      SELECT thread_comments_depth
      FROM edge_comment_settings
      WHERE id = 1
    ) AS thread_comments_depth,
    c.author_name,
    c.author_email,
    c.author_kind,
    c.content,
    c.status,
    c.ip_address,
    c.user_agent,
    c.created_at,
    c.updated_at
  FROM comments c
  INNER JOIN edge_comment_targets t ON t.id = c.target_id
`;

function queryFailure(error: unknown, action: string, resource = 'EDGE_DB') {
  return new StudioOperationalError(
    resource === 'DB'
      ? 'COMMENT_TARGET_METADATA_DATABASE_QUERY_FAILED'
      : 'COMMENT_MANAGEMENT_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource, action },
    },
  );
}

function writeFailure(error: unknown, action: string) {
  return new StudioOperationalError('COMMENT_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function dataInvalid(cause?: unknown, resource: 'EDGE_DB' | 'DB' = 'EDGE_DB') {
  return new StudioOperationalError('COMMENT_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: {
      resource,
      action: resource === 'DB'
        ? 'validate_comment_target_metadata'
        : 'validate_managed_comment',
    },
  });
}

function parseCount(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw dataInvalid(new TypeError('D1 returned an invalid comment count.'));
  }
  return number;
}

function readChanges(result: D1Result<unknown> | undefined): number {
  return parseCount(result?.meta?.changes);
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw dataInvalid();
  const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value}Z`
    : value;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) throw dataInvalid();
  return new Date(timestamp).toISOString();
}

function nextTimestamp(now: Date, previousIso: string): string {
  const nowTimestamp = now.getTime();
  const previousTimestamp = Date.parse(previousIso);
  if (!Number.isFinite(nowTimestamp) || !Number.isFinite(previousTimestamp)) {
    throw new TypeError('Comment update time must be valid.');
  }
  return new Date(Math.max(nowTimestamp, previousTimestamp + 1)).toISOString();
}

function nullableText(value: unknown): unknown {
  return value === null || value === undefined || value === '' ? null : value;
}

function createOpaqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Comment creation time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function commentTargetKey(type: CommentTargetType, publicId: number): string {
  return `${type}:${publicId}`;
}

function parseComment(
  row: CommentRow,
  targets: ReadonlyMap<string, CommentTargetMetadata>,
): ManagedComment {
  const targetType = row.target_type;
  const targetPublicId = Number(row.target_public_id);
  const targetMetadata = (
    (targetType === 'post' || targetType === 'page')
    && Number.isSafeInteger(targetPublicId)
  )
    ? targets.get(commentTargetKey(targetType, targetPublicId)) ?? null
    : null;
  const target = targetMetadata?.target ?? null;
  const edgeTargetStatus = row.target_status;
  const edgeTargetAllowsComments = Number(row.target_allow_comments);
  const threadDepth = Number(row.thread_depth);
  const threadComments = Number(row.thread_comments);
  const maxDepth = Number(row.thread_comments_depth);
  if (
    !Number.isSafeInteger(threadDepth)
    || threadDepth < -1
    || threadDepth > 10
    || ![0, 1].includes(threadComments)
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 2
    || maxDepth > 10
    || typeof edgeTargetStatus !== 'string'
    || !['draft', 'published', 'scheduled', 'trash', 'archived'].includes(
      edgeTargetStatus,
    )
    || ![0, 1].includes(edgeTargetAllowsComments)
  ) throw dataInvalid();
  const targetAllowsAuthoring = targetMetadata?.authoringAvailable === true
    && edgeTargetStatus === 'published'
    && edgeTargetAllowsComments === 1;
  const reply = !targetAllowsAuthoring
    ? { available: false as const, reason: 'target_unavailable' as const }
    : row.status !== 'approved'
      ? { available: false as const, reason: 'not_approved' as const }
      : threadComments !== 1
        ? { available: false as const, reason: 'threading_disabled' as const }
        : threadDepth === -1
          ? { available: false as const, reason: 'invalid_thread' as const }
          : threadDepth >= maxDepth
            ? { available: false as const, reason: 'depth_limit' as const }
            : { available: true as const };
  const value = {
    id: row.id,
    public_id: Number(row.public_id),
    target_type: targetType,
    target_public_id: targetPublicId,
    target,
    parent_public_id: row.parent_public_id === null
      ? null
      : Number(row.parent_public_id),
    reply,
    author: {
      name: row.author_name,
      email: row.author_email,
      kind: row.author_kind,
    },
    content_text: row.content,
    status: row.status,
    ip_address: nullableText(row.ip_address),
    user_agent: nullableText(row.user_agent),
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  };
  const parsed = managedCommentSchema.safeParse(value);
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

export async function listCommentTargetOptions(input: {
  db: D1Database;
  edgeDb: D1Database;
  query: CommentTargetOptionsQuery;
}): Promise<CommentTarget[]> {
  const table = input.query.target_type === 'post' ? 'posts' : 'pages';
  const search = input.query.search;
  let sourceRows: TargetRow[];
  try {
    const result = await input.db.prepare(`
      SELECT id, public_id, title, slug, status, allow_comments
      FROM ${table}
      WHERE status = 'published'
        AND allow_comments = 1
        AND (
          ? = ''
          OR instr(lower(title), lower(?)) > 0
          OR instr(lower(slug), lower(?)) > 0
          OR CAST(public_id AS TEXT) = ?
        )
      ORDER BY title COLLATE NOCASE, title, public_id
      LIMIT ?
    `).bind(
      search,
      search,
      search,
      search,
      COMMENT_TARGET_OPTIONS_MAX_ITEMS,
    ).all<TargetRow>();
    sourceRows = result.results ?? [];
  } catch (error) {
    throw queryFailure(error, 'list_comment_target_options', 'DB');
  }

  const targets = sourceRows.map((row) => {
    const parsed = commentTargetSchema.safeParse({
      type: input.query.target_type,
      id: row.id,
      public_id: Number(row.public_id),
      title: row.title,
      slug: row.slug,
    });
    if (
      !parsed.success
      || row.status !== 'published'
      || Number(row.allow_comments) !== 1
    ) throw dataInvalid(parsed.success ? undefined : parsed.error, 'DB');
    return parsed.data;
  });

  const projected = new Set<number>();
  for (let offset = 0; offset < targets.length; offset += 90) {
    const chunk = targets.slice(offset, offset + 90);
    if (chunk.length === 0) continue;
    let rows: Array<{ public_id?: unknown }>;
    try {
      const result = await input.edgeDb.prepare(`
        SELECT public_id
        FROM edge_comment_targets
        WHERE target_type = ?
          AND status = 'published'
          AND allow_comments = 1
          AND public_id IN (${chunk.map(() => '?').join(', ')})
      `).bind(
        input.query.target_type,
        ...chunk.map((target) => target.public_id),
      ).all<{ public_id?: unknown }>();
      rows = result.results ?? [];
    } catch (error) {
      throw queryFailure(error, 'list_comment_target_options');
    }
    for (const row of rows) {
      const publicId = Number(row.public_id);
      if (!Number.isSafeInteger(publicId) || publicId <= 0) {
        throw dataInvalid();
      }
      projected.add(publicId);
    }
  }
  return targets.filter((target) => projected.has(target.public_id));
}

export function buildCommentFilter(
  query: CommentListQuery,
  includeStatus: boolean,
): CommentFilter {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (query.target_type !== 'all') {
    conditions.push('t.target_type = ?');
    parameters.push(query.target_type);
  }
  if (query.target_public_id !== undefined) {
    conditions.push('t.public_id = ?');
    parameters.push(query.target_public_id);
  }
  if (includeStatus && query.status !== 'all') {
    conditions.push('c.status = ?');
    parameters.push(query.status);
  }
  if (query.search) {
    conditions.push(`(
      instr(lower(c.content), lower(?)) > 0
      OR instr(lower(c.author_name), lower(?)) > 0
      OR instr(lower(c.author_email), lower(?)) > 0
    )`);
    parameters.push(query.search, query.search, query.search);
  }
  return {
    whereSql: conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '',
    parameters,
  };
}

async function loadCommentTargets(input: {
  db: D1Database;
  rows: CommentRow[];
}): Promise<Map<string, CommentTargetMetadata>> {
  const targets = new Map<string, CommentTargetMetadata>();
  for (const targetType of ['post', 'page'] as const) {
    const publicIds = [...new Set(input.rows
      .filter((row) => row.target_type === targetType)
      .map((row) => Number(row.target_public_id))
      .filter((publicId) => Number.isSafeInteger(publicId) && publicId > 0))];
    for (let offset = 0; offset < publicIds.length; offset += 90) {
      const chunk = publicIds.slice(offset, offset + 90);
      if (chunk.length === 0) continue;
      const table = targetType === 'post' ? 'posts' : 'pages';
      let rows: TargetRow[];
      try {
        const result = await input.db.prepare(`
          SELECT id, public_id, title, slug, status, allow_comments
          FROM ${table}
          WHERE public_id IN (${chunk.map(() => '?').join(', ')})
        `).bind(...chunk).all<TargetRow>();
        rows = result.results ?? [];
      } catch (error) {
        throw queryFailure(error, 'read_comment_target_metadata', 'DB');
      }
      for (const row of rows) {
        const publicId = Number(row.public_id);
        const parsed = commentTargetSchema.safeParse({
          type: targetType,
          id: row.id,
          public_id: publicId,
          title: row.title,
          slug: row.slug,
        });
        const status = row.status;
        const allowComments = Number(row.allow_comments);
        if (
          !parsed.success
          || !['draft', 'published', 'trash'].includes(String(status))
          || ![0, 1].includes(allowComments)
        ) throw dataInvalid(parsed.success ? undefined : parsed.error, 'DB');
        targets.set(commentTargetKey(targetType, publicId), {
          target: parsed.data,
          authoringAvailable: status === 'published' && allowComments === 1,
        });
      }
    }
  }
  return targets;
}

async function readManagedComment(input: {
  db: D1Database;
  edgeDb: D1Database;
  id: string;
}): Promise<ManagedComment | null> {
  let row: CommentRow | null;
  try {
    row = await input.edgeDb.prepare(`
      ${COMMENT_SELECT}
      WHERE c.id = ?
      LIMIT 1
    `).bind(input.id).first<CommentRow>();
  } catch (error) {
    throw queryFailure(error, 'read_managed_comment');
  }
  if (!row) return null;
  const targets = await loadCommentTargets({ db: input.db, rows: [row] });
  return parseComment(row, targets);
}

export async function listManagedComments(input: {
  db: D1Database;
  edgeDb: D1Database;
  query: CommentListQuery;
}): Promise<CommentListResult> {
  const listFilter = buildCommentFilter(input.query, true);
  const statusFilter = buildCommentFilter(input.query, false);
  const offset = (input.query.page - 1) * input.query.per_page;
  let rows: CommentRow[];
  let countRow: CountRow | null;
  let statusRow: CountRow | null;
  try {
    const [listResult, totalResult, statusResult] = await Promise.all([
      input.edgeDb.prepare(`
        ${COMMENT_SELECT}
        ${listFilter.whereSql}
        ORDER BY c.created_at DESC, c.public_id DESC
        LIMIT ? OFFSET ?
      `).bind(
        ...listFilter.parameters,
        input.query.per_page,
        offset,
      ).all<CommentRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total
        FROM comments c
        INNER JOIN edge_comment_targets t ON t.id = c.target_id
        ${listFilter.whereSql}
      `).bind(...listFilter.parameters).first<CountRow>(),
      input.edgeDb.prepare(`
        SELECT
          COUNT(*) AS all_count,
          SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END)
            AS pending_count,
          SUM(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END)
            AS approved_count,
          SUM(CASE WHEN c.status = 'spam' THEN 1 ELSE 0 END) AS spam_count,
          SUM(CASE WHEN c.status = 'trash' THEN 1 ELSE 0 END) AS trash_count
        FROM comments c
        INNER JOIN edge_comment_targets t ON t.id = c.target_id
        ${statusFilter.whereSql}
      `).bind(...statusFilter.parameters).first<CountRow>(),
    ]);
    rows = listResult.results ?? [];
    countRow = totalResult;
    statusRow = statusResult;
  } catch (error) {
    throw queryFailure(error, 'list_managed_comments');
  }
  const targets = await loadCommentTargets({ db: input.db, rows });
  const total = parseCount(countRow?.total);
  return {
    items: rows.map((row) => parseComment(row, targets)),
    pagination: {
      page: input.query.page,
      per_page: input.query.per_page,
      total,
      total_pages: Math.ceil(total / input.query.per_page),
    },
    status_counts: {
      all: parseCount(statusRow?.all_count),
      pending: parseCount(statusRow?.pending_count),
      approved: parseCount(statusRow?.approved_count),
      spam: parseCount(statusRow?.spam_count),
      trash: parseCount(statusRow?.trash_count),
    },
  };
}

async function readStudioAuthoringTarget(input: {
  db: D1Database;
  targetType: CommentTargetType;
  targetPublicId: number;
}): Promise<CommentTarget | null> {
  const table = input.targetType === 'post' ? 'posts' : 'pages';
  let row: TargetRow | null;
  try {
    row = await input.db.prepare(`
      SELECT id, public_id, title, slug, status, allow_comments
      FROM ${table}
      WHERE public_id = ?
      LIMIT 1
    `).bind(input.targetPublicId).first<TargetRow>();
  } catch (error) {
    throw queryFailure(error, 'read_comment_authoring_target', 'DB');
  }
  if (!row) return null;
  const parsed = commentTargetSchema.safeParse({
    type: input.targetType,
    id: row.id,
    public_id: Number(row.public_id),
    title: row.title,
    slug: row.slug,
  });
  if (
    !parsed.success
    || !['draft', 'published', 'trash'].includes(String(row.status))
    || ![0, 1].includes(Number(row.allow_comments))
  ) throw dataInvalid(parsed.success ? undefined : parsed.error, 'DB');
  return row.status === 'published' && Number(row.allow_comments) === 1
    ? parsed.data
    : null;
}

async function readCreateTarget(input: {
  edgeDb: D1Database;
  targetType: CommentTargetType;
  targetPublicId: number;
}): Promise<{
  id: number;
  threadingEnabled: boolean;
  maxDepth: number;
} | null> {
  let row: CreateTargetRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT
        target.id,
        target.status,
        target.allow_comments,
        settings.thread_comments,
        settings.thread_comments_depth
      FROM edge_comment_targets target
      LEFT JOIN edge_comment_settings settings ON settings.id = 1
      WHERE target.target_type = ? AND target.public_id = ?
      LIMIT 1
    `).bind(
      input.targetType,
      input.targetPublicId,
    ).first<CreateTargetRow>();
  } catch (error) {
    throw queryFailure(error, 'read_comment_authoring_target');
  }
  if (!row) return null;
  const id = Number(row.id);
  const allowComments = Number(row.allow_comments);
  const threading = Number(row.thread_comments);
  const maxDepth = Number(row.thread_comments_depth);
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || typeof row.status !== 'string'
    || ![0, 1].includes(allowComments)
    || ![0, 1].includes(threading)
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 2
    || maxDepth > 10
  ) throw dataInvalid();
  if (row.status !== 'published' || allowComments !== 1) return null;
  return {
    id,
    threadingEnabled: threading === 1,
    maxDepth,
  };
}

async function resolveStudioReplyParent(input: {
  edgeDb: D1Database;
  targetId: number;
  parentPublicId: number;
  threadingEnabled: boolean;
  maxDepth: number;
}): Promise<{
  publicId: number;
  rawUpdatedAt: string;
} | null> {
  if (!input.threadingEnabled) return null;
  let current: ParentRow | null;
  try {
    current = await input.edgeDb.prepare(`
      SELECT public_id, parent_public_id, status, updated_at
      FROM comments
      WHERE public_id = ? AND target_id = ?
      LIMIT 1
    `).bind(
      input.parentPublicId,
      input.targetId,
    ).first<ParentRow>();
  } catch (error) {
    throw queryFailure(error, 'resolve_comment_reply_parent');
  }
  if (!current || current.status !== 'approved') return null;
  const parentUpdatedAt = current.updated_at;
  if (typeof parentUpdatedAt !== 'string' || !Number.isFinite(
    Date.parse(normalizeTimestamp(parentUpdatedAt)),
  )) throw dataInvalid();

  const seen = new Set<number>();
  let depth = 1;
  while (current) {
    const publicId = Number(current.public_id);
    const parentPublicId: number | null = current.parent_public_id === null
      ? null
      : Number(current.parent_public_id);
    if (
      !Number.isSafeInteger(publicId)
      || publicId <= 0
      || (parentPublicId !== null && (
        !Number.isSafeInteger(parentPublicId) || parentPublicId <= 0
      ))
    ) throw dataInvalid();
    if (seen.has(publicId)) return null;
    seen.add(publicId);
    if (parentPublicId === null) {
      return depth >= input.maxDepth
        ? null
        : { publicId: input.parentPublicId, rawUpdatedAt: parentUpdatedAt };
    }
    if (depth >= 10) return null;
    try {
      current = await input.edgeDb.prepare(`
        SELECT public_id, parent_public_id, status, updated_at
        FROM comments
        WHERE public_id = ? AND target_id = ? AND status = 'approved'
        LIMIT 1
      `).bind(parentPublicId, input.targetId).first<ParentRow>();
    } catch (error) {
      throw queryFailure(error, 'resolve_comment_reply_parent');
    }
    if (!current) return null;
    depth += 1;
  }
  return null;
}

export async function createStudioComment(input: {
  db: D1Database;
  edgeDb: D1Database;
  author: AuthenticatedUser;
  comment: CreateStudioCommentRequest;
  now?: Date;
  createId?: () => string;
}): Promise<CreateStudioCommentResult> {
  const [target, studioTarget] = await Promise.all([
    readCreateTarget({
      edgeDb: input.edgeDb,
      targetType: input.comment.target_type,
      targetPublicId: input.comment.target_public_id,
    }),
    readStudioAuthoringTarget({
      db: input.db,
      targetType: input.comment.target_type,
      targetPublicId: input.comment.target_public_id,
    }),
  ]);
  if (!target || !studioTarget) return { kind: 'target_not_available' };

  const parent = input.comment.parent_public_id === null
    ? null
    : await resolveStudioReplyParent({
        edgeDb: input.edgeDb,
        targetId: target.id,
        parentPublicId: input.comment.parent_public_id,
        threadingEnabled: target.threadingEnabled,
        maxDepth: target.maxDepth,
      });
  if (input.comment.parent_public_id !== null && !parent) {
    return { kind: 'reply_not_available' };
  }

  const id = (input.createId ?? createOpaqueId)();
  if (!/^[0-9a-f]{32}$/u.test(id)) {
    throw new TypeError('Studio comment ID must be 32 lowercase hex characters.');
  }
  const createdAt = formatIsoUtcSeconds(input.now ?? new Date());
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(`
        INSERT INTO comments (
          id,
          public_id,
          target_id,
          parent_public_id,
          author_name,
          author_email,
          content,
          status,
          imported,
          ip_address,
          ip_address_recorded_at,
          ip_hash,
          user_agent,
          asn,
          as_organization,
          country_code,
          created_at,
          updated_at,
          author_user_id,
          author_kind,
          author_identity_issuer
        )
        SELECT
          ?,
          (
            SELECT COALESCE(MAX(public_id), ?) + 1
            FROM comments
            WHERE public_id >= ?
          ),
          target.id,
          ?,
          ?,
          ?,
          ?,
          'approved',
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ?,
          ?,
          ?,
          'site_user',
          'zeropress:studio'
        FROM edge_comment_targets target
        WHERE target.id = ?
          AND target.target_type = ?
          AND target.public_id = ?
          AND target.status = 'published'
          AND target.allow_comments = 1
          AND (
            ? IS NULL
            OR EXISTS (
              SELECT 1
              FROM comments parent
              WHERE parent.public_id = ?
                AND parent.target_id = target.id
                AND parent.status = 'approved'
                AND parent.updated_at = ?
            )
          )
      `).bind(
        id,
        ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
        ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
        input.comment.parent_public_id,
        input.author.name,
        input.author.email,
        input.comment.content_text,
        createdAt,
        createdAt,
        input.author.id,
        target.id,
        input.comment.target_type,
        input.comment.target_public_id,
        input.comment.parent_public_id,
        input.comment.parent_public_id,
        parent?.rawUpdatedAt ?? null,
      ),
      input.edgeDb.prepare(`
        UPDATE edge_comment_targets
        SET comments_cache_revision = lower(hex(randomblob(16)))
        WHERE id = ?
          AND EXISTS (
            SELECT 1
            FROM comments
            WHERE id = ? AND target_id = ?
          )
      `).bind(target.id, id, target.id),
    ]);
  } catch (error) {
    throw writeFailure(error, 'create_studio_comment');
  }
  if (readChanges(results[0]) !== 1) return { kind: 'state_conflict' };
  if (readChanges(results[1]) !== 1) {
    throw dataInvalid(new TypeError('Comment cache revision was not rotated.'));
  }
  const comment = await readManagedComment({
    db: input.db,
    edgeDb: input.edgeDb,
    id,
  });
  if (!comment) throw dataInvalid();
  return { kind: 'completed', comment };
}

async function readCommentIdentity(input: {
  edgeDb: D1Database;
  id: string;
}): Promise<CommentIdentityRow | null> {
  try {
    return await input.edgeDb.prepare(`
      SELECT id, target_id, public_id, content, status, updated_at
      FROM comments
      WHERE id = ?
      LIMIT 1
    `).bind(input.id).first<CommentIdentityRow>();
  } catch (error) {
    throw queryFailure(error, 'read_comment_mutation_identity');
  }
}

function parseIdentity(row: CommentIdentityRow) {
  const targetId = Number(row.target_id);
  const publicId = Number(row.public_id);
  const status = row.status;
  const content = row.content;
  if (
    !Number.isSafeInteger(targetId)
    || targetId <= 0
    || !Number.isSafeInteger(publicId)
    || publicId <= 0
    || typeof content !== 'string'
    || content.length === 0
    || content.length > 5_000
    || !['pending', 'approved', 'spam', 'trash'].includes(String(status))
    || typeof row.updated_at !== 'string'
  ) throw dataInvalid();
  return {
    targetId,
    publicId,
    content,
    status: status as CommentStatus,
    rawUpdatedAt: row.updated_at,
    updatedAtIso: normalizeTimestamp(row.updated_at),
  };
}

export async function updateManagedComment(input: {
  db: D1Database;
  edgeDb: D1Database;
  id: string;
  update: UpdateCommentRequest;
  now?: Date;
}): Promise<UpdateManagedCommentResult> {
  const row = await readCommentIdentity(input);
  if (!row) return { kind: 'not_found' };
  const current = parseIdentity(row);
  if (current.updatedAtIso !== input.update.expected_updated_at_iso) {
    return { kind: 'revision_conflict' };
  }
  const nextUpdatedAt = nextTimestamp(input.now ?? new Date(), current.updatedAtIso);
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(`
        UPDATE comments
        SET content = ?, status = ?, updated_at = ?
        WHERE id = ? AND target_id = ? AND updated_at = ?
      `).bind(
        input.update.content_text ?? current.content,
        input.update.status ?? current.status,
        nextUpdatedAt,
        input.id,
        current.targetId,
        current.rawUpdatedAt,
      ),
      input.edgeDb.prepare(`
        UPDATE edge_comment_targets
        SET comments_cache_revision = lower(hex(randomblob(16)))
        WHERE id = ?
          AND EXISTS (
            SELECT 1 FROM comments
            WHERE id = ? AND target_id = ? AND updated_at = ?
          )
      `).bind(
        current.targetId,
        input.id,
        current.targetId,
        nextUpdatedAt,
      ),
    ]);
  } catch (error) {
    throw writeFailure(error, 'update_managed_comment');
  }
  if (readChanges(results[0]) !== 1) return { kind: 'revision_conflict' };
  if (readChanges(results[1]) !== 1) {
    throw dataInvalid(new TypeError('Comment cache revision was not rotated.'));
  }
  const comment = await readManagedComment(input);
  if (!comment) throw dataInvalid();
  return { kind: 'completed', comment };
}

async function readCommentIdentityMap(input: {
  edgeDb: D1Database;
  ids: string[];
}): Promise<Map<string, ReturnType<typeof parseIdentity>>> {
  if (input.ids.length === 0) return new Map();
  let rows: CommentIdentityRow[];
  try {
    const result = await input.edgeDb.prepare(`
      SELECT id, target_id, public_id, content, status, updated_at
      FROM comments
      WHERE id IN (${input.ids.map(() => '?').join(', ')})
    `).bind(...input.ids).all<CommentIdentityRow>();
    rows = result.results ?? [];
  } catch (error) {
    throw queryFailure(error, 'read_comment_bulk_mutation_identities');
  }
  const requested = new Set(input.ids);
  const identities = new Map<string, ReturnType<typeof parseIdentity>>();
  for (const row of rows) {
    if (
      typeof row.id !== 'string'
      || !requested.has(row.id)
      || identities.has(row.id)
    ) throw dataInvalid();
    identities.set(row.id, parseIdentity(row));
  }
  return identities;
}

function summarizeBulkModeration(
  results: CommentBulkModerationResult[],
): CommentBulkModerationData['summary'] {
  const summary = {
    requested: results.length,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    skipped: 0,
    deleted_comments: 0,
  };
  for (const result of results) {
    summary[result.outcome] += 1;
    if ('deleted_count' in result) {
      summary.deleted_comments += result.deleted_count;
    }
  }
  return summary;
}

async function bulkSetCommentStatus(input: {
  edgeDb: D1Database;
  request: Extract<
    CommentBulkModerationRequest,
    { operation: 'set_status' }
  >;
  now: Date;
}): Promise<CommentBulkModerationData> {
  const identities = await readCommentIdentityMap({
    edgeDb: input.edgeDb,
    ids: input.request.items.map((item) => item.id),
  });
  const results: Array<CommentBulkModerationResult | undefined> =
    Array.from({ length: input.request.items.length });
  const candidates: Array<{
    index: number;
    id: string;
    targetId: number;
    rawUpdatedAt: string;
    nextUpdatedAt: string;
  }> = [];
  for (const [index, item] of input.request.items.entries()) {
    const current = identities.get(item.id);
    if (!current) {
      results[index] = {
        id: item.id,
        outcome: 'skipped',
        reason: 'not_found',
      };
    } else if (current.status === input.request.status) {
      results[index] = {
        id: item.id,
        outcome: 'unchanged',
        status: current.status,
        updated_at_iso: current.updatedAtIso,
      };
    } else if (current.updatedAtIso !== item.expected_updated_at_iso) {
      results[index] = { id: item.id, outcome: 'conflict' };
    } else {
      candidates.push({
        index,
        id: item.id,
        targetId: current.targetId,
        rawUpdatedAt: current.rawUpdatedAt,
        nextUpdatedAt: nextTimestamp(input.now, current.updatedAtIso),
      });
    }
  }

  if (candidates.length > 0) {
    const targetIds = [...new Set(candidates.map((item) => item.targetId))];
    let batchResults: D1Result<unknown>[];
    try {
      batchResults = await input.edgeDb.batch([
        ...candidates.map((candidate) => input.edgeDb.prepare(`
          UPDATE comments
          SET status = ?, updated_at = ?
          WHERE id = ? AND target_id = ? AND updated_at = ?
        `).bind(
          input.request.status,
          candidate.nextUpdatedAt,
          candidate.id,
          candidate.targetId,
          candidate.rawUpdatedAt,
        )),
        ...targetIds.map((targetId) => input.edgeDb.prepare(`
          UPDATE edge_comment_targets
          SET comments_cache_revision = lower(hex(randomblob(16)))
          WHERE id = ?
        `).bind(targetId)),
      ]);
    } catch (error) {
      throw writeFailure(error, 'bulk_moderate_comment_status');
    }

    const changedByTarget = new Set<number>();
    const unresolvedIds: string[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (readChanges(batchResults[candidateIndex]) === 1) {
        changedByTarget.add(candidate.targetId);
        results[candidate.index] = {
          id: candidate.id,
          outcome: 'updated',
          status: input.request.status,
          updated_at_iso: candidate.nextUpdatedAt,
        };
      } else {
        unresolvedIds.push(candidate.id);
      }
    }
    for (const [targetIndex, targetId] of targetIds.entries()) {
      if (
        changedByTarget.has(targetId)
        && readChanges(batchResults[candidates.length + targetIndex]) !== 1
      ) {
        throw dataInvalid(new TypeError(
          'Comment cache revision was not rotated for bulk moderation.',
        ));
      }
    }
    const latest = await readCommentIdentityMap({
      edgeDb: input.edgeDb,
      ids: unresolvedIds,
    });
    for (const candidate of candidates) {
      if (results[candidate.index]) continue;
      const current = latest.get(candidate.id);
      results[candidate.index] = !current
        ? { id: candidate.id, outcome: 'skipped', reason: 'not_found' }
        : current.status === input.request.status
          ? {
              id: candidate.id,
              outcome: 'unchanged',
              status: current.status,
              updated_at_iso: current.updatedAtIso,
            }
          : { id: candidate.id, outcome: 'conflict' };
    }
  }

  const completed = results.map((result) => {
    if (!result) throw dataInvalid();
    return result;
  });
  return {
    operation: 'set_status',
    status: input.request.status,
    results: completed,
    summary: summarizeBulkModeration(completed),
  };
}

async function bulkDeleteCommentsPermanently(input: {
  edgeDb: D1Database;
  request: Extract<
    CommentBulkModerationRequest,
    { operation: 'delete_permanently' }
  >;
}): Promise<CommentBulkModerationData> {
  const identities = await readCommentIdentityMap({
    edgeDb: input.edgeDb,
    ids: input.request.items.map((item) => item.id),
  });
  const results: Array<CommentBulkModerationResult | undefined> =
    Array.from({ length: input.request.items.length });
  const candidates: Array<{
    index: number;
    id: string;
    targetId: number;
    rawUpdatedAt: string;
  }> = [];
  for (const [index, item] of input.request.items.entries()) {
    const current = identities.get(item.id);
    if (!current) {
      results[index] = {
        id: item.id,
        outcome: 'skipped',
        reason: 'not_found',
      };
    } else if (current.status !== 'trash') {
      results[index] = {
        id: item.id,
        outcome: 'skipped',
        reason: 'not_in_trash',
      };
    } else if (current.updatedAtIso !== item.expected_updated_at_iso) {
      results[index] = { id: item.id, outcome: 'conflict' };
    } else {
      candidates.push({
        index,
        id: item.id,
        targetId: current.targetId,
        rawUpdatedAt: current.rawUpdatedAt,
      });
    }
  }

  if (candidates.length > 0) {
    const targetIds = [...new Set(candidates.map((item) => item.targetId))];
    let batchResults: D1Result<unknown>[];
    try {
      batchResults = await input.edgeDb.batch([
        ...candidates.map((candidate) => input.edgeDb.prepare(`
          WITH RECURSIVE descendants(public_id) AS (
            SELECT public_id
            FROM comments
            WHERE id = ? AND target_id = ? AND updated_at = ?
            UNION
            SELECT child.public_id
            FROM comments child
            INNER JOIN descendants parent
              ON child.parent_public_id = parent.public_id
            WHERE child.target_id = ?
          )
          DELETE FROM comments
          WHERE target_id = ?
            AND public_id IN (SELECT public_id FROM descendants)
        `).bind(
          candidate.id,
          candidate.targetId,
          candidate.rawUpdatedAt,
          candidate.targetId,
          candidate.targetId,
        )),
        ...targetIds.map((targetId) => input.edgeDb.prepare(`
          UPDATE edge_comment_targets
          SET comments_cache_revision = lower(hex(randomblob(16)))
          WHERE id = ?
        `).bind(targetId)),
      ]);
    } catch (error) {
      throw writeFailure(error, 'bulk_permanently_delete_comment_subtrees');
    }

    const changedByTarget = new Set<number>();
    const unresolvedIds: string[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const deletedCount = readChanges(batchResults[candidateIndex]);
      if (deletedCount > 0) {
        changedByTarget.add(candidate.targetId);
        results[candidate.index] = {
          id: candidate.id,
          outcome: 'updated',
          deleted_count: deletedCount,
        };
      } else {
        unresolvedIds.push(candidate.id);
      }
    }
    for (const [targetIndex, targetId] of targetIds.entries()) {
      if (
        changedByTarget.has(targetId)
        && readChanges(batchResults[candidates.length + targetIndex]) !== 1
      ) {
        throw dataInvalid(new TypeError(
          'Comment cache revision was not rotated for bulk deletion.',
        ));
      }
    }
    const latest = await readCommentIdentityMap({
      edgeDb: input.edgeDb,
      ids: unresolvedIds,
    });
    for (const candidate of candidates) {
      if (results[candidate.index]) continue;
      results[candidate.index] = latest.has(candidate.id)
        ? { id: candidate.id, outcome: 'conflict' }
        : { id: candidate.id, outcome: 'skipped', reason: 'not_found' };
    }
  }

  const completed = results.map((result) => {
    if (!result) throw dataInvalid();
    return result;
  });
  return {
    operation: 'delete_permanently',
    results: completed,
    summary: summarizeBulkModeration(completed),
  };
}

export async function bulkModerateManagedComments(input: {
  edgeDb: D1Database;
  request: CommentBulkModerationRequest;
  now?: Date;
}): Promise<CommentBulkModerationData> {
  return input.request.operation === 'set_status'
    ? bulkSetCommentStatus({
        edgeDb: input.edgeDb,
        request: input.request,
        now: input.now ?? new Date(),
      })
    : bulkDeleteCommentsPermanently({
        edgeDb: input.edgeDb,
        request: input.request,
      });
}

export async function deleteManagedComment(input: {
  db: D1Database;
  edgeDb: D1Database;
  id: string;
  expectedUpdatedAtIso: string;
  now?: Date;
}): Promise<DeleteManagedCommentResult> {
  const row = await readCommentIdentity(input);
  if (!row) return { kind: 'not_found' };
  const current = parseIdentity(row);
  if (current.updatedAtIso !== input.expectedUpdatedAtIso) {
    return { kind: 'revision_conflict' };
  }
  if (current.status !== 'trash') {
    const result = await updateManagedComment({
      ...input,
      update: {
        status: 'trash',
        expected_updated_at_iso: input.expectedUpdatedAtIso,
      },
    });
    if (result.kind !== 'completed') return result;
    return { kind: 'moved_to_trash', comment: result.comment };
  }

  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(`
        WITH RECURSIVE descendants(public_id) AS (
          SELECT public_id
          FROM comments
          WHERE id = ? AND target_id = ? AND updated_at = ?
          UNION
          SELECT child.public_id
          FROM comments child
          INNER JOIN descendants parent
            ON child.parent_public_id = parent.public_id
          WHERE child.target_id = ?
        )
        DELETE FROM comments
        WHERE target_id = ?
          AND public_id IN (SELECT public_id FROM descendants)
      `).bind(
        input.id,
        current.targetId,
        current.rawUpdatedAt,
        current.targetId,
        current.targetId,
      ),
      input.edgeDb.prepare(`
        UPDATE edge_comment_targets
        SET comments_cache_revision = lower(hex(randomblob(16)))
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM comments WHERE id = ?)
      `).bind(current.targetId, input.id),
    ]);
  } catch (error) {
    throw writeFailure(error, 'permanently_delete_comment_subtree');
  }
  const deletedCount = readChanges(results[0]);
  if (deletedCount === 0) return { kind: 'revision_conflict' };
  if (readChanges(results[1]) !== 1) {
    throw dataInvalid(new TypeError('Comment cache revision was not rotated.'));
  }
  return { kind: 'permanently_deleted', deletedCount };
}
