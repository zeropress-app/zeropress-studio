import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  materializeRoutingSettingsDefaults,
  ROUTING_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/routing-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  listRoutingPageOptions,
  readRoutingSettings,
  repairRoutingSettings,
  RoutingSettingsIncompleteError,
  updateRoutingSettings,
} from './routing-settings-repository';

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

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return row ?? null;
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
        for (const statement of statements) results.push(await statement.run());
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

const USER_ID = '1'.repeat(32);
const PUBLISHED_PAGE_ID = '2'.repeat(32);
const CHILD_PAGE_ID = '3'.repeat(32);
const DRAFT_PAGE_ID = '4'.repeat(32);
const NOW = new Date('2026-08-01T05:00:00.000Z');

function seedUser(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(
    USER_ID,
    'owner@example.com',
    'password-hash',
    'a'.repeat(32),
    'Studio Owner',
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function seedPage(input: {
  database: DatabaseSync;
  id: string;
  publicId: number;
  title: string;
  slug: string;
  status: 'draft' | 'published';
  parentId?: string;
}) {
  input.database.prepare(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type,
      excerpt, status, discoverability, allow_comments, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, '', 'markdown', '', ?, 'default', 0, ?, ?, ?)
  `).run(
    input.id,
    input.publicId,
    input.parentId ?? null,
    input.title,
    input.slug,
    input.status,
    'b'.repeat(32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

describe('routing settings D1 repository', () => {
  it('materializes Build Core defaults without writing rows', async () => {
    const { database, d1 } = createTestDatabase();
    await expect(readRoutingSettings({ db: d1 })).resolves.toEqual({
      settings: materializeRoutingSettingsDefaults(),
      revision: ROUTING_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 0 });
  });

  it('writes one canonical revision document and rejects stale updates', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const defaults = materializeRoutingSettingsDefaults();
    const settings = {
      ...defaults,
      permalinks: {
        ...defaults.permalinks,
        output_style: 'html-extension' as const,
        posts: '/journal/:year/:slug/',
      },
      post_index: { enabled: true, path: '/journal/', paginate: false },
    };
    await expect(updateRoutingSettings({
      db: d1,
      settings,
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => 'c'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      document: {
        settings,
        revision: 'c'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT value, type FROM site_settings WHERE key = 'site_permalinks'
    `).get()).toEqual({
      value: JSON.stringify(settings.permalinks),
      type: 'json',
    });
    await expect(readRoutingSettings({ db: d1 })).resolves.toMatchObject({
      settings,
      revision: 'c'.repeat(32),
    });
    await expect(updateRoutingSettings({
      db: d1,
      settings: { ...settings, post_index: { ...settings.post_index, paginate: true } },
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => 'd'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('accepts only an existing published Page as Front Page', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    seedPage({
      database,
      id: PUBLISHED_PAGE_ID,
      publicId: 100_000_000_001,
      title: 'Home',
      slug: 'home',
      status: 'published',
    });
    seedPage({
      database,
      id: DRAFT_PAGE_ID,
      publicId: 100_000_000_002,
      title: 'Draft Home',
      slug: 'draft-home',
      status: 'draft',
    });
    const defaults = materializeRoutingSettingsDefaults();
    for (const pageId of [DRAFT_PAGE_ID, 'f'.repeat(32)]) {
      await expect(updateRoutingSettings({
        db: d1,
        settings: {
          ...defaults,
          front_page: { type: 'page', page_id: pageId },
          post_index: { ...defaults.post_index, path: '/blog/' },
        },
        expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
        updatedBy: USER_ID,
      })).resolves.toEqual({ kind: 'front_page_not_found' });
    }
    await expect(updateRoutingSettings({
      db: d1,
      settings: {
        ...defaults,
        front_page: { type: 'page', page_id: PUBLISHED_PAGE_ID },
        post_index: { ...defaults.post_index, path: '/blog/' },
      },
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => 'e'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });
  });

  it('stores a standalone Front Page verbatim without resolving a Page', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const defaults = materializeRoutingSettingsDefaults();
    const html = '  <!doctype html>\n<html><title>Standalone</title></html>\n';
    const settings = {
      ...defaults,
      front_page: { type: 'standalone_html' as const, html },
      post_index: { ...defaults.post_index, path: '/blog/' },
    };
    await expect(updateRoutingSettings({
      db: d1,
      settings,
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '9'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      document: { settings },
    });
    await expect(readRoutingSettings({ db: d1 })).resolves.toMatchObject({
      settings,
    });
    expect(database.prepare(`
      SELECT value FROM site_settings WHERE key = 'site_front_page'
    `).get()).toEqual({ value: JSON.stringify(settings.front_page) });
  });

  it('returns bounded published Page options with hierarchy search and selected retention', async () => {
    const { database, d1 } = createTestDatabase();
    seedPage({
      database,
      id: PUBLISHED_PAGE_ID,
      publicId: 100_000_000_001,
      title: 'Documentation',
      slug: 'docs',
      status: 'published',
    });
    seedPage({
      database,
      id: CHILD_PAGE_ID,
      publicId: 100_000_000_002,
      title: 'Install',
      slug: 'install',
      status: 'published',
      parentId: PUBLISHED_PAGE_ID,
    });
    seedPage({
      database,
      id: DRAFT_PAGE_ID,
      publicId: 100_000_000_003,
      title: 'Hidden',
      slug: 'hidden',
      status: 'draft',
    });
    await expect(listRoutingPageOptions({
      db: d1,
      search: 'docs/install',
      selectedPageId: PUBLISHED_PAGE_ID,
    })).resolves.toEqual([{
      id: PUBLISHED_PAGE_ID,
      title: 'Documentation',
      path: 'docs',
    }, {
      id: CHILD_PAGE_ID,
      title: 'Install',
      path: 'docs/install',
    }]);
  });

  it('fails closed for partial and non-canonical stored documents', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO site_settings (key, value, type, updated_at_iso)
      VALUES ('site_front_page', '{"type":"theme_index"}', 'json', ?)
    `).run(NOW.toISOString());
    await expect(readRoutingSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_ROUTING_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });

  it('repairs a missing routing group atomically without replacing valid groups', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const defaults = materializeRoutingSettingsDefaults();
    const settings = {
      ...defaults,
      permalinks: {
        ...defaults.permalinks,
        posts: '/journal/:slug/',
      },
      post_index: { enabled: true, path: '/journal/', paginate: false },
    };
    await updateRoutingSettings({
      db: d1,
      settings,
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '7'.repeat(32),
    });
    database.prepare(`
      DELETE FROM site_settings WHERE key = 'site_permalinks'
    `).run();

    let recovery: RoutingSettingsIncompleteError['recovery'];
    try {
      await readRoutingSettings({ db: d1 });
      throw new Error('Expected incomplete routing settings.');
    } catch (error) {
      expect(error).toBeInstanceOf(RoutingSettingsIncompleteError);
      recovery = (error as RoutingSettingsIncompleteError).recovery;
    }
    expect(recovery).toEqual({
      expected_revision: '7'.repeat(32),
      missing_fields: ['permalinks'],
      proposed_settings: {
        ...settings,
        permalinks: defaults.permalinks,
      },
    });

    const repairedAt = new Date('2026-08-01T05:05:00.000Z');
    await expect(repairRoutingSettings({
      db: d1,
      expectedRevision: recovery.expected_revision,
      missingFields: recovery.missing_fields,
      updatedBy: USER_ID,
      now: repairedAt,
      createRevision: () => '8'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      document: {
        settings: {
          ...settings,
          permalinks: defaults.permalinks,
        },
        revision: '8'.repeat(32),
        updated_at_iso: repairedAt.toISOString(),
      },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT updated_at_iso) AS timestamps
      FROM site_settings
      WHERE key IN (
        'site_permalinks', 'site_front_page', 'site_post_index',
        'site_routing_revision'
      )
    `).get()).toEqual({ count: 4, timestamps: 1 });
    await expect(readRoutingSettings({ db: d1 })).resolves.toMatchObject({
      settings: {
        ...settings,
        permalinks: defaults.permalinks,
      },
      revision: '8'.repeat(32),
    });
  });
});
