import {
  areCommentSettingsEqual,
  COMMENT_SETTINGS_DEFAULTS,
  commentSettingsDocumentSchema,
  commentSettingsSchema,
  type CommentSettings,
  type CommentSettingsDocument,
} from '../../../contracts/comment-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createCommentRequestSecrets,
} from '../comments/request-secrets';

type CommentSettingsRow = {
  api_base_url?: unknown;
  comments_enabled?: unknown;
  require_approval?: unknown;
  per_page?: unknown;
  sort_order?: unknown;
  thread_comments?: unknown;
  thread_comments_depth?: unknown;
  request_secrets_json?: unknown;
  auth_enabled?: unknown;
  supabase_project_url?: unknown;
  supabase_publishable_key?: unknown;
  updated_at?: unknown;
};

export type CommentSettingsState = {
  document: CommentSettingsDocument;
  requestSecretsJson: string | null;
};

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = Number(result?.meta?.changes ?? 0);
  return Number.isInteger(changes) && changes >= 0 ? changes : 0;
}

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Comment settings update time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

function parseInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function settingsRevision(settings: CommentSettings): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(settings)),
  );
  return toHex(new Uint8Array(digest).slice(0, 16));
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('COMMENT_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'EDGE_DB',
      action: 'validate_comment_settings',
    },
  });
}

async function materializeCommentSettingsState(
  row: CommentSettingsRow | null,
): Promise<CommentSettingsState> {
  if (!row) {
    const settings = commentSettingsSchema.parse({
      ...COMMENT_SETTINGS_DEFAULTS,
      threading: { ...COMMENT_SETTINGS_DEFAULTS.threading },
      moderation: { ...COMMENT_SETTINGS_DEFAULTS.moderation },
      auth: { ...COMMENT_SETTINGS_DEFAULTS.auth },
    });
    return {
      document: {
        settings,
        revision: await settingsRevision(settings),
        updated_at_iso: null,
      },
      requestSecretsJson: null,
    };
  }

  const enabled = parseBoolean(row.comments_enabled);
  const authEnabled = parseBoolean(row.auth_enabled);
  const requireApproval = parseBoolean(row.require_approval);
  const threadEnabled = parseBoolean(row.thread_comments);
  const perPage = parseInteger(row.per_page);
  const maxDepth = parseInteger(row.thread_comments_depth);
  const requestSecretsJson = row.request_secrets_json === null
    ? null
    : typeof row.request_secrets_json === 'string'
      ? row.request_secrets_json
      : undefined;
  const parsed = commentSettingsSchema.safeParse({
    enabled,
    provider: 'zeropress',
    api_base_url: row.api_base_url,
    per_page: perPage,
    order: row.sort_order,
    threading: {
      enabled: threadEnabled,
      max_depth: maxDepth,
    },
    moderation: {
      require_approval: requireApproval,
    },
    auth: {
      enabled: authEnabled,
      provider: 'supabase',
      project_url: row.supabase_project_url,
      publishable_key: row.supabase_publishable_key,
    },
  });
  if (
    !parsed.success
    || requestSecretsJson === undefined
    || typeof row.updated_at !== 'string'
  ) {
    throw dataInvalid(parsed.success ? undefined : parsed.error);
  }
  const document = commentSettingsDocumentSchema.safeParse({
    settings: parsed.data,
    revision: await settingsRevision(parsed.data),
    updated_at_iso: row.updated_at,
  });
  if (!document.success) throw dataInvalid(document.error);
  return {
    document: document.data,
    requestSecretsJson,
  };
}

