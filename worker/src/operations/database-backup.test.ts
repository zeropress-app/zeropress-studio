import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDatabaseRestoreChunks,
  createDatabaseRestorePlan,
  createSchemaFingerprint,
  createManifestSha256,
  createStatementChainSha256,
  inspectDatabaseBackupArtifact,
  serializeDatabaseBackupArtifact,
  type DatabaseBackupManifest,
  type FingerprintedSchemaObject,
} from '../../../contracts/database-backup';
import {
  applyDatabaseRestoreChunk,
  exportDatabaseBackup,
  finalizeDatabaseRestore,
  readDatabaseRestoreInitiator,
  startDatabaseRestore,
} from './database-backup';
import { STUDIO_SCHEMA_VERSION } from '../system/schema-version';
import { sqliteD1 as faultInjectingD1, type SqliteD1Hooks } from '../test-helpers/sqlite-d1';
import { inspectEdgeDatabaseLifecycle } from '../edge-database/lifecycle';
import { EDGE_DATABASE_TARGET_SCHEMA_VERSION } from '../edge-database/schema-artifacts';

const tableObject: FingerprintedSchemaObject = {
  type: 'table',
  name: 'example',
  table_name: 'example',
  sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)',
};
const indexObject: FingerprintedSchemaObject = {
  type: 'index',
  name: 'idx_example_value',
  table_name: 'example',
  sql: 'CREATE INDEX idx_example_value ON example (value)',
};
const TEST_INITIATOR = {
  userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  userEmail: 'canonical-owner@example.com',
} as const;

type FakeStatement = D1PreparedStatement & {
  query: string;
  bindings: unknown[];
};

function schemaRows(objects = [tableObject, indexObject]) {
  return objects.map((object) => ({
    type: object.type,
    name: object.name,
    table_name: object.table_name,
    sql: object.sql,
  }));
}

function createBackupD1() {
  const batches: FakeStatement[][] = [];
  const prepare = (query: string) => {
    const statement = {
      query,
      bindings: [],
      bind(...values: unknown[]) {
        statement.bindings = values;
        return statement;
      },
      async all() {
        if (query.includes('FROM sqlite_schema')) {
          return { success: true, results: schemaRows(), meta: {} };
        }
        if (query.includes('PRAGMA table_info')) {
          return {
            success: true,
            results: [
              { name: 'id', pk: 1 },
              { name: 'value', pk: 0 },
            ],
            meta: {},
          };
        }
        if (query.includes('SELECT *')) {
          return {
            success: true,
            results: [{ id: 1, value: 'one;two' }],
            meta: {},
          };
        }
        throw new Error(`Unexpected all query: ${query}`);
      },
      async first() {
        return null;
      },
    } as unknown as FakeStatement;
    return statement;
  };
  const database = {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      const typed = statements as FakeStatement[];
      batches.push(typed);
      return typed.map((statement) => ({
        success: true,
        results: statement.query.includes('COUNT(*)')
          ? [{ row_count: 1 }]
          : [],
        meta: {},
      }));
    },
  } as unknown as D1Database;
  return { database, batches };
}

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
    return /^\s*SELECT\b/iu.test(this.sql) ? this.all() : this.run();
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

async function dataArtifact(input: {
  mode?: DatabaseBackupManifest['mode'];
  fingerprintObjects?: FingerprintedSchemaObject[];
} = {}) {
  const mode = input.mode ?? 'data_only';
  const fingerprintObjects = input.fingerprintObjects
    ?? [tableObject, indexObject];
  const statements = mode === 'structure_only'
    ? [
        'PRAGMA defer_foreign_keys = TRUE',
        'DROP INDEX IF EXISTS "idx_example_value"',
        'DROP TABLE IF EXISTS "example"',
        tableObject.sql,
        indexObject.sql,
      ]
    : [
        'PRAGMA defer_foreign_keys = TRUE',
        'DELETE FROM "example"',
        'INSERT INTO "example" ("id", "value") VALUES (1, \'one;two\')',
      ];
  const manifest: DatabaseBackupManifest = {
    format: 'zeropress-studio-sql-backup',
    format_version: 1,
    database: 'studio',
    mode,
    exported_at_iso: '2026-08-03T00:00:00.000Z',
    schema_fingerprint: await createSchemaFingerprint(fingerprintObjects),
    studio_schema_version: null,
    schema_objects: [
      { type: 'table', name: 'example', table_name: 'example' },
      {
        type: 'index',
        name: 'idx_example_value',
        table_name: 'example',
      },
    ],
    tables: [{ name: 'example', row_count: 1 }],
  };
  return serializeDatabaseBackupArtifact({
    manifest,
    statements,
    footer: {
      manifest_sha256: await createManifestSha256(manifest),
      statement_count: statements.length,
      statement_chain_sha256: await createStatementChainSha256(statements),
    },
  });
}

