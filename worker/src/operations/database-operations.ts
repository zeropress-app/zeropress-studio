import uninstallSql from '../../../database/operations/001_uninstall.sql?raw';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';
import { splitSqlStatements } from '../../../contracts/sql-statements';
import { inspectDatabaseStatus } from '../system/database-status';
import { createSettingsRevision } from '../settings/revisioned-settings-repository';

export type DatabaseOperationResult = {
  deletedRows: Record<string, number>;
  insertedRows: Record<string, number>;
  updatedRows: Record<string, number>;
};

export type UninstallStudioInspection = {
  deletedRows: Record<string, number>;
};

export type ResetStudioInput = {
  db: D1Database;
  administratorId: string;
  now?: Date;
};

export type ClearSiteContentInput = ResetStudioInput & {
  createRevision?: () => string;
};

const INTERNAL_D1_TABLES = new Set([
  '_cf_KV',
  '_cf_METADATA',
]);

// Full-row content tables are listed explicitly and in dependency-safe delete
// order. Widget tables and system configuration are intentionally absent.
// Absent tables from older supported schemas are skipped.
// Edge comments are deliberately absent: their lifecycle is coordinated
// against EDGE_DB before this Studio-owned D1 operation begins.
export const CLEAR_SITE_CONTENT_TABLES = [
  'build_errors',
  'build_steps',
  'build_logs',
  'analytics_sync_runs',
  'analytics_intraday_rollups',
  'analytics_daily_rollups',
  'content_daily_views',
  'post_tags',
  'post_categories',
  'post_autosaves',
  'page_autosaves',
  'post_revisions',
  'page_revisions',
  'media_upload_intents',
  'posts',
  'pages',
  'authors',
  'categories',
  'tags',
  'site_assets',
  'media',
  'media_collections',
  'menus',
  // Keep this last: deleting Post/Page rows while integration is enabled
  // creates durable delete events, which Clear/Reset must also empty after
  // the coordinated Edge-first phase has completed. This internal transport
  // table is cleared but intentionally omitted from operator-facing effects.
  'edge_comment_target_projection_outbox',
] as const;

const OPERATOR_HIDDEN_EFFECT_TABLES = new Set<string>([
  'edge_comment_target_projection_outbox',
  'auth_rate_limits',
]);

// Full Studio reset removes widget configuration as well. Clear-content keeps
// it by design so repeated WXR QA can reuse a hand-authored sidebar.
export const RESET_STUDIO_ADDITIONAL_TABLES = [
  'auth_rate_limits',
  'widget_areas',
  'site_custom_code',
] as const;

const TABLE_LIST_SQL = `
  SELECT name, sql
  FROM sqlite_schema
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`;

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new TypeError('Unsafe Studio database identifier.');
  }
  return `"${identifier}"`;
}

async function listApplicationTables(db: D1Database): Promise<string[]> {
  const result = await db.prepare(TABLE_LIST_SQL).all<{ name: unknown; sql?: unknown }>();
  if (!Array.isArray(result.results)) {
    throw new TypeError('D1 returned an invalid table-list result.');
  }

  // SQLite owns these FTS5 shadow tables and drops them with the reviewed
  // virtual table. A similarly named ordinary table must not be hidden.
  const managedShadowTables = new Set(result.results.flatMap((row) => {
    if (
      (row.name !== 'post_search_fts' && row.name !== 'page_search_fts')
      || typeof row.sql !== 'string'
      || !/^CREATE\s+VIRTUAL\s+TABLE\s+"?(?:post|page)_search_fts"?\s+USING\s+fts5\b/iu.test(row.sql)
    ) return [];
    return ['config', 'content', 'data', 'docsize', 'idx']
      .map((suffix) => `${row.name}_${suffix}`);
  }));
  const names: string[] = [];
  for (const row of result.results) {
    if (typeof row.name !== 'string') {
      throw new TypeError('D1 returned an invalid table name.');
    }
    if (!INTERNAL_D1_TABLES.has(row.name) && !managedShadowTables.has(row.name)) {
      names.push(row.name);
    }
  }
  return names;
}