export async function readCommentSettingsState(input: {
  edgeDb: D1Database;
}): Promise<CommentSettingsState> {
  let row: CommentSettingsRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT
        api_base_url,
        comments_enabled,
        require_approval,
        per_page,
        sort_order,
        thread_comments,
        thread_comments_depth,
        request_secrets_json,
        auth_enabled,
        supabase_project_url,
        supabase_publishable_key,
        updated_at
      FROM edge_comment_settings
      WHERE id = 1
      LIMIT 1
    `).first<CommentSettingsRow>();
  } catch (error) {
    throw new StudioOperationalError(
      'COMMENT_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'read_comment_settings',
        },
      },
    );
  }
  return materializeCommentSettingsState(row);
}

export async function readCommentSettings(input: {
  edgeDb: D1Database;
}): Promise<CommentSettingsDocument> {
  return (await readCommentSettingsState(input)).document;
}

export async function updateCommentSettings(input: {
  edgeDb: D1Database;
  settings: CommentSettings;
  expectedRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; document: CommentSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  const current = await readCommentSettingsState({ edgeDb: input.edgeDb });
  if (current.document.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict' };
  }
  if (areCommentSettingsEqual(current.document.settings, input.settings)
    && current.requestSecretsJson !== null) {
    return { kind: 'completed', document: current.document };
  }

  const now = input.now ?? new Date();
  const nowIso = formatIsoUtcSeconds(now);
  const requestSecretsJson = current.requestSecretsJson
    ?? JSON.stringify(createCommentRequestSecrets(now));
  let result: D1Result<unknown>;
  try {
    result = await input.edgeDb.prepare(`
      INSERT INTO edge_comment_settings (
        id,
        api_base_url,
        comments_enabled,
        require_approval,
        per_page,
        sort_order,
        thread_comments,
        thread_comments_depth,
        request_secrets_json,
        auth_enabled,
        supabase_project_url,
        supabase_publishable_key,
        updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        api_base_url = excluded.api_base_url,
        comments_enabled = excluded.comments_enabled,
        require_approval = excluded.require_approval,
        per_page = excluded.per_page,
        sort_order = excluded.sort_order,
        thread_comments = excluded.thread_comments,
        thread_comments_depth = excluded.thread_comments_depth,
        request_secrets_json = excluded.request_secrets_json,
        auth_enabled = excluded.auth_enabled,
        supabase_project_url = excluded.supabase_project_url,
        supabase_publishable_key = excluded.supabase_publishable_key,
        updated_at = excluded.updated_at
      WHERE edge_comment_settings.api_base_url IS ?
        AND edge_comment_settings.comments_enabled = ?
        AND edge_comment_settings.require_approval = ?
        AND edge_comment_settings.per_page = ?
        AND edge_comment_settings.sort_order = ?
        AND edge_comment_settings.thread_comments = ?
        AND edge_comment_settings.thread_comments_depth = ?
        AND edge_comment_settings.request_secrets_json IS ?
        AND edge_comment_settings.auth_enabled = ?
        AND edge_comment_settings.supabase_project_url IS ?
        AND edge_comment_settings.supabase_publishable_key IS ?
    `).bind(
      input.settings.api_base_url,
      input.settings.enabled ? 1 : 0,
      input.settings.moderation.require_approval ? 1 : 0,
      input.settings.per_page,
      input.settings.order,
      input.settings.threading.enabled ? 1 : 0,
      input.settings.threading.max_depth,
      requestSecretsJson,
      input.settings.auth.enabled ? 1 : 0,
      input.settings.auth.project_url,
      input.settings.auth.publishable_key,
      nowIso,
      current.document.settings.api_base_url,
      current.document.settings.enabled ? 1 : 0,
      current.document.settings.moderation.require_approval ? 1 : 0,
      current.document.settings.per_page,
      current.document.settings.order,
      current.document.settings.threading.enabled ? 1 : 0,
      current.document.settings.threading.max_depth,
      current.requestSecretsJson,
      current.document.settings.auth.enabled ? 1 : 0,
      current.document.settings.auth.project_url,
      current.document.settings.auth.publishable_key,
    ).run();
  } catch (error) {
    throw new StudioOperationalError(
      'COMMENT_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'update_comment_settings',
        },
      },
    );
  }
  if (readChanges(result) !== 1) return { kind: 'revision_conflict' };
  const next = await readCommentSettingsState({ edgeDb: input.edgeDb });
  if (!areCommentSettingsEqual(next.document.settings, input.settings)) {
    throw dataInvalid();
  }
  return { kind: 'completed', document: next.document };
}
