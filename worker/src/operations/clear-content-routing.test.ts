import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';
import { readRoutingSettings } from '../settings/routing-settings-repository';
import { clearSiteContent } from './database-operations';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (...params: unknown[]) => SqliteRunResult
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...params: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*SELECT\b/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function createTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
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
  return { database, d1 };
}

const ADMINISTRATOR_ID = '1'.repeat(32);
const FRONT_PAGE_ID = '2'.repeat(32);
const NOW_ISO = '2026-08-01T06:00:00.000Z';

function seedUserAndFrontPage(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, name, status, email_verified,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'hash', 'Studio Owner', 'active', 1, ?, ?)
  `).run(ADMINISTRATOR_ID, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT INTO pages (
      id, public_id, title, slug, status, created_at_iso, updated_at_iso
    ) VALUES (?, 100000000001, 'Home', 'home', 'published', ?, ?)
  `).run(FRONT_PAGE_ID, NOW_ISO, NOW_ISO);
}

describe('Clear Content routing integrity', () => {
  it('preserves URL policy while atomically returning a deleted Front Page to the theme index', async () => {
    const { database, d1 } = createTestDatabase();
    seedUserAndFrontPage(database);
    const settings = materializeRoutingSettingsDefaults();
    settings.permalinks.output_style = 'html-extension';
    settings.permalinks.posts = '/journal/:public_id/';
    settings.front_page = { type: 'page', page_id: FRONT_PAGE_ID };
    settings.post_index = {
      enabled: true,
      path: '/journal/',
      paginate: false,
    };
    const previousRevision = 'a'.repeat(32);
    const nextRevision = 'b'.repeat(32);
    const rows = [
      ['site_permalinks', JSON.stringify(settings.permalinks), 'json'],
      ['site_front_page', JSON.stringify(settings.front_page), 'json'],
      ['site_post_index', JSON.stringify(settings.post_index), 'json'],
      ['site_routing_revision', previousRevision, 'string'],
    ] as const;
    const insert = database.prepare(`
      INSERT INTO site_settings (
        key, value, type, updated_by, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(...row, ADMINISTRATOR_ID, NOW_ISO);
    }

    const result = await clearSiteContent({
      db: d1,
      administratorId: ADMINISTRATOR_ID,
      now: new Date('2026-08-01T07:00:00.000Z'),
      createRevision: () => nextRevision,
    });

    expect(result.deletedRows.pages).toBe(1);
    expect(result.updatedRows).toEqual({ site_settings: 4 });
    expect((database.prepare(
      'SELECT COUNT(*) AS row_count FROM pages',
    ).get() as { row_count: number }).row_count).toBe(0);
    await expect(readRoutingSettings({ db: d1 })).resolves.toEqual({
      settings: {
        permalinks: settings.permalinks,
        front_page: { type: 'theme_index' },
        post_index: settings.post_index,
      },
      revision: nextRevision,
      updated_at_iso: '2026-08-01T07:00:00.000Z',
    });
  });

  it('does not materialize routing defaults when Clear Content has no routing document', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, name, status, email_verified,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'owner@example.com', 'hash', 'Studio Owner', 'active', 1, ?, ?)
    `).run(ADMINISTRATOR_ID, NOW_ISO, NOW_ISO);

    const result = await clearSiteContent({
      db: d1,
      administratorId: ADMINISTRATOR_ID,
      createRevision: () => 'c'.repeat(32),
    });

    expect(result.updatedRows).toEqual({});
    expect((database.prepare(`
      SELECT COUNT(*) AS row_count FROM site_settings
      WHERE key IN (
        'site_permalinks', 'site_front_page',
        'site_post_index', 'site_routing_revision'
      )
    `).get() as { row_count: number }).row_count).toBe(0);
  });

  it('queues uploads and imported R2 objects while preserving external objects', async () => {
    const { database, d1 } = createTestDatabase();
    const insert = database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'document', ?, 'application/pdf', ?, ?, ?, 1024,
        NULL, NULL, NULL, '', ?, ?, ?)
    `);
    insert.run(
      '3'.repeat(32),
      'uploaded.pdf',
      'r2',
      'uploads/2026/08/uploaded.pdf',
      null,
      '6'.repeat(32),
      NOW_ISO,
      NOW_ISO,
    );
    insert.run(
      '4'.repeat(32),
      'imported.pdf',
      'r2',
      'imported/2026/08/imported.pdf',
      null,
      '7'.repeat(32),
      NOW_ISO,
      NOW_ISO,
    );
    insert.run(
      '5'.repeat(32),
      'external.pdf',
      'external',
      null,
      'https://media.example/external.pdf',
      '8'.repeat(32),
      NOW_ISO,
      NOW_ISO,
    );

    const result = await clearSiteContent({
      db: d1,
      administratorId: ADMINISTRATOR_ID,
      now: new Date('2026-08-01T07:00:00.000Z'),
    });

    expect(result.insertedRows).toEqual({ media_object_deletions: 2 });
    expect(database.prepare(`
      SELECT storage_key FROM media_object_deletions ORDER BY storage_key
    `).all()).toEqual([
      { storage_key: 'imported/2026/08/imported.pdf' },
      { storage_key: 'uploads/2026/08/uploaded.pdf' },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS row_count FROM media').get())
      .toEqual({ row_count: 0 });
  });
});