async function restoreArtifact(input: {
  db: D1Database;
  database: 'studio' | 'edge';
  sql: string;
  loseFirstChunkResponse?: SqliteD1Hooks;
}) {
  const inspection = await inspectDatabaseBackupArtifact(input.sql);
  const plan = await createDatabaseRestorePlan(inspection);
  const started = await startDatabaseRestore({
    db: input.db,
    database: input.database,
    request: {
      database: input.database,
      manifest: plan.manifest,
      manifest_sha256: plan.footer.manifest_sha256,
      artifact_digest: plan.artifactDigest,
      artifact_statement_count: plan.footer.statement_count,
      expected_chunk_count: plan.chunkCount,
      table_statements: plan.tableStatements,
      secondary_statements: plan.secondaryStatements,
      confirmation: 'RESTORE DATABASE',
    },
  });
  for (const chunk of createDatabaseRestoreChunks(plan)) {
    const command = {
      db: input.db,
      database: input.database,
      request: {
        database: input.database,
        restore_id: started.restoreId,
        artifact_digest: plan.artifactDigest,
        chunk_index: chunk.chunkIndex,
        table: chunk.table,
        columns: chunk.columns,
        rows: chunk.rows,
      },
    };
    if (chunk.chunkIndex === 0 && input.loseFirstChunkResponse) {
      input.loseFirstChunkResponse.throwAfterCommitOnce = true;
      await expect(applyDatabaseRestoreChunk(command)).rejects.toThrow();
      await expect(applyDatabaseRestoreChunk(command)).resolves.toMatchObject({
        replayed: true,
      });
    } else {
      await applyDatabaseRestoreChunk(command);
    }
  }
  return finalizeDatabaseRestore({
    db: input.db,
    database: input.database,
    request: {
      database: input.database,
      restore_id: started.restoreId,
      artifact_digest: plan.artifactDigest,
      expected_chunk_count: plan.chunkCount,
      secondary_statements: plan.secondaryStatements,
    },
  });
}

