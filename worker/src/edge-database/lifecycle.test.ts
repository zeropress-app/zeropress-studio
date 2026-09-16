import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../../../contracts/sql-statements';
import {
  EDGE_DATABASE_BASELINE_SQL,
  EDGE_DATABASE_SCHEMA_STATE_TABLE,
  EDGE_DATABASE_SEED_SQL,
  type EdgeDatabaseUpgradeArtifact,
} from './schema-artifacts';
import {
  adoptEdgeDatabase,
  applyNextEdgeDatabaseUpgrade,
  createEdgeSchemaArtifactSha256,
  inspectEdgeDatabaseLifecycle,
  inspectEdgeDatabaseUninstall,
  installEdgeDatabase,
  readEdgeDatabaseUpgradeInitiator,
  startEdgeDatabaseUpgrade,
  uninstallEdgeDatabase,
} from './lifecycle';
import { sqliteD1, type SqliteD1Hooks } from '../test-helpers/sqlite-d1';

const TEST_INITIATOR = {
  userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  userEmail: 'owner@example.com',
} as const;

const open: DatabaseSync[] = [];

function database(hooks: SqliteD1Hooks = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  open.push(sqlite);
  return { sqlite, db: sqliteD1(sqlite, hooks) };
}

function legacyInstall(sqlite: DatabaseSync) {
  for (const statement of splitSqlStatements(EDGE_DATABASE_BASELINE_SQL)) {
    if (!statement.includes(`CREATE TABLE ${EDGE_DATABASE_SCHEMA_STATE_TABLE}`)) {
      sqlite.exec(statement);
    }
  }
  for (const statement of splitSqlStatements(EDGE_DATABASE_SEED_SQL)) {
    if (!statement.includes(`INSERT INTO ${EDGE_DATABASE_SCHEMA_STATE_TABLE}`)) {
      sqlite.exec(statement);
    }
  }
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe('Edge database lifecycle runner', () => {
  it('atomically installs an empty database and materializes canonical v1 state', async () => {
    const { sqlite, db } = database();
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db, siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'uninstalled', install_available: true });

    await installEdgeDatabase({ edgeDb: db });

    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db, siteMode: 'maintenance',
    })).resolves.toMatchObject({
      state: 'ready', current_schema_version: 1,
      install_available: false,
    });
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state, target_schema_version,
             active_operation_id
      FROM zeropress_edge_schema_state WHERE id = 1
    `).get()).toEqual({
      schema_version: 1,
      lifecycle_state: 'ready',
      target_schema_version: null,
      active_operation_id: null,
    });
  });

  it('rolls the entire fresh install back on a statement failure', async () => {
    const hooks = { failSqlOnce: 'INSERT INTO edge_runtime_settings' };
    const { sqlite, db } = database(hooks);

    await expect(installEdgeDatabase({ edgeDb: db })).rejects.toThrow(
      'Injected D1 statement failure',
    );
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type IN ('table', 'index', 'trigger', 'view')
        AND name NOT LIKE 'sqlite_%'
    `).get()).toEqual({ count: 0 });
  });

  it('converges to ready when the install commit succeeds but its response is lost', async () => {
    const hooks = { throwAfterCommitOnce: true };
    const { db } = database(hooks);

    await expect(installEdgeDatabase({ edgeDb: db })).rejects.toThrow(
      'Injected D1 response loss after commit',
    );
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db, siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'ready', current_schema_version: 1 });
  });

  it('previews every managed table and atomically uninstalls a ready database', async () => {
    const { sqlite, db } = database();
    await installEdgeDatabase({ edgeDb: db });
    sqlite.exec(`
      INSERT INTO edge_comment_targets (
        target_type, public_id, status, allow_comments
      ) VALUES ('post', 42, 'published', 1);
      INSERT INTO comments (
        public_id, target_id, parent_public_id, author_name, author_email,
        content, status, ip_address, user_agent, created_at, updated_at
      ) VALUES (
        1, 1, NULL, 'Author', 'author@example.com', 'Comment', 'approved',
        NULL, NULL, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
      );
    `);

    await expect(inspectEdgeDatabaseUninstall({ edgeDb: db }))
      .resolves.toMatchObject({
        deletedRows: {
          'EDGE_DB.edge_comment_targets': 1,
          'EDGE_DB.comments': 1,
          'EDGE_DB.zeropress_edge_schema_state': 1,
        },
      });

    await expect(uninstallEdgeDatabase({ edgeDb: db }))
      .resolves.toMatchObject({
        deletedRows: {
          'EDGE_DB.edge_comment_targets': 1,
          'EDGE_DB.comments': 1,
        },
      });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type IN ('table', 'index', 'trigger', 'view')
        AND name NOT LIKE 'sqlite_%'
    `).get()).toEqual({ count: 0 });
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db,
      siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'uninstalled' });
  });

  it('rolls back every Edge table drop when uninstall fails', async () => {
    const { sqlite, db } = database({ failSqlOnce: 'DROP TABLE forms' });
    await installEdgeDatabase({ edgeDb: db });

    await expect(uninstallEdgeDatabase({ edgeDb: db })).rejects.toThrow(
      'Injected D1 statement failure',
    );
    expect(sqlite.prepare(`
      SELECT lifecycle_state FROM zeropress_edge_schema_state WHERE id = 1
    `).get()).toEqual({ lifecycle_state: 'ready' });
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db,
      siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'ready' });
  });

  it('refuses to uninstall an uninstalled or unmanaged Edge database', async () => {
    const empty = database();
    await expect(uninstallEdgeDatabase({ edgeDb: empty.db }))
      .rejects.toMatchObject({ issue: 'not_available' });

    const unmanaged = database();
    unmanaged.sqlite.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    await expect(inspectEdgeDatabaseUninstall({ edgeDb: unmanaged.db }))
      .rejects.toMatchObject({ issue: 'not_available' });
  });

  it('explicitly adopts only an exact unversioned current database and preserves business data', async () => {
    const { sqlite, db } = database();
    legacyInstall(sqlite);
    sqlite.prepare(`
      INSERT INTO edge_comment_targets (
        target_type, public_id, status, allow_comments
      ) VALUES ('post', 42, 'published', 1)
    `).run();

    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db, siteMode: 'maintenance',
    })).resolves.toMatchObject({
      state: 'adoption_required', adopt_available: true,
    });
    await adoptEdgeDatabase({ edgeDb: db, now: new Date('2026-08-11T00:00:00Z') });
    expect(sqlite.prepare(`
      SELECT target_type, public_id, status, allow_comments
      FROM edge_comment_targets
    `).all()).toEqual([{
      target_type: 'post', public_id: 42, status: 'published',
      allow_comments: 1,
    }]);
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db, siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'ready' });
  });

  it('does not adopt incomplete seeds or an unexpected application object', async () => {
    const missingSeed = database();
    legacyInstall(missingSeed.sqlite);
    missingSeed.sqlite.exec('DELETE FROM edge_runtime_settings');
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: missingSeed.db, siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'unmanaged' });

    const unexpected = database();
    legacyInstall(unexpected.sqlite);
    unexpected.sqlite.exec('CREATE TABLE operator_extra (id INTEGER PRIMARY KEY)');
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: unexpected.db, siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'unmanaged' });
  });

  it('keeps a managed database ready after valid authored settings change', async () => {
    const { sqlite, db } = database();
    await installEdgeDatabase({ edgeDb: db });
    sqlite.exec(`
      UPDATE edge_comment_settings
      SET per_page = 25, sort_order = 'asc', require_approval = 0
      WHERE id = 1;
      UPDATE edge_runtime_settings
      SET ip_address_retention_days = 90
      WHERE id = 1;
      UPDATE edge_mail_settings
      SET newsletter_confirmation_enabled = 1
      WHERE id = 1;
      UPDATE newsletter_lists
      SET title = 'Product updates', description = 'Authored content'
      WHERE slug = 'default';
    `);

    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db,
      siteMode: 'maintenance',
    })).resolves.toMatchObject({ state: 'ready' });
  });

  it('starts and resumes a checksum-verified synthetic forward step', async () => {
    const { sqlite, db } = database();
    await installEdgeDatabase({ edgeDb: db });
    const sql = 'ALTER TABLE forms ADD COLUMN synthetic_marker TEXT';
    const artifact: EdgeDatabaseUpgradeArtifact = {
      id: 'schema_1_to_2',
      fromVersion: 1,
      toVersion: 2,
      sql,
      sha256: await createEdgeSchemaArtifactSha256(sql),
    };
    const operationId = 'a'.repeat(32);
    const started = await startEdgeDatabaseUpgrade({
      initiator: TEST_INITIATOR,
      edgeDb: db,
      targetVersion: 2,
      artifacts: [artifact],
      createOperationId: () => operationId,
    });
    expect(started).toMatchObject({ operationId, currentVersion: 1 });
    await expect(readEdgeDatabaseUpgradeInitiator({
      edgeDb: db,
      operationId,
    })).resolves.toEqual(TEST_INITIATOR);
    await expect(startEdgeDatabaseUpgrade({
      initiator: {
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        userEmail: 'later-admin@example.com',
      },
      edgeDb: db,
      targetVersion: 2,
      artifacts: [artifact],
    })).resolves.toMatchObject({ operationId, currentVersion: 1 });
    await expect(readEdgeDatabaseUpgradeInitiator({
      edgeDb: db,
      operationId,
    })).resolves.toEqual(TEST_INITIATOR);
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db,
      siteMode: 'maintenance',
      targetVersion: 2,
      artifacts: [artifact],
    })).resolves.toMatchObject({ state: 'in_progress', operation_id: operationId });

    await applyNextEdgeDatabaseUpgrade({
      edgeDb: db,
      operationId,
      stepId: artifact.id,
      targetVersion: 2,
      artifacts: [artifact],
    });
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state FROM zeropress_edge_schema_state
      WHERE id = 1
    `).get()).toEqual({ schema_version: 2, lifecycle_state: 'ready' });
    expect(sqlite.prepare(`
      SELECT name FROM pragma_table_info('forms') WHERE name = 'synthetic_marker'
    `).get()).toEqual({ name: 'synthetic_marker' });
  });

  it('retries a synthetic future step after rollback and recognizes a lost response', async () => {
    const hooks: SqliteD1Hooks = {};
    const { sqlite, db } = database(hooks);
    await installEdgeDatabase({ edgeDb: db });
    const sql = `
      ALTER TABLE forms ADD COLUMN synthetic_marker TEXT;
      CREATE INDEX idx_forms_synthetic_marker ON forms(synthetic_marker);
    `;
    const artifact: EdgeDatabaseUpgradeArtifact = {
      id: 'schema_1_to_2',
      fromVersion: 1,
      toVersion: 2,
      sql,
      sha256: await createEdgeSchemaArtifactSha256(sql),
    };
    const operationId = 'c'.repeat(32);
    const started = await startEdgeDatabaseUpgrade({
      initiator: TEST_INITIATOR,
      edgeDb: db,
      targetVersion: 2,
      artifacts: [artifact],
      createOperationId: () => operationId,
    });
    const request = {
      edgeDb: db,
      operationId: started.operationId,
      stepId: artifact.id,
      targetVersion: 2,
      artifacts: [artifact],
    };

    hooks.failSqlOnce = 'CREATE INDEX idx_forms_synthetic_marker';
    await expect(applyNextEdgeDatabaseUpgrade(request)).rejects.toThrow(
      'Injected D1 statement failure',
    );
    expect(sqlite.prepare(`
      SELECT name FROM pragma_table_info('forms')
      WHERE name = 'synthetic_marker'
    `).get()).toBeUndefined();
    await expect(inspectEdgeDatabaseLifecycle({
      edgeDb: db,
      siteMode: 'maintenance',
      targetVersion: 2,
      artifacts: [artifact],
    })).resolves.toMatchObject({
      state: 'in_progress',
      current_schema_version: 1,
      operation_id: operationId,
    });
    await expect(startEdgeDatabaseUpgrade({
      initiator: TEST_INITIATOR,
      edgeDb: db,
      targetVersion: 2,
      artifacts: [artifact],
    })).resolves.toMatchObject({ operationId, currentVersion: 1 });

    hooks.throwAfterCommitOnce = true;
    await expect(applyNextEdgeDatabaseUpgrade(request)).rejects.toThrow(
      'Injected D1 response loss after commit',
    );
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state, target_schema_version,
             active_operation_id
      FROM zeropress_edge_schema_state WHERE id = 1
    `).get()).toEqual({
      schema_version: 2,
      lifecycle_state: 'ready',
      target_schema_version: null,
      active_operation_id: null,
    });
    await expect(applyNextEdgeDatabaseUpgrade(request)).rejects.toMatchObject({
      issue: 'state_conflict',
    });
  });

  it('refuses to start or continue an upgrade while a restore journal exists', async () => {
    const sql = 'ALTER TABLE forms ADD COLUMN synthetic_marker TEXT';
    const artifact: EdgeDatabaseUpgradeArtifact = {
      id: 'schema_1_to_2',
      fromVersion: 1,
      toVersion: 2,
      sql,
      sha256: await createEdgeSchemaArtifactSha256(sql),
    };

    const beforeStart = database();
    await installEdgeDatabase({ edgeDb: beforeStart.db });
    beforeStart.sqlite.exec('CREATE TABLE zeropress_restore_journal (id INTEGER)');
    await expect(startEdgeDatabaseUpgrade({
      initiator: TEST_INITIATOR,
      edgeDb: beforeStart.db,
      targetVersion: 2,
      artifacts: [artifact],
    })).rejects.toMatchObject({ issue: 'not_available' });

    const beforeStep = database();
    await installEdgeDatabase({ edgeDb: beforeStep.db });
    const operationId = 'b'.repeat(32);
    await startEdgeDatabaseUpgrade({
      initiator: TEST_INITIATOR,
      edgeDb: beforeStep.db,
      targetVersion: 2,
      artifacts: [artifact],
      createOperationId: () => operationId,
    });
    beforeStep.sqlite.exec('CREATE TABLE zeropress_restore_journal (id INTEGER)');
    await expect(applyNextEdgeDatabaseUpgrade({
      edgeDb: beforeStep.db,
      operationId,
      stepId: artifact.id,
      targetVersion: 2,
      artifacts: [artifact],
    })).rejects.toMatchObject({ issue: 'state_conflict' });
  });
});