function deletionStatementsForTables(
  db: D1Database,
  existingTables: Set<string>,
  tables: readonly string[],
): Array<{ table: string; statement: D1PreparedStatement }> {
  return tables
    .filter((table) => existingTables.has(table))
    .map((table) => ({
      table,
      statement: db.prepare(`DELETE FROM ${quotedIdentifier(table)}`),
    }));
}

function queueR2MediaObjectDeletionsStatement(input: {
  db: D1Database;
  existingTables: Set<string>;
  nowIso: string;
}): D1PreparedStatement | null {
  if (
    !input.existingTables.has('media')
    || !input.existingTables.has('media_object_deletions')
  ) return null;
  return input.db.prepare(`
    INSERT OR IGNORE INTO media_object_deletions (
      storage_key, attempt_count, created_at_iso, last_attempt_at_iso
    )
    SELECT storage_key, 0, ?, NULL
    FROM media
    WHERE storage_type = 'r2'
      AND (
        substr(storage_key, 1, 8) = 'uploads/'
        OR substr(storage_key, 1, 9) = 'imported/'
      )
  `).bind(input.nowIso);
}

function resetSelectedFrontPageStatements(
  input: ClearSiteContentInput,
): D1PreparedStatement[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextRevision = (input.createRevision ?? createSettingsRevision)();
  const defaultFrontPage = JSON.stringify(
    materializeRoutingSettingsDefaults().front_page,
  );
  const revisionGuard = `EXISTS (
    SELECT 1
    FROM site_settings AS routing_revision
    WHERE routing_revision.key = 'site_routing_revision'
      AND routing_revision.type = 'string'
      AND routing_revision.value = ?
  )`;

  // Clear Content preserves URL policy, but a selected Page cannot survive
  // deleting every Page. Advance the whole revision document in the same D1
  // batch so readers never observe a dangling Front Page reference or mixed
  // revision timestamps.
  const revision = input.db.prepare(`
    UPDATE site_settings
    SET value = ?, updated_by = ?, updated_at_iso = ?
    WHERE key = 'site_routing_revision'
      AND type = 'string'
      AND EXISTS (
        SELECT 1 FROM site_settings
        WHERE key = 'site_permalinks' AND type = 'json'
      )
      AND EXISTS (
        SELECT 1 FROM site_settings
        WHERE key = 'site_post_index' AND type = 'json'
      )
      AND EXISTS (
        SELECT 1 FROM site_settings
        WHERE key = 'site_front_page'
          AND type = 'json'
          AND substr(value, 1, 26) = '{"type":"page","page_id":"'
          AND substr(value, -2) = '"}'
      )
  `).bind(nextRevision, input.administratorId, nowIso);

  const touchSetting = (key: string, value?: string) => input.db.prepare(`
    UPDATE site_settings
    SET
      ${value === undefined ? '' : 'value = ?,'}
      updated_by = ?,
      updated_at_iso = ?
    WHERE key = ?
      AND type = 'json'
      AND ${revisionGuard}
  `).bind(
    ...(value === undefined ? [] : [value]),
    input.administratorId,
    nowIso,
    key,
    nextRevision,
  );

  return [
    revision,
    touchSetting('site_permalinks'),
    touchSetting('site_front_page', defaultFrontPage),
    touchSetting('site_post_index'),
  ];
}

function resetSiteBrandingRevisionStatement(
  input: ClearSiteContentInput,
): D1PreparedStatement {
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextRevision = (input.createRevision ?? createSettingsRevision)();

  // Branding selections are content references. Clear Content deletes them
  // before deleting Media, so advance the independent document revision in
  // the same batch whenever the operation actually changes that document.
  return input.db.prepare(`
    UPDATE site_settings
    SET value = ?, updated_by = ?, updated_at_iso = ?
    WHERE key = 'site_branding_revision'
      AND type = 'string'
      AND EXISTS (SELECT 1 FROM site_assets)
  `).bind(nextRevision, input.administratorId, nowIso);
}

function directChangesStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT changes() AS direct_changes');
}

function readDirectChanges(result: D1Result<unknown> | undefined): number {
  const row = result?.results?.[0] as {
    direct_changes?: unknown;
  } | undefined;
  if (
    typeof row?.direct_changes !== 'number'
    || !Number.isFinite(row.direct_changes)
    || row.direct_changes < 0
  ) {
    throw new TypeError('D1 returned an invalid direct-change count.');
  }
  return Math.trunc(row.direct_changes);
}