describe('database SQL backup service', () => {
  it.each(['structure_and_data', 'data_only'] as const)(
    'round-trips populated Edge domains with %s and a lost chunk response',
    async (mode) => {
      const source = new DatabaseSync(':memory:');
      const target = new DatabaseSync(':memory:');
      try {
        const baseline = readFileSync(new URL(
          '../../../database/edge/install/001_edge_baseline.sql', import.meta.url,
        ), 'utf8');
        source.exec('PRAGMA foreign_keys = ON');
        target.exec('PRAGMA foreign_keys = ON');
        source.exec(baseline);
        source.exec(readFileSync(new URL(
          '../../../database/edge/install/002_edge_seed.sql', import.meta.url,
        ), 'utf8'));
        source.exec(`
          INSERT INTO edge_comment_targets (id, target_type, public_id, status, allow_comments)
            VALUES (1, 'post', 42, 'published', 1);
          INSERT INTO comments (id, public_id, target_id, author_name, author_email, content)
            VALUES ('comment', 1, 1, 'Fixture reader', 'reader@example.test', 'A comment');
          INSERT INTO forms (id, slug, title, status)
            VALUES ('form', 'contact', 'Contact', 'active');
          INSERT INTO form_fields (id, form_id, field_key, label, type, required)
            VALUES ('field', 'form', 'message', 'Message', 'textarea', 1);
          INSERT INTO form_submissions (id, form_id, submitted_at)
            VALUES ('submission', 'form', '2026-09-04T00:00:00Z');
          INSERT INTO form_submission_values
            (id, submission_id, field_id, field_key, field_label, field_type, field_value, created_at)
            VALUES ('value', 'submission', 'field', 'message', 'Message', 'textarea',
              'Fixture message', '2026-09-04T00:00:00Z');
          INSERT INTO newsletter_subscribers (id, email)
            VALUES ('subscriber', 'subscriber@example.test');
          INSERT INTO newsletter_subscriptions (id, newsletter_id, subscriber_id, status)
            SELECT 'subscription', id, 'subscriber', 'subscribed' FROM newsletter_lists;
          INSERT INTO newsletter_fields (id, newsletter_id, field_key, label, type)
            SELECT 'newsletter-field', id, 'name', 'Name', 'text' FROM newsletter_lists;
          INSERT INTO newsletter_field_values (id, subscription_id, field_id, field_value)
            VALUES ('newsletter-value', 'subscription', 'newsletter-field', 'Fixture reader');
          INSERT INTO newsletter_deliveries
            (id, newsletter_id, subscription_id, delivery_type, content_id, idempotency_key,
              queued_at, created_at, updated_at)
            SELECT 'delivery', id, 'subscription', 'post_notification', 'post', 'fixture-delivery',
              '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'
              FROM newsletter_lists;
          INSERT INTO newsletter_suppressions (id, email, reason)
            VALUES ('suppression', 'suppressed@example.test', 'manual');
        `);
        if (mode === 'data_only') target.exec(baseline);
        const hooks: SqliteD1Hooks = {};
        const db = faultInjectingD1(target, hooks);
        const backup = await exportDatabaseBackup({ db: sqliteD1(source), database: 'edge', mode });
        await restoreArtifact({ db, database: 'edge', sql: backup.sql, loseFirstChunkResponse: hooks });
        const restored = await exportDatabaseBackup({ db, database: 'edge', mode });
        expect(restored.manifest.schema_fingerprint).toBe(backup.manifest.schema_fingerprint);
        expect(restored.manifest.tables).toEqual(backup.manifest.tables);
        for (const { name } of backup.manifest.tables) {
          // Names come from the checked-in schema, not external input.
          expect(target.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())
            .toEqual(source.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
        }
        expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(target.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(await inspectEdgeDatabaseLifecycle({ edgeDb: db, siteMode: 'maintenance' })).toMatchObject({
          state: 'ready', current_schema_version: EDGE_DATABASE_TARGET_SCHEMA_VERSION,
        });
        target.prepare("UPDATE comments SET status = 'approved' WHERE id = 'comment'").run();
        expect(target.prepare("SELECT status FROM comments WHERE id = 'comment'").get())
          .toEqual({ status: 'approved' });
      } finally {
        source.close();
        target.close();
      }
    },
  );

  it('excludes transient schema-upgrade runner state from logical artifacts', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE zeropress_schema_upgrade_guard (
        id INTEGER PRIMARY KEY,
        operation_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        validation_count INTEGER NOT NULL
      );
    `);
    try {
      const backup = await exportDatabaseBackup({
        db: sqliteD1(sqlite),
        database: 'edge',
        mode: 'structure_only',
      });
      expect(backup.manifest.tables.map(({ name }) => name)).toEqual([
        'example',
      ]);
      expect(backup.sql).not.toContain('zeropress_schema_upgrade_guard');
    } finally {
      sqlite.close();
    }
  });

  it('atomically refuses a new maintenance restore while a schema upgrade owns the lifecycle', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      ${tableObject.sql};
      ${indexObject.sql};
      INSERT INTO example (id, value) VALUES (1, 'preserved');
      CREATE TABLE zeropress_schema_state (
        id INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        lifecycle_state TEXT NOT NULL,
        target_schema_version INTEGER,
        active_operation_id TEXT,
        updated_at_iso TEXT NOT NULL
      );
      INSERT INTO zeropress_schema_state VALUES (
        1, 1, 'ready', NULL, NULL, '2026-08-03T00:00:00.000Z'
      );
    `);
    const db = sqliteD1(sqlite);
    try {
      const backup = await exportDatabaseBackup({
        db,
        database: 'studio',
        mode: 'structure_and_data',
      });
      const plan = await createDatabaseRestorePlan(
        await inspectDatabaseBackupArtifact(backup.sql),
      );
      sqlite.exec(`
        UPDATE zeropress_schema_state
        SET lifecycle_state = 'upgrading',
            target_schema_version = 2,
            active_operation_id = '${'1'.repeat(32)}';
        CREATE TABLE zeropress_schema_upgrade_guard (
          id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          validation_count INTEGER NOT NULL
        );
      `);

      await expect(startDatabaseRestore({
        db,
        database: 'studio',
        requireReadyStudioLifecycle: true,
        request: {
          database: 'studio',
          manifest: plan.manifest,
          manifest_sha256: plan.footer.manifest_sha256,
          artifact_digest: plan.artifactDigest,
          artifact_statement_count: plan.footer.statement_count,
          expected_chunk_count: plan.chunkCount,
          table_statements: plan.tableStatements,
          secondary_statements: plan.secondaryStatements,
          confirmation: 'RESTORE DATABASE',
        },
      })).rejects.toThrow();
      expect(sqlite.prepare('SELECT * FROM example').all()).toEqual([
        { id: 1, value: 'preserved' },
      ]);
      expect(sqlite.prepare(`
        SELECT schema_version, lifecycle_state
        FROM zeropress_schema_state WHERE id = 1
      `).get()).toEqual({ schema_version: 1, lifecycle_state: 'upgrading' });
    } finally {
      sqlite.close();
    }
  });

  it('exports deterministic schema and data with a verified artifact', async () => {
    const { database } = createBackupD1();
    const backup = await exportDatabaseBackup({
      db: database,
      database: 'edge',
      mode: 'structure_and_data',
      now: new Date('2026-08-03T01:02:03.004Z'),
    });

    expect(backup.filename).toBe(
      'zeropress-edge-structure_and_data-2026-08-03T01-02-03-004Z.sql',
    );
    expect(backup.manifest.tables).toEqual([
      { name: 'example', row_count: 1 },
    ]);
    expect(backup.sql).toContain('DROP TABLE IF EXISTS "example";');
    expect(backup.sql).toContain("VALUES (1, 'one;two');");
    expect(backup.sql.indexOf('CREATE TABLE example')).toBeLessThan(
      backup.sql.indexOf('INSERT INTO "example"'),
    );
    expect(backup.sql.indexOf('INSERT INTO "example"')).toBeLessThan(
      backup.sql.indexOf('CREATE INDEX idx_example_value'),
    );
  });

  it('restores exact-schema data through a journaled bound-row flow', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`${tableObject.sql}; ${indexObject.sql};`);
    database.prepare('INSERT INTO example (id, value) VALUES (9, ?)')
      .run('temporary');
    const result = await restoreArtifact({
      db: sqliteD1(database),
      database: 'studio',
      sql: await dataArtifact(),
    });
    expect(result.mode).toBe('data_only');
    expect(database.prepare('SELECT * FROM example').all()).toEqual([
      { id: 1, value: 'one;two' },
    ]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name = 'zeropress_restore_journal'
    `).get()).toEqual({ count: 0 });
  });

  it('restarts an interrupted restore and treats an accepted chunk replay as idempotent', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`${tableObject.sql}; ${indexObject.sql};`);
    const d1 = sqliteD1(database);
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(await dataArtifact()),
    );
    const startRequest = {
      database: 'studio' as const,
      manifest: plan.manifest,
      manifest_sha256: plan.footer.manifest_sha256,
      artifact_digest: plan.artifactDigest,
      artifact_statement_count: plan.footer.statement_count,
      expected_chunk_count: plan.chunkCount,
      table_statements: plan.tableStatements,
      secondary_statements: plan.secondaryStatements,
      confirmation: 'RESTORE DATABASE' as const,
    };
    const first = await startDatabaseRestore({
      db: d1,
      database: 'studio',
      request: startRequest,
      initiator: TEST_INITIATOR,
    });
    const [chunk] = createDatabaseRestoreChunks(plan);
    await applyDatabaseRestoreChunk({
      db: d1,
      database: 'studio',
      request: {
        database: 'studio',
        restore_id: first.restoreId,
        artifact_digest: plan.artifactDigest,
        chunk_index: 0,
        table: chunk!.table,
        columns: chunk!.columns,
        rows: chunk!.rows,
      },
    });

    const restarted = await startDatabaseRestore({
      db: d1,
      database: 'studio',
      request: startRequest,
      initiator: TEST_INITIATOR,
    });
    await expect(readDatabaseRestoreInitiator(d1)).resolves.toEqual(
      TEST_INITIATOR,
    );
    expect(restarted.restoreId).not.toBe(first.restoreId);
    expect(database.prepare('SELECT COUNT(*) AS count FROM example').get())
      .toEqual({ count: 0 });
    const chunkRequest = {
      database: 'studio' as const,
      restore_id: restarted.restoreId,
      artifact_digest: plan.artifactDigest,
      chunk_index: 0,
      table: chunk!.table,
      columns: chunk!.columns,
      rows: chunk!.rows,
    };
    await applyDatabaseRestoreChunk({
      db: d1,
      database: 'studio',
      request: chunkRequest,
    });
    await expect(applyDatabaseRestoreChunk({
      db: d1,
      database: 'studio',
      request: chunkRequest,
    })).resolves.toMatchObject({ replayed: true, nextChunk: 1 });
  });

  it('rejects schema-only restore and data restore against drifted schema', async () => {
    await expect(createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(
        await dataArtifact({ mode: 'structure_only' }),
      ),
    )).rejects.toMatchObject({ issue: 'unsupported_restore_mode' });

    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE example (id INTEGER PRIMARY KEY, changed TEXT);
      CREATE INDEX idx_example_value ON example (changed);
    `);
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(await dataArtifact()),
    );
    await expect(startDatabaseRestore({
      db: sqliteD1(database),
      database: 'studio',
      request: {
        database: 'studio',
        manifest: plan.manifest,
        manifest_sha256: plan.footer.manifest_sha256,
        artifact_digest: plan.artifactDigest,
        artifact_statement_count: plan.footer.statement_count,
        expected_chunk_count: plan.chunkCount,
        table_statements: [],
        secondary_statements: [],
        confirmation: 'RESTORE DATABASE',
      },
    })).rejects.toMatchObject({ issue: 'schema_mismatch' });
  });

  it('round-trips the complete trigger-bearing Studio baseline', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(readFileSync(
      new URL('../../../database/install/001_baseline.sql', import.meta.url),
      'utf8',
    ));
    database.prepare(`
      INSERT INTO zeropress_schema_state (
        id, schema_version, lifecycle_state, target_schema_version,
        active_operation_id, updated_at_iso
      ) VALUES (1, ?, 'ready', NULL, NULL, '2026-08-03T00:00:00.000Z')
    `).run(STUDIO_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO content_search_index_state (
        id, state, reason, phase, operation_id,
        post_public_id_cursor, page_public_id_cursor,
        processed_posts, processed_pages, total_posts, total_pages,
        started_at_iso, updated_at_iso
      ) VALUES (
        1, 'ready', NULL, NULL, NULL,
        0, 0, 0, 0, 0, 0, NULL,
        '2026-08-03T00:00:00.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO roles (
        key, name, description, is_system, created_at_iso, updated_at_iso
      ) VALUES (
        'admin', 'Administrator', 'Full access.', 1,
        '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
      )
    `).run();
    database.exec(`
      INSERT INTO site_settings (key, value, type, updated_at_iso) VALUES
        ('site_media_origin', 'https://media.example', 'string',
          '2026-08-03T00:00:00.000Z'),
        ('site_media_delivery_mode', 'none', 'string',
          '2026-08-03T00:00:00.000Z'),
        ('site_media_revision', '${'a'.repeat(32)}', 'string',
          '2026-08-03T00:00:00.000Z'),
        ('site_branding_revision', '${'b'.repeat(32)}', 'string',
          '2026-08-03T00:00:00.000Z');
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (
        '${'c'.repeat(32)}', 'image', 'logo.svg', 'image/svg+xml', 'r2',
        'uploads/2026/08/logo.svg', NULL, NULL, NULL, NULL, NULL, '',
        '${'d'.repeat(32)}', '2026-08-03T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z'
      );
      INSERT INTO site_assets (
        slot, media_id, alt_text, updated_by, updated_at_iso
      ) VALUES (
        'logo', '${'c'.repeat(32)}', 'Example', NULL,
        '2026-08-03T00:00:00.000Z'
      );
    `);
    database.prepare('INSERT INTO auth_rate_limits VALUES (?, ?, ?, ?)')
      .run('totp_account', 'f'.repeat(64), 10, 2_000_000_000);
    const d1 = sqliteD1(database);
    const backup = await exportDatabaseBackup({
      db: d1,
      database: 'studio',
      mode: 'structure_and_data',
      now: new Date('2026-08-03T00:01:00.000Z'),
    });
    database.prepare(`
      INSERT INTO post_search_fts (
        rowid, revision, title, slug, excerpt, body
      ) VALUES (123, ?, 'Derived title', 'derived-title', '', 'Derived body')
    `).run('e'.repeat(32));
    const backupWithDerivedRow = await exportDatabaseBackup({
      db: d1,
      database: 'studio',
      mode: 'structure_and_data',
      now: new Date('2026-08-03T00:01:01.000Z'),
    });
    const inspection = await inspectDatabaseBackupArtifact(
      backupWithDerivedRow.sql,
    );
    expect(backupWithDerivedRow.manifest.format_version).toBe(2);
    if (backupWithDerivedRow.manifest.format_version !== 2) {
      throw new TypeError('Expected a format-v2 Studio backup.');
    }
    expect(backupWithDerivedRow.manifest.managed_virtual_tables.map(
      ({ name }) => name,
    )).toEqual(['page_search_fts', 'post_search_fts']);
    expect(backupWithDerivedRow.manifest.tables.some(({ name }) =>
      name.includes('_search_fts'))).toBe(false);
    expect(inspection.statements).toContainEqual(expect.stringMatching(
      /^CREATE VIRTUAL TABLE post_search_fts USING fts5/u,
    ));
    expect(inspection.statements.some((statement) =>
      /^INSERT INTO "?(?:post|page)_search_fts/u.test(statement)
      || /_search_fts_(?:config|content|data|docsize|idx)/u.test(statement)
    )).toBe(false);
    expect(inspection.statements).toContainEqual(expect.stringMatching(
      /INSERT INTO "content_search_index_state"[\s\S]*'rebuild_required'[\s\S]*'database_restore'/u,
    ));
    expect(backup.sql).toContain('CREATE TRIGGER trg_posts_featured_image_insert');

    database.prepare(`
      INSERT INTO roles (
        key, name, description, is_system, created_at_iso, updated_at_iso
      ) VALUES (
        'temporary', 'Temporary', 'Temporary role.', 0,
        '2026-08-03T00:02:00.000Z', '2026-08-03T00:02:00.000Z'
      )
    `).run();
    database.exec('DELETE FROM auth_rate_limits');
    await restoreArtifact({
      db: d1,
      database: 'studio',
      sql: backupWithDerivedRow.sql,
    });

    expect(database.prepare('SELECT * FROM auth_rate_limits').all()).toEqual([{
      scope: 'totp_account', subject_hash: 'f'.repeat(64), attempt_count: 10, reset_at: 2_000_000_000,
    }]);
    expect(database.prepare('SELECT key FROM roles ORDER BY key').all())
      .toEqual([{ key: 'admin' }]);
    expect(database.prepare(`
      SELECT slot, media_id, alt_text FROM site_assets
    `).get()).toEqual({
      slot: 'logo',
      media_id: 'c'.repeat(32),
      alt_text: 'Example',
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type = 'trigger'
    `).get()).toEqual({ count: 21 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM post_search_fts').get())
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT state, reason, processed_posts, processed_pages
      FROM content_search_index_state WHERE id = 1
    `).get()).toEqual({
      state: 'rebuild_required',
      reason: 'database_restore',
      processed_posts: 0,
      processed_pages: 0,
    });
  });

  it('rejects unrecognized virtual tables during export and artifact inspection', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT);
      CREATE VIRTUAL TABLE rogue_search USING fts5(value);
    `);
    await expect(exportDatabaseBackup({
      db: sqliteD1(database),
      database: 'studio',
      mode: 'structure_and_data',
    })).rejects.toThrow(/unsupported virtual table/u);

    const virtualSql = 'CREATE VIRTUAL TABLE rogue_search USING fts5(value)';
    const manifest = {
      format: 'zeropress-studio-sql-backup' as const,
      format_version: 2 as const,
      database: 'studio' as const,
      mode: 'structure_and_data' as const,
      exported_at_iso: '2026-08-03T00:00:00.000Z',
      schema_fingerprint: await createSchemaFingerprint([
        tableObject,
        {
          type: 'table',
          name: 'rogue_search',
          table_name: 'rogue_search',
          sql: virtualSql,
        },
      ]),
      studio_schema_version: STUDIO_SCHEMA_VERSION,
      schema_objects: [
        { type: 'table' as const, name: 'example', table_name: 'example' },
        {
          type: 'table' as const,
          name: 'rogue_search',
          table_name: 'rogue_search',
        },
      ],
      tables: [{ name: 'example', row_count: 0 }],
      managed_virtual_tables: [{
        name: 'rogue_search',
        module: 'fts5' as const,
        shadow_tables: [
          'rogue_search_config',
          'rogue_search_content',
          'rogue_search_data',
          'rogue_search_docsize',
          'rogue_search_idx',
        ],
      }],
    } satisfies DatabaseBackupManifest;
    const statements = [
      'PRAGMA defer_foreign_keys = TRUE',
      tableObject.sql,
      virtualSql,
    ];
    const artifact = serializeDatabaseBackupArtifact({
      manifest,
      statements,
      footer: {
        manifest_sha256: await createManifestSha256(manifest),
        statement_count: statements.length,
        statement_chain_sha256: await createStatementChainSha256(statements),
      },
    });
    await expect(inspectDatabaseBackupArtifact(artifact)).rejects.toMatchObject({
      issue: 'invalid_artifact',
    });
  });

  it('round-trips a row larger than the D1 SQL statement limit through bindings', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`${tableObject.sql}; ${indexObject.sql};`);
    const content = `large:${'한글-content '.repeat(12_000)}`;
    database.prepare('INSERT INTO example (id, value) VALUES (1, ?)')
      .run(content);
    const d1 = sqliteD1(database);
    const backup = await exportDatabaseBackup({
      db: d1,
      database: 'studio',
      mode: 'structure_and_data',
      now: new Date('2026-08-03T00:00:00.000Z'),
    });
    expect(new TextEncoder().encode(backup.sql).byteLength).toBeGreaterThan(
      100_000,
    );
    database.prepare('UPDATE example SET value = ? WHERE id = 1')
      .run('changed');
    await restoreArtifact({ db: d1, database: 'studio', sql: backup.sql });
    expect(database.prepare('SELECT value FROM example WHERE id = 1').get())
      .toEqual({ value: content });
  });

  it('rolls back a failed data chunk without advancing its journal', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE example (id INTEGER PRIMARY KEY);
      INSERT INTO example (id) VALUES (9);
    `);
    const statements = [
      'PRAGMA defer_foreign_keys = TRUE',
      'DELETE FROM "example"',
      'INSERT INTO "example" ("id") VALUES (1), (1)',
    ];
    const restoredSchema = {
      type: 'table' as const,
      name: 'example',
      table_name: 'example',
      sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY)',
    };
    const manifest: DatabaseBackupManifest = {
      format: 'zeropress-studio-sql-backup',
      format_version: 1,
      database: 'edge',
      mode: 'data_only',
      exported_at_iso: '2026-08-03T00:00:00.000Z',
      schema_fingerprint: await createSchemaFingerprint([restoredSchema]),
      studio_schema_version: null,
      schema_objects: [{
        type: 'table',
        name: 'example',
        table_name: 'example',
      }],
      tables: [{ name: 'example', row_count: 2 }],
    };
    const sql = serializeDatabaseBackupArtifact({
      manifest,
      statements,
      footer: {
        manifest_sha256: await createManifestSha256(manifest),
        statement_count: statements.length,
        statement_chain_sha256: await createStatementChainSha256(statements),
      },
    });

    const d1 = sqliteD1(database);
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(sql),
    );
    const started = await startDatabaseRestore({
      db: d1,
      database: 'edge',
      request: {
        database: 'edge',
        manifest: plan.manifest,
        manifest_sha256: plan.footer.manifest_sha256,
        artifact_digest: plan.artifactDigest,
        artifact_statement_count: plan.footer.statement_count,
        expected_chunk_count: plan.chunkCount,
        table_statements: [],
        secondary_statements: [],
        confirmation: 'RESTORE DATABASE',
      },
    });
    const [chunk] = createDatabaseRestoreChunks(plan);
    await expect(applyDatabaseRestoreChunk({
      db: d1,
      database: 'edge',
      request: {
        database: 'edge',
        restore_id: started.restoreId,
        artifact_digest: plan.artifactDigest,
        chunk_index: 0,
        table: chunk!.table,
        columns: chunk!.columns,
        rows: chunk!.rows,
      },
    })).rejects.toThrow(/UNIQUE constraint failed/u);
    expect(database.prepare('SELECT id FROM example').all()).toEqual([]);
    expect(database.prepare(`
      SELECT next_chunk FROM zeropress_restore_journal
    `).get()).toEqual({ next_chunk: 0 });
  });
});
