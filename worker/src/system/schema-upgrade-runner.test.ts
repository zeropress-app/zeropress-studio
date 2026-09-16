import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE_UPGRADE_CONFIRMATION } from '../../../contracts/database-upgrade';
import {
  STUDIO_SCHEMA_UPGRADE_ARTIFACTS,
  type StudioSchemaUpgradeArtifact,
} from './schema-upgrade-artifacts';
import {
  MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
  STUDIO_SCHEMA_VERSION,
} from './schema-version';
import {
  applyNextStudioSchemaUpgrade,
  createSchemaUpgradeArtifactSha256,
  createStudioSchemaUpgradePlan,
  inspectStudioSchemaUpgrade,
  readStudioSchemaUpgradeInitiator,
  SchemaUpgradeArtifactError,
  startStudioSchemaUpgrade,
} from './schema-upgrade-runner';

const TEST_INITIATOR = {
  userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  userEmail: 'owner@example.com',
} as const;

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly parameters: unknown[] = [],
  ) {}

  bind(...parameters: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (...values: unknown[]) =>
        SqliteRunResult
    )(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...values: unknown[]) => T[]
    )(...this.parameters);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...values: unknown[]) =>
        T | undefined
    )(...this.parameters);
    return row ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:SELECT|PRAGMA\s+(?!defer_foreign_keys))/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) {
          results.push(await statement.execute());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE zeropress_schema_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      target_schema_version INTEGER,
      active_operation_id TEXT,
      installed_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    INSERT INTO zeropress_schema_state VALUES (
      1, 1, 'ready', NULL, NULL,
      '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
    );
    CREATE TABLE example (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO example (id, value) VALUES (1, 'one');
  `);
  return { sqlite, db: sqliteD1(sqlite) };
}

async function artifact(input: {
  id: string;
  from: number;
  sql: string;
}): Promise<StudioSchemaUpgradeArtifact> {
  return {
    id: input.id,
    fromVersion: input.from,
    toVersion: input.from + 1,
    sql: input.sql,
    sha256: await createSchemaUpgradeArtifactSha256(input.sql),
  };
}

async function syntheticChain() {
  return [
    await artifact({
      id: '001_add_example_note',
      from: 1,
      sql: 'ALTER TABLE example ADD COLUMN note TEXT;',
    }),
    await artifact({
      id: '002_index_example_value',
      from: 2,
      sql: 'CREATE INDEX idx_example_value ON example (value);',
    }),
  ];
}

const startRequest = {
  administrator_email: 'owner@example.com',
  administrator_password: 'administrator-password',
  backup_acknowledged: true as const,
  confirmation: DATABASE_UPGRADE_CONFIRMATION,
} as const;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('Studio schema upgrade runner', () => {
  it('keeps the production registry complete from the supported floor to the current schema', async () => {
    await expect(createStudioSchemaUpgradePlan({
      fromVersion: MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
      targetVersion: STUDIO_SCHEMA_VERSION,
      artifacts: STUDIO_SCHEMA_UPGRADE_ARTIFACTS,
    })).resolves.toHaveProperty(
      'steps.length',
      STUDIO_SCHEMA_VERSION - MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
    );
  });

  it('starts, resumes from the committed version, and completes consecutive atomic steps', async () => {
    const { sqlite, db } = createDatabase();
    databases.push(sqlite);
    const artifacts = await syntheticChain();

    await expect(inspectStudioSchemaUpgrade({
      db,
      siteMode: 'operational',
      targetVersion: 3,
      artifacts,
    })).resolves.toMatchObject({
      state: 'upgrade_required',
      available: false,
      current_schema_version: 1,
      steps: [{ id: '001_add_example_note' }, { id: '002_index_example_value' }],
    });

    const started = await startStudioSchemaUpgrade({
      initiator: TEST_INITIATOR,
      db,
      request: startRequest,
      targetVersion: 3,
      artifacts,
      createOperationId: () => '1'.repeat(32),
    });
    expect(started.next_step.id).toBe('001_add_example_note');
    await expect(readStudioSchemaUpgradeInitiator({
      db,
      operationId: started.operation_id,
    })).resolves.toEqual(TEST_INITIATOR);

    const first = await applyNextStudioSchemaUpgrade({
      db,
      request: {
        operation_id: started.operation_id,
        step_id: started.next_step.id,
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      },
      targetVersion: 3,
      artifacts,
    });
    expect(first).toMatchObject({
      status: 'in_progress',
      current_schema_version: 2,
      next_step: { id: '002_index_example_value' },
    });
    await expect(readStudioSchemaUpgradeInitiator({
      db,
      operationId: started.operation_id,
    })).resolves.toEqual(TEST_INITIATOR);

    await expect(inspectStudioSchemaUpgrade({
      db,
      siteMode: 'maintenance',
      targetVersion: 3,
      artifacts,
    })).resolves.toMatchObject({
      state: 'in_progress',
      available: true,
      current_schema_version: 2,
      operation_id: '1'.repeat(32),
      steps: [{ id: '002_index_example_value' }],
    });

    const completed = await applyNextStudioSchemaUpgrade({
      db,
      request: {
        operation_id: started.operation_id,
        step_id: '002_index_example_value',
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      },
      targetVersion: 3,
      artifacts,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      operation_id: null,
      current_schema_version: 3,
    });
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state, target_schema_version,
             active_operation_id
      FROM zeropress_schema_state WHERE id = 1
    `).get()).toEqual({
      schema_version: 3,
      lifecycle_state: 'ready',
      target_schema_version: null,
      active_operation_id: null,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name = 'zeropress_schema_upgrade_guard'
    `).get()).toEqual({ count: 0 });
  });

  it('rolls back a failed artifact and preserves its version as the retry boundary', async () => {
    const { sqlite, db } = createDatabase();
    databases.push(sqlite);
    const failing = await artifact({
      id: '001_failing_change',
      from: 1,
      sql: `
        CREATE TABLE partial_change (id INTEGER PRIMARY KEY);
        INSERT INTO table_that_does_not_exist (id) VALUES (1);
      `,
    });
    const fixed = await artifact({
      id: '001_failing_change',
      from: 1,
      sql: 'CREATE TABLE completed_change (id INTEGER PRIMARY KEY);',
    });
    const started = await startStudioSchemaUpgrade({
      initiator: TEST_INITIATOR,
      db,
      request: startRequest,
      targetVersion: 2,
      artifacts: [failing],
      createOperationId: () => '2'.repeat(32),
    });
    await expect(applyNextStudioSchemaUpgrade({
      db,
      request: {
        operation_id: started.operation_id,
        step_id: failing.id,
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      },
      targetVersion: 2,
      artifacts: [failing],
    })).rejects.toThrow();
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state FROM zeropress_schema_state
      WHERE id = 1
    `).get()).toEqual({ schema_version: 1, lifecycle_state: 'upgrading' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'partial_change'
    `).get()).toEqual({ count: 0 });

    await expect(applyNextStudioSchemaUpgrade({
      db,
      request: {
        operation_id: started.operation_id,
        step_id: fixed.id,
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      },
      targetVersion: 2,
      artifacts: [fixed],
    })).resolves.toMatchObject({ status: 'completed', current_schema_version: 2 });
  });

  it('rolls back the patch and version update when final foreign-key validation fails', async () => {
    const { sqlite, db } = createDatabase();
    databases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE parent_row (id INTEGER PRIMARY KEY);
      CREATE TABLE child_row (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent_row(id)
      );
      INSERT INTO parent_row (id) VALUES (1);
      INSERT INTO child_row (id, parent_id) VALUES (1, 1);
    `);
    const invalid = await artifact({
      id: '001_break_foreign_key',
      from: 1,
      sql: 'DROP TABLE parent_row;',
    });
    const started = await startStudioSchemaUpgrade({
      initiator: TEST_INITIATOR,
      db,
      request: startRequest,
      targetVersion: 2,
      artifacts: [invalid],
      createOperationId: () => '4'.repeat(32),
    });
    await expect(applyNextStudioSchemaUpgrade({
      db,
      request: {
        operation_id: started.operation_id,
        step_id: invalid.id,
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      },
      targetVersion: 2,
      artifacts: [invalid],
    })).rejects.toThrow();
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'parent_row'
    `).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(`
      SELECT schema_version, lifecycle_state FROM zeropress_schema_state
      WHERE id = 1
    `).get()).toEqual({ schema_version: 1, lifecycle_state: 'upgrading' });
  });

  it('rejects replayed steps and invalid or incomplete artifact chains', async () => {
    const { sqlite, db } = createDatabase();
    databases.push(sqlite);
    const artifacts = await syntheticChain();
    const started = await startStudioSchemaUpgrade({
      initiator: TEST_INITIATOR,
      db,
      request: startRequest,
      targetVersion: 3,
      artifacts,
      createOperationId: () => '3'.repeat(32),
    });
    const firstRequest = {
      operation_id: started.operation_id,
      step_id: started.next_step.id,
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    } as const;
    await applyNextStudioSchemaUpgrade({
      db,
      request: firstRequest,
      targetVersion: 3,
      artifacts,
    });
    await expect(applyNextStudioSchemaUpgrade({
      db,
      request: firstRequest,
      targetVersion: 3,
      artifacts,
    })).rejects.toMatchObject({
      issue: 'state_conflict',
    });

    await expect(createStudioSchemaUpgradePlan({
      fromVersion: 1,
      targetVersion: 3,
      artifacts: [artifacts[0]!],
    })).rejects.toBeInstanceOf(SchemaUpgradeArtifactError);
    const transactionSql = '-- artifact header\nBEGIN; CREATE TABLE forbidden (id INTEGER); COMMIT;';
    await expect(createStudioSchemaUpgradePlan({
      fromVersion: 1,
      targetVersion: 2,
      artifacts: [{
        id: '001_transaction',
        fromVersion: 1,
        toVersion: 2,
        sql: transactionSql,
        sha256: await createSchemaUpgradeArtifactSha256(transactionSql),
      }],
    })).rejects.toBeInstanceOf(SchemaUpgradeArtifactError);

    const lifecycleSql = 'UPDATE zeropress_schema_state SET schema_version = 2;';
    await expect(createStudioSchemaUpgradePlan({
      fromVersion: 1,
      targetVersion: 2,
      artifacts: [{
        id: '001_runner_owned_state',
        fromVersion: 1,
        toVersion: 2,
        sql: lifecycleSql,
        sha256: await createSchemaUpgradeArtifactSha256(lifecycleSql),
      }],
    })).rejects.toBeInstanceOf(SchemaUpgradeArtifactError);

    await expect(createStudioSchemaUpgradePlan({
      fromVersion: 1,
      targetVersion: 2,
      artifacts: [{
        ...artifacts[0]!,
        sha256: '0'.repeat(64),
      }],
    })).rejects.toBeInstanceOf(SchemaUpgradeArtifactError);
  });

  it('does not start while a logical restore journal owns the database', async () => {
    const { sqlite, db } = createDatabase();
    databases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE zeropress_restore_journal (id INTEGER PRIMARY KEY);
    `);
    const artifacts = [await artifact({
      id: '001_blocked_by_restore',
      from: 1,
      sql: 'CREATE TABLE after_restore (id INTEGER PRIMARY KEY);',
    })];
    await expect(inspectStudioSchemaUpgrade({
      db,
      siteMode: 'maintenance',
      targetVersion: 2,
      artifacts,
    })).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'recovery_required',
    });
    await expect(startStudioSchemaUpgrade({
      initiator: TEST_INITIATOR,
      db,
      request: startRequest,
      targetVersion: 2,
      artifacts,
    })).rejects.toMatchObject({
      issue: 'not_available',
    });
  });
});