async function executeCountedMutationBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<number[]> {
  // D1 meta.changes includes trigger and FTS5 shadow-table work. Pair each
  // mutation with SQLite changes() inside the same atomic batch so the report
  // reflects rows changed directly by the immediately preceding statement.
  const results = await db.batch([
    deferForeignKeysStatement(db),
    ...statements.flatMap((statement) => [
      statement,
      directChangesStatement(db),
    ]),
  ]);
  return statements.map((_statement, index) => (
    readDirectChanges(results[2 + (index * 2)])
  ));
}

function deferForeignKeysStatement(db: D1Database): D1PreparedStatement {
  // Page hierarchy intentionally uses a self-referencing ON DELETE RESTRICT
  // constraint. Clear/Reset removes the complete hierarchy in one atomic D1
  // batch, so the constraint must be checked at commit, after every Page row
  // in the hierarchy has been removed.
  return db.prepare('PRAGMA defer_foreign_keys = TRUE');
}

function resetContentSearchIndexStateStatement(input: {
  db: D1Database;
  existingTables: Set<string>;
  nowIso: string;
}): D1PreparedStatement | null {
  if (!input.existingTables.has('content_search_index_state')) return null;
  return input.db.prepare(`
    UPDATE content_search_index_state
    SET state = 'ready',
        reason = NULL,
        phase = NULL,
        operation_id = NULL,
        post_public_id_cursor = 0,
        page_public_id_cursor = 0,
        processed_posts = 0,
        processed_pages = 0,
        total_posts = 0,
        total_pages = 0,
        started_at_iso = NULL,
        initiated_by_user_id = NULL,
        initiated_by_user_email = NULL,
        updated_at_iso = ?
    WHERE id = 1
  `).bind(input.nowIso);
}

async function verifyTablesAreEmpty(
  db: D1Database,
  tables: readonly string[],
): Promise<void> {
  if (tables.length === 0) return;

  const results = await db.batch(
    tables.map((table) => db.prepare(
      `SELECT COUNT(*) AS row_count FROM ${quotedIdentifier(table)}`,
    )),
  );
  for (const [index, result] of results.entries()) {
    const row = result.results?.[0] as { row_count?: unknown } | undefined;
    if (typeof row?.row_count !== 'number' || row.row_count !== 0) {
      throw new Error(
        `Studio content table verification failed at index ${index}.`,
      );
    }
  }
}

export async function clearSiteContent(
  input: ClearSiteContentInput,
): Promise<DatabaseOperationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const existingTables = new Set(await listApplicationTables(input.db));
  const deletions = deletionStatementsForTables(
    input.db,
    existingTables,
    CLEAR_SITE_CONTENT_TABLES,
  );
  const routingResets = resetSelectedFrontPageStatements(input);
  const brandingReset = resetSiteBrandingRevisionStatement(input);
  const objectDeletionQueue = queueR2MediaObjectDeletionsStatement({
    db: input.db,
    existingTables,
    nowIso,
  });
  const searchStateReset = resetContentSearchIndexStateStatement({
    db: input.db,
    existingTables,
    nowIso,
  });
  const mutationStatements = [
    ...routingResets,
    brandingReset,
    ...(objectDeletionQueue ? [objectDeletionQueue] : []),
    ...deletions.map(({ statement }) => statement),
    ...(searchStateReset ? [searchStateReset] : []),
  ];
  const directChanges = await executeCountedMutationBatch(
    input.db,
    mutationStatements,
  );
  await verifyTablesAreEmpty(
    input.db,
    deletions.map(({ table }) => table),
  );

  const routingChanges = routingResets.reduce(
    (total, _statement, index) => (
      total + directChanges[index]!
    ),
    0,
  );
  const brandingChanges = directChanges[routingResets.length]!;
  const queueChanges = objectDeletionQueue
    ? directChanges[routingResets.length + 1]!
    : 0;
  const deletionOffset = routingResets.length
    + 1
    + (objectDeletionQueue ? 1 : 0);
  const searchStateChanges = searchStateReset
    ? directChanges[deletionOffset + deletions.length]!
    : 0;

  return {
    deletedRows: Object.fromEntries(
      deletions.flatMap(({ table }, index): Array<[string, number]> => (
        OPERATOR_HIDDEN_EFFECT_TABLES.has(table)
          ? []
          : [[table, directChanges[deletionOffset + index]!]]
      )),
    ),
    insertedRows: queueChanges > 0
      ? { media_object_deletions: queueChanges }
      : {},
    updatedRows: {
      ...(routingChanges + brandingChanges > 0
        ? { site_settings: routingChanges + brandingChanges }
        : {}),
      ...(searchStateChanges > 0
        ? { content_search_index_state: searchStateChanges }
        : {}),
    },
  };
}

