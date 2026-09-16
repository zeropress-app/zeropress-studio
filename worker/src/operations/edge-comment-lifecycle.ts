import { COMMENT_SETTINGS_DEFAULTS } from '../../../contracts/comment-settings';
import { StudioOperationalError } from '../lib/operational-error';

export const EDGE_COMMENT_EFFECT_KEYS = {
  comments: 'EDGE_DB.comments',
  targets: 'EDGE_DB.edge_comment_targets',
  settings: 'EDGE_DB.edge_comment_settings',
} as const;

export type EdgeCommentLifecycleResult = {
  deletedRows: Record<string, number>;
  insertedRows: Record<string, number>;
  updatedRows: Record<string, number>;
};

type EdgeCommentCountRow = {
  comment_count?: unknown;
  target_count?: unknown;
};

type EdgeCommentVerificationRow = EdgeCommentCountRow & {
  settings_count?: unknown;
  default_settings_count?: unknown;
};

type EdgeCommentLifecycleAction =
  | 'clear_edge_comment_content'
  | 'reset_edge_comment_runtime';

function lifecycleFailure(input: {
  cause: unknown;
  action: EdgeCommentLifecycleAction;
  phase: 'mutation' | 'verification';
}) {
  return new StudioOperationalError(
    'MAINTENANCE_EDGE_COMMENT_LIFECYCLE_FAILED',
    {
      cause: input.cause,
      metadata: {
        resource: 'EDGE_DB',
        action: input.action,
        phase: input.phase,
      },
    },
  );
}

function parseCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`EDGE_DB returned an invalid ${field}.`);
  }
  return Number(value);
}

function readChanges(result: D1Result<unknown> | undefined): number {
  return parseCount(result?.meta?.changes ?? 0, 'changes count');
}

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Edge comment reset time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

