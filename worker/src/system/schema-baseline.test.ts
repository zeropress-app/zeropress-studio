import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import baselineSql from '../../../database/install/001_baseline.sql?raw';
import { splitSqlStatements } from '../../../contracts/sql-statements';

function execute(database: DatabaseSync, sql: string) {
  for (const statement of splitSqlStatements(sql)) {
    database.exec(`${statement};`);
  }
}

function catalog(database: DatabaseSync) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('Studio fresh-install baseline', () => {
  it('keeps the complete current contract in the fresh-install baseline', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    execute(database, baselineSql);

    const requiredObjects = [
      'content_search_index_state',
      'edge_comment_target_projection_outbox',
      'media_collections',
      'page_search_fts',
      'post_search_fts',
      'site_assets',
      'site_custom_code',
      'studio_settings',
    ];
    const names = catalog(database).map((row) => (
      row as { name: string }
    ).name);

    for (const objectName of requiredObjects) {
      expect(names).toContain(objectName);
    }
    expect(database.prepare('PRAGMA table_xinfo(media)').all()).toContainEqual(
      expect.objectContaining({ name: 'ai_generation_json', notnull: 0 }),
    );
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM content_search_index_state
    `).get()).toEqual({ count: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts bounded image provenance and rejects malformed storage states', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    execute(database, baselineSql);
    const generation = JSON.stringify({
      version: 1,
      model: '@cf/black-forest-labs/flux-2-klein-4b',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape',
      seed: 42,
    });
    const insert = database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt,
        revision, created_at_iso, updated_at_iso, ai_generation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1234, ?, ?, NULL, '', ?, ?, ?, ?)
    `);
    expect(() => insert.run(
      '3'.repeat(32),
      'image',
      'generated.png',
      'image/png',
      'r2',
      `uploads/2026/08/${'3'.repeat(32)}.png`,
      null,
      1024,
      576,
      '4'.repeat(32),
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
      generation,
    )).not.toThrow();
    expect(() => insert.run(
      '5'.repeat(32),
      'image',
      'external.png',
      'image/png',
      'external',
      null,
      'https://media.example/external.png',
      1024,
      576,
      '6'.repeat(32),
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
      generation,
    )).toThrow();
    expect(() => insert.run(
      '7'.repeat(32),
      'image',
      'invalid.png',
      'image/png',
      'r2',
      `uploads/2026/08/${'7'.repeat(32)}.png`,
      null,
      1024,
      576,
      '8'.repeat(32),
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
      '{invalid',
    )).toThrow();
  });
});