export async function resetStudio(
  input: ResetStudioInput,
): Promise<DatabaseOperationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const existingTables = new Set(await listApplicationTables(input.db));
  const contentDeletions = deletionStatementsForTables(
    input.db,
    existingTables,
    CLEAR_SITE_CONTENT_TABLES,
  );
  const resetOnlyDeletions = deletionStatementsForTables(
    input.db,
    existingTables,
    RESET_STUDIO_ADDITIONAL_TABLES,
  );
  const objectDeletionQueue = queueR2MediaObjectDeletionsStatement({
    db: input.db,
    existingTables,
    nowIso,
  });
  const searchStateReset = resetContentSearchIndexStateStatement({
    db: input.db,
    existingTables,
    nowIso,
  });

  const resetStatements: Array<{
    table: string;
    statement: D1PreparedStatement;
    effect: 'deleted' | 'inserted' | 'updated';
  }> = [
    ...(objectDeletionQueue ? [{
      table: 'media_object_deletions',
      statement: objectDeletionQueue,
      effect: 'inserted' as const,
    }] : []),
    ...contentDeletions.map((deletion) => ({
      ...deletion,
      effect: 'deleted' as const,
    })),
    ...resetOnlyDeletions.map((deletion) => ({
      ...deletion,
      effect: 'deleted' as const,
    })),
    ...(searchStateReset ? [{
      table: 'content_search_index_state',
      statement: searchStateReset,
      effect: 'updated' as const,
    }] : []),
    {
      table: 'webauthn_discovery_challenges',
      statement: input.db.prepare(
        'DELETE FROM webauthn_discovery_challenges',
      ),
      effect: 'deleted',
    },
    {
      table: 'webauthn_challenges',
      statement: input.db.prepare('DELETE FROM webauthn_challenges'),
      effect: 'deleted',
    },
    {
      table: 'sessions',
      statement: input.db.prepare('DELETE FROM sessions'),
      effect: 'deleted',
    },
    {
      table: 'user_setup_tokens',
      statement: input.db.prepare('DELETE FROM user_setup_tokens'),
      effect: 'deleted',
    },
    {
      table: 'site_settings',
      statement: input.db.prepare('DELETE FROM site_settings'),
      effect: 'deleted',
    },
    {
      table: 'user_roles',
      statement: input.db.prepare('DELETE FROM user_roles'),
      effect: 'deleted',
    },
    {
      table: 'roles',
      statement: input.db.prepare('DELETE FROM roles'),
      effect: 'deleted',
    },
    {
      table: 'users',
      statement: input.db
        .prepare('DELETE FROM users WHERE id != ?')
        .bind(input.administratorId),
      effect: 'deleted',
    },
    {
      table: 'users',
      statement: input.db.prepare(`
        UPDATE users
        SET
          status = 'active',
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at_iso = ?
        WHERE id = ?
      `).bind(nowIso, input.administratorId),
      effect: 'updated',
    },
    {
      table: 'roles',
      statement: input.db.prepare(`
        INSERT INTO roles (
          key,
          name,
          description,
          is_system,
          created_at_iso,
          updated_at_iso
        )
        VALUES
          (
            'admin',
            'Administrator',
            'Full Studio administration access.',
            1,
            ?,
            ?
          ),
          (
            'editor',
            'Editor',
            'Manage and publish site content.',
            1,
            ?,
            ?
          ),
          (
            'author',
            'Author',
            'Create and manage assigned site content.',
            1,
            ?,
            ?
          )
      `).bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso),
      effect: 'inserted',
    },
    {
      table: 'user_roles',
      statement: input.db.prepare(`
        INSERT INTO user_roles (
          user_id,
          role_key,
          created_at_iso
        )
        VALUES (?, 'admin', ?)
      `).bind(input.administratorId, nowIso),
      effect: 'inserted',
    },
  ];

  const directChanges = await executeCountedMutationBatch(
    input.db,
    resetStatements.map(({ statement }) => statement),
  );

  await verifyTablesAreEmpty(
    input.db,
    [
      ...contentDeletions.map(({ table }) => table),
      ...resetOnlyDeletions.map(({ table }) => table),
      'webauthn_discovery_challenges',
      'webauthn_challenges',
      'user_setup_tokens',
    ],
  );
  const verification = await input.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS user_count,
      (SELECT COUNT(*) FROM users WHERE id = ?) AS preserved_user_count,
      (
        SELECT COUNT(*)
        FROM user_roles
        WHERE user_id = ?
          AND role_key = 'admin'
      ) AS administrator_role_count,
      (SELECT COUNT(*) FROM roles WHERE is_system = 1)
        AS system_role_count
  `).bind(
    input.administratorId,
    input.administratorId,
  ).first<{
    user_count: number;
    preserved_user_count: number;
    administrator_role_count: number;
    system_role_count: number;
  }>();

  if (
    verification?.user_count !== 1
    || verification.preserved_user_count !== 1
    || verification.administrator_role_count !== 1
    || verification.system_role_count !== 3
  ) {
    throw new Error('Studio reset verification failed.');
  }

  const changesByEffect = {
    deleted: {} as Record<string, number>,
    inserted: {} as Record<string, number>,
    updated: {} as Record<string, number>,
  };
  for (const [index, { table, effect }] of resetStatements.entries()) {
    if (OPERATOR_HIDDEN_EFFECT_TABLES.has(table)) continue;
    const changes = directChanges[index]!;
    if (changes > 0) {
      changesByEffect[effect][table] =
        (changesByEffect[effect][table] ?? 0) + changes;
    }
  }

  return {
    deletedRows: changesByEffect.deleted,
    insertedRows: changesByEffect.inserted,
    updatedRows: changesByEffect.updated,
  };
}

export function getUninstallStatements(): string[] {
  const statements = splitSqlStatements(uninstallSql);
  if (statements.length === 0) {
    throw new Error('Studio uninstall artifact contains no SQL statements.');
  }
  return statements;
}

export function getUninstallTableNames(): string[] {
  return getUninstallStatements().map((statement) => {
    const match = /^DROP TABLE ([a-z][a-z0-9_]*)$/u.exec(statement);
    if (!match) {
      throw new Error('Studio uninstall artifact contains unsupported SQL.');
    }
    return match[1];
  });
}

export async function inspectUninstallStudio(
  db: D1Database,
): Promise<UninstallStudioInspection> {
  const installedTables = (await listApplicationTables(db)).sort();
  const uninstallTables = getUninstallTableNames();
  const expectedTables = [...uninstallTables].sort();
  if (
    installedTables.length !== expectedTables.length
    || installedTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw new Error(
      'Installed Studio table set does not match the reviewed uninstall artifact.',
    );
  }

  const rowCounts = await db.batch(
    uninstallTables.map((table) => db.prepare(
      `SELECT COUNT(*) AS row_count FROM ${quotedIdentifier(table)}`,
    )),
  );
  const deletedRows = Object.fromEntries(
    uninstallTables.flatMap((table, index): Array<[string, number]> => {
      if (OPERATOR_HIDDEN_EFFECT_TABLES.has(table)) return [];
      const row = rowCounts[index]?.results?.[0] as {
        row_count?: unknown;
      } | undefined;
      return [[
        table,
        typeof row?.row_count === 'number' ? row.row_count : 0,
      ]];
    }),
  );

  return { deletedRows };
}

export async function uninstallStudioDatabase(
  db: D1Database,
): Promise<DatabaseOperationResult> {
  const uninstallInspection = await inspectUninstallStudio(db);

  await db.batch(
    getUninstallStatements().map((statement) => db.prepare(statement)),
  );

  const inspection = await inspectDatabaseStatus(db);
  if (inspection.status.state !== 'uninstalled') {
    throw new Error('Studio uninstall verification failed.');
  }

  return {
    deletedRows: uninstallInspection.deletedRows,
    insertedRows: {},
    updatedRows: {},
  };
}
