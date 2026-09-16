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
} from './database-backup';

const schemaObject: FingerprintedSchemaObject = {
  type: 'table',
  name: 'example',
  table_name: 'example',
  sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)',
};

async function artifact(input: {
  mode?: DatabaseBackupManifest['mode'];
  statements?: string[];
} = {}) {
  const mode = input.mode ?? 'structure_and_data';
  const statements = input.statements ?? [
    'PRAGMA defer_foreign_keys = TRUE',
    'DROP TABLE IF EXISTS "example"',
    schemaObject.sql,
    'INSERT INTO "example" ("id", "value") VALUES (1, \'one;two\')',
  ];
  const manifest: DatabaseBackupManifest = {
    format: 'zeropress-studio-sql-backup',
    format_version: 1,
    database: 'studio',
    mode,
    exported_at_iso: '2026-08-03T00:00:00.000Z',
    schema_fingerprint: await createSchemaFingerprint([schemaObject]),
    studio_schema_version: 1,
    schema_objects: [{
      type: 'table',
      name: 'example',
      table_name: 'example',
    }],
    tables: [{ name: 'example', row_count: mode === 'structure_only' ? 0 : 1 }],
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

describe('ZeroPress SQL backup artifact', () => {
  it('round-trips a reviewed full backup with SQL string semicolons', async () => {
    const sql = await artifact();
    const inspection = await inspectDatabaseBackupArtifact(sql);

    expect(inspection.manifest.database).toBe('studio');
    expect(inspection.manifest.mode).toBe('structure_and_data');
    expect(inspection.statements).toHaveLength(4);
    expect(inspection.statements[3]).toContain("'one;two'");
  });

  it('accepts export-only structure and exact-schema data artifacts', async () => {
    const structureStatements = [
      'PRAGMA defer_foreign_keys = TRUE',
      'DROP TABLE IF EXISTS "example"',
      schemaObject.sql,
    ];
    await expect(inspectDatabaseBackupArtifact(await artifact({
      mode: 'structure_only',
      statements: structureStatements,
    }))).resolves.toMatchObject({
      manifest: { mode: 'structure_only' },
    });

    const dataStatements = [
      'PRAGMA defer_foreign_keys = TRUE',
      'DELETE FROM "example"',
      'INSERT INTO "example" ("id", "value") VALUES (1, \'value\')',
    ];
    await expect(inspectDatabaseBackupArtifact(await artifact({
      mode: 'data_only',
      statements: dataStatements,
    }))).resolves.toMatchObject({
      manifest: { mode: 'data_only' },
    });
  });

  it('rejects tampering, arbitrary statements, and schema drift', async () => {
    const valid = await artifact();
    await expect(inspectDatabaseBackupArtifact(
      valid.replace("'one;two'", "'changed'"),
    )).rejects.toMatchObject({ issue: 'invalid_artifact' });

    await expect(inspectDatabaseBackupArtifact(await artifact({
      statements: [
        'PRAGMA defer_foreign_keys = TRUE',
        'ATTACH DATABASE \'other\' AS other',
      ],
    }))).rejects.toMatchObject({ issue: 'invalid_artifact' });

    await expect(inspectDatabaseBackupArtifact(await artifact({
      statements: [
        'PRAGMA defer_foreign_keys = TRUE',
        'DROP TABLE IF EXISTS "example"',
        'CREATE TABLE example (id INTEGER PRIMARY KEY, changed TEXT)',
      ],
    }))).rejects.toMatchObject({ issue: 'invalid_artifact' });
  });

  it('plans large rows and canonical text/blob literals without a restore-derived SQL limit', async () => {
    const content = `prefix ${'x'.repeat(120_000)} suffix`;
    const sql = await artifact({
      statements: [
        'PRAGMA defer_foreign_keys = TRUE',
        'DROP TABLE IF EXISTS "example"',
        schemaObject.sql,
        `INSERT INTO "example" ("id", "value") VALUES (1, '${content}')`,
      ],
    });
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(sql),
    );
    expect(plan.tables[0]?.rows[0]?.[1]).toBe(content);
    expect(plan.chunkCount).toBe(1);

    const encodedSql = await artifact({
      statements: [
        'PRAGMA defer_foreign_keys = TRUE',
        'DROP TABLE IF EXISTS "example"',
        schemaObject.sql,
        'INSERT INTO "example" ("id", "value") VALUES (1, CAST(X\'610062\' AS TEXT))',
      ],
    });
    const encodedPlan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(encodedSql),
    );
    expect(encodedPlan.tables[0]?.rows[0]?.[1]).toBe('a\u0000b');
  });

  it('orders Page parents before children across restore chunks', async () => {
    const pageSchema: FingerprintedSchemaObject = {
      type: 'table',
      name: 'pages',
      table_name: 'pages',
      sql: 'CREATE TABLE pages (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES pages(id))',
    };
    const pairs = Array.from({ length: 25 }, (_, index) => {
      const root = (index + 1).toString(16).padStart(32, '0');
      const child = (index + 101).toString(16).padStart(32, '0');
      return { root, child };
    });
    const tuples = [
      ...pairs.map(({ root, child }) => `('${child}', '${root}')`),
      ...pairs.map(({ root }) => `('${root}', NULL)`),
    ].join(', ');
    const statements = [
      'PRAGMA defer_foreign_keys = TRUE',
      'DROP TABLE IF EXISTS "pages"',
      pageSchema.sql,
      `INSERT INTO "pages" ("id", "parent_id") VALUES ${tuples}`,
    ];
    const manifest: DatabaseBackupManifest = {
      format: 'zeropress-studio-sql-backup',
      format_version: 1,
      database: 'studio',
      mode: 'structure_and_data',
      exported_at_iso: '2026-08-09T00:00:00.000Z',
      schema_fingerprint: await createSchemaFingerprint([pageSchema]),
      studio_schema_version: 8,
      schema_objects: [{
        type: 'table',
        name: 'pages',
        table_name: 'pages',
      }],
      tables: [{ name: 'pages', row_count: 50 }],
    };
    const sql = await serializeDatabaseBackupArtifact({
      manifest,
      statements,
      footer: {
        manifest_sha256: await createManifestSha256(manifest),
        statement_count: statements.length,
        statement_chain_sha256: await createStatementChainSha256(statements),
      },
    });
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(sql),
    );
    const chunks = createDatabaseRestoreChunks(plan);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.rows.length <= 40)).toBe(true);
    const restoredIds = chunks.flatMap((chunk) =>
      chunk.rows.map((row) => String(row[0])));
    for (const { root, child } of pairs) {
      expect(restoredIds.indexOf(root)).toBeLessThan(restoredIds.indexOf(child));
    }
  });
});
