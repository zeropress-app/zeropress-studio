import {
  commentRequestSecurityResourceSchema,
  type CommentRequestSecurityResource,
} from '../../../contracts/comment-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createCommentRequestSecrets,
  parseCommentRequestSecrets,
  rotateCommentRequestSecrets,
  type CommentRequestSecrets,
} from './request-secrets';

type CommentRequestSecurityRow = {
  request_secrets_json: string | null;
};

type CommentRequestSecurityState = {
  rowExists: boolean;
  rawValue: string | null;
  secrets: CommentRequestSecrets | null;
  resource: CommentRequestSecurityResource;
};

export type CommentRequestSecurityMutationResult =
  | { kind: 'completed'; resource: CommentRequestSecurityResource }
  | { kind: 'not_rotatable' }
  | { kind: 'revision_conflict' };

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = Number(result?.meta?.changes ?? 0);
  return Number.isInteger(changes) && changes >= 0 ? changes : 0;
}

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Comment request security update time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function securityRevision(input: {
  rowExists: boolean;
  rawValue: string | null;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${input.rowExists ? 'row' : 'missing'}\0${input.rawValue ?? 'null'}`,
    ),
  );
  return toHex(new Uint8Array(digest).slice(0, 16));
}

function cryptoFailure(cause: unknown, action: string) {
  return new StudioOperationalError(
    'COMMENT_REQUEST_SECURITY_CRYPTO_FAILED',
    {
      cause,
      metadata: {
        component: 'web_crypto',
        action,
      },
    },
  );
}

async function materializeState(input: {
  rowExists: boolean;
  rawValue: string | null;
  now: Date;
}): Promise<CommentRequestSecurityState> {
  const revision = await securityRevision(input);
  if (input.rawValue === null) {
    return {
      ...input,
      secrets: null,
      resource: commentRequestSecurityResourceSchema.parse({
        status: 'missing',
        revision,
        current_key: null,
        previous_keys: { total_count: 0, active_count: 0 },
      }),
    };
  }

  let secrets: CommentRequestSecrets;
  try {
    secrets = parseCommentRequestSecrets(input.rawValue);
  } catch {
    return {
      ...input,
      secrets: null,
      resource: commentRequestSecurityResourceSchema.parse({
        status: 'invalid',
        revision,
        current_key: null,
        previous_keys: { total_count: 0, active_count: 0 },
      }),
    };
  }

  const nowMs = input.now.getTime();
  const activePreviousKeys = secrets.previous.filter((entry) => (
    entry.expires_at !== undefined
    && new Date(entry.expires_at).getTime() >= nowMs
  )).length;
  return {
    ...input,
    secrets,
    resource: commentRequestSecurityResourceSchema.parse({
      status: 'valid',
      revision,
      current_key: {
        kid: secrets.current.kid,
        created_at_iso: secrets.current.created_at,
      },
      previous_keys: {
        total_count: secrets.previous.length,
        active_count: activePreviousKeys,
      },
    }),
  };
}

async function readState(input: {
  edgeDb: D1Database;
  now: Date;
}): Promise<CommentRequestSecurityState> {
  let row: CommentRequestSecurityRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT request_secrets_json
      FROM edge_comment_settings
      WHERE id = 1
      LIMIT 1
    `).first<CommentRequestSecurityRow>();
  } catch (error) {
    throw new StudioOperationalError(
      'COMMENT_REQUEST_SECURITY_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'read_comment_request_security',
        },
      },
    );
  }

  try {
    return await materializeState({
      rowExists: row !== null,
      rawValue: row?.request_secrets_json ?? null,
      now: input.now,
    });
  } catch (error) {
    throw cryptoFailure(error, 'describe_comment_request_security');
  }
}

export async function readCommentRequestSecurity(input: {
  edgeDb: D1Database;
  now?: Date;
}): Promise<CommentRequestSecurityResource> {
  return (await readState({
    edgeDb: input.edgeDb,
    now: input.now ?? new Date(),
  })).resource;
}

async function writeSecrets(input: {
  edgeDb: D1Database;
  current: CommentRequestSecurityState;
  next: CommentRequestSecrets;
  now: Date;
}): Promise<CommentRequestSecurityMutationResult> {
  const serialized = JSON.stringify(input.next);
  const nowIso = formatIsoUtcSeconds(input.now);
  let result: D1Result<unknown>;
  try {
    result = input.current.rowExists
      ? await input.edgeDb.prepare(`
          UPDATE edge_comment_settings
          SET request_secrets_json = ?, updated_at = ?
          WHERE id = 1 AND request_secrets_json IS ?
        `).bind(
          serialized,
          nowIso,
          input.current.rawValue,
        ).run()
      : await input.edgeDb.prepare(`
          INSERT INTO edge_comment_settings (
            id,
            request_secrets_json,
            updated_at
          ) VALUES (1, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).bind(serialized, nowIso).run();
  } catch (error) {
    throw new StudioOperationalError(
      'COMMENT_REQUEST_SECURITY_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'update_comment_request_security',
        },
      },
    );
  }
  if (readChanges(result) !== 1) return { kind: 'revision_conflict' };

  let resource: CommentRequestSecurityResource;
  try {
    resource = (await materializeState({
      rowExists: true,
      rawValue: serialized,
      now: input.now,
    })).resource;
  } catch (error) {
    throw cryptoFailure(error, 'describe_updated_comment_request_security');
  }
  return { kind: 'completed', resource };
}

export async function rotateStoredCommentRequestSecurity(input: {
  edgeDb: D1Database;
  expectedRevision: string;
  now?: Date;
}): Promise<CommentRequestSecurityMutationResult> {
  const now = input.now ?? new Date();
  const current = await readState({ edgeDb: input.edgeDb, now });
  if (current.resource.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict' };
  }
  if (current.resource.status !== 'valid' || current.secrets === null) {
    return { kind: 'not_rotatable' };
  }

  let next: CommentRequestSecrets;
  try {
    next = rotateCommentRequestSecrets(current.secrets, now);
  } catch (error) {
    throw cryptoFailure(error, 'rotate_comment_request_security');
  }
  return writeSecrets({ edgeDb: input.edgeDb, current, next, now });
}

export async function resetStoredCommentRequestSecurity(input: {
  edgeDb: D1Database;
  expectedRevision: string;
  now?: Date;
}): Promise<CommentRequestSecurityMutationResult> {
  const now = input.now ?? new Date();
  const current = await readState({ edgeDb: input.edgeDb, now });
  if (current.resource.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict' };
  }

  let next: CommentRequestSecrets;
  try {
    next = createCommentRequestSecrets(now);
  } catch (error) {
    throw cryptoFailure(error, 'reset_comment_request_security');
  }
  return writeSecrets({ edgeDb: input.edgeDb, current, next, now });
}