async function runEdgeCommentLifecycle(input: {
  edgeDb: D1Database;
  resetPresentationSettings: boolean;
  now?: Date;
}): Promise<EdgeCommentLifecycleResult> {
  const action: EdgeCommentLifecycleAction = input.resetPresentationSettings
    ? 'reset_edge_comment_runtime'
    : 'clear_edge_comment_content';
  const statements = [
    input.edgeDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM comments) AS comment_count,
        (SELECT COUNT(*) FROM edge_comment_targets) AS target_count
    `),
    // Target deletion also removes comments. A later projection receives a
    // fresh nonce and cache revision, so orphaned KV generations cannot be
    // addressed and may expire under the Edge runtime's normal TTL policy.
    input.edgeDb.prepare('DELETE FROM edge_comment_targets'),
  ];

  if (input.resetPresentationSettings) {
    const defaults = COMMENT_SETTINGS_DEFAULTS;
    statements.push(input.edgeDb.prepare(`
      UPDATE edge_comment_settings
      SET
        api_base_url = NULL,
        comments_enabled = ?,
        require_approval = ?,
        per_page = ?,
        sort_order = ?,
        thread_comments = ?,
        thread_comments_depth = ?,
        updated_at = ?
      WHERE id = 1
        AND (
          api_base_url IS NOT NULL
          OR comments_enabled != ?
          OR require_approval != ?
          OR per_page != ?
          OR sort_order != ?
          OR thread_comments != ?
          OR thread_comments_depth != ?
        )
    `).bind(
      defaults.enabled ? 1 : 0,
      defaults.moderation.require_approval ? 1 : 0,
      defaults.per_page,
      defaults.order,
      defaults.threading.enabled ? 1 : 0,
      defaults.threading.max_depth,
      formatIsoUtcSeconds(input.now ?? new Date()),
      defaults.enabled ? 1 : 0,
      defaults.moderation.require_approval ? 1 : 0,
      defaults.per_page,
      defaults.order,
      defaults.threading.enabled ? 1 : 0,
      defaults.threading.max_depth,
    ));
  }

  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch(statements);
  } catch (error) {
    throw lifecycleFailure({ cause: error, action, phase: 'mutation' });
  }

  let initialComments: number;
  let initialTargets: number;
  try {
    const row = results[0]?.results?.[0] as EdgeCommentCountRow | undefined;
    initialComments = parseCount(row?.comment_count, 'comment count');
    initialTargets = parseCount(row?.target_count, 'target count');
  } catch (error) {
    throw lifecycleFailure({ cause: error, action, phase: 'verification' });
  }

  let verification: EdgeCommentVerificationRow | null;
  try {
    const verificationStatement = input.resetPresentationSettings
      ? input.edgeDb.prepare(`
          SELECT
            (SELECT COUNT(*) FROM comments) AS comment_count,
            (SELECT COUNT(*) FROM edge_comment_targets) AS target_count,
            (SELECT COUNT(*) FROM edge_comment_settings WHERE id = 1)
              AS settings_count,
            (
              SELECT COUNT(*)
              FROM edge_comment_settings
              WHERE id = 1
                AND api_base_url IS NULL
                AND comments_enabled = ?
                AND require_approval = ?
                AND per_page = ?
                AND sort_order = ?
                AND thread_comments = ?
                AND thread_comments_depth = ?
            ) AS default_settings_count
        `).bind(
          COMMENT_SETTINGS_DEFAULTS.enabled ? 1 : 0,
          COMMENT_SETTINGS_DEFAULTS.moderation.require_approval ? 1 : 0,
          COMMENT_SETTINGS_DEFAULTS.per_page,
          COMMENT_SETTINGS_DEFAULTS.order,
          COMMENT_SETTINGS_DEFAULTS.threading.enabled ? 1 : 0,
          COMMENT_SETTINGS_DEFAULTS.threading.max_depth,
        )
      : input.edgeDb.prepare(`
          SELECT
            (SELECT COUNT(*) FROM comments) AS comment_count,
            (SELECT COUNT(*) FROM edge_comment_targets) AS target_count
        `);
    verification = await verificationStatement
      .first<EdgeCommentVerificationRow>();
  } catch (error) {
    throw lifecycleFailure({ cause: error, action, phase: 'verification' });
  }

  try {
    if (
      !verification
      || parseCount(verification.comment_count, 'remaining comment count') !== 0
      || parseCount(verification.target_count, 'remaining target count') !== 0
      || (
        input.resetPresentationSettings
        && (
          parseCount(verification.settings_count, 'settings row count') !== 1
          || parseCount(
            verification.default_settings_count,
            'default settings row count',
          ) !== 1
        )
      )
    ) {
      throw new TypeError('EDGE_DB comment lifecycle verification failed.');
    }
  } catch (error) {
    throw lifecycleFailure({ cause: error, action, phase: 'verification' });
  }

  let settingsChanges = 0;
  try {
    settingsChanges = input.resetPresentationSettings
      ? readChanges(results[2])
      : 0;
  } catch (error) {
    throw lifecycleFailure({ cause: error, action, phase: 'verification' });
  }
  return {
    deletedRows: {
      [EDGE_COMMENT_EFFECT_KEYS.comments]: initialComments,
      [EDGE_COMMENT_EFFECT_KEYS.targets]: initialTargets,
    },
    insertedRows: {},
    updatedRows: settingsChanges > 0
      ? { [EDGE_COMMENT_EFFECT_KEYS.settings]: settingsChanges }
      : {},
  };
}

export function clearEdgeCommentContent(input: {
  edgeDb: D1Database;
}): Promise<EdgeCommentLifecycleResult> {
  return runEdgeCommentLifecycle({
    edgeDb: input.edgeDb,
    resetPresentationSettings: false,
  });
}

export function resetEdgeCommentRuntime(input: {
  edgeDb: D1Database;
  now?: Date;
}): Promise<EdgeCommentLifecycleResult> {
  return runEdgeCommentLifecycle({
    edgeDb: input.edgeDb,
    resetPresentationSettings: true,
    now: input.now,
  });
}
