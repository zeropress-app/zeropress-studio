import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MENU_IDS, MENU_MAX_COUNT, type MenuItem } from '../../../contracts/menus';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createMenu,
  deleteMenu,
  listMenus,
  listPreviewMenus,
  resolveMenuReferences,
  resolvePreviewMenus,
  saveMenu,
} from './menu-repository';

type SqliteRunResult = { changes: number | bigint };
type TestHooks = { beforeMenuSave?: () => void };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
    readonly hooks: TestHooks = {},
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params, this.hooks);
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.sql.includes('write_guard') && this.hooks.beforeMenuSave) {
      const beforeSave = this.hooks.beforeMenuSave;
      delete this.hooks.beforeMenuSave;
      beforeSave();
    }
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

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function createTestDatabase(hooks: TestHooks = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql, [], hooks);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
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

const NOW = new Date('2026-08-01T08:00:00.000Z');
const POST_ID = '1'.repeat(32);
const PAGE_ID = '2'.repeat(32);
const CATEGORY_ID = '3'.repeat(32);
const TAG_ID = '4'.repeat(32);

function seedReferences(database: DatabaseSync) {
  const now = NOW.toISOString();
  database.prepare(`
    INSERT INTO authors (id, display_name, revision, created_at_iso, updated_at_iso)
    VALUES ('Owner', 'Studio Owner', ?, ?, ?)
  `).run('a'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO posts (
      id, public_id, title, slug, content, document_type, excerpt, status,
      author_id, discoverability, allow_comments, published_at_iso, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, 100000000001, 'Post', 'post.v0.7', '', 'markdown', '',
      'draft', 'Owner', 'default', 1, NULL, ?, ?, ?)
  `).run(POST_ID, 'b'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type, excerpt,
      status, discoverability, allow_comments, revision, created_at_iso,
      updated_at_iso
    ) VALUES (?, 100000000001, NULL, 'Docs', 'docs', '', 'markdown', '',
      'published', 'default', 0, ?, ?, ?)
  `).run(PAGE_ID, 'c'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO categories (
      id, name, slug, description, revision, created_at_iso, updated_at_iso
    ) VALUES (?, 'News', 'news', '', ?, ?, ?)
  `).run(CATEGORY_ID, 'd'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO tags (
      id, name, slug, description, revision, created_at_iso, updated_at_iso
    ) VALUES (?, 'Featured', 'featured', '', ?, ?, ?)
  `).run(TAG_ID, 'e'.repeat(32), now, now);
}

function customItem(id = 'f'.repeat(32)): MenuItem {
  return {
    id,
    title: 'External',
    link: { kind: 'custom', url: 'https://example.com/docs' },
    target: '_blank',
    meta: { badge: 'New', priority: 1 },
    children: [],
  };
}

function storedMenu(database: DatabaseSync, menuId: string) {
  return database.prepare('SELECT * FROM menus WHERE menu_id = ?').get(menuId);
}

function insertEmptyMenu(database: DatabaseSync, menuId: string, name = menuId) {
  database.prepare(`
    INSERT INTO menus (
      menu_id, name, enabled, items, revision, created_at_iso, updated_at_iso
    ) VALUES (?, ?, 1, '[]', ?, ?, ?)
  `).run(menuId, name, '1'.repeat(32), NOW.toISOString(), NOW.toISOString());
}

describe('Menu reference resolution', () => {
  it('resolves 500 exact references independently of search pages with bounded SQL parameters', async () => {
    const { database, d1 } = createTestDatabase();
    seedReferences(database);
    const insert = database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, content, document_type, excerpt, status,
        author_id, discoverability, allow_comments, revision, created_at_iso, updated_at_iso
      ) SELECT ?, ?, ?, ?, content, document_type, excerpt, status,
          author_id, discoverability, allow_comments, revision, created_at_iso, updated_at_iso
        FROM posts WHERE id = ?
    `);
    const references = Array.from({ length: 499 }, (_, index) => {
      const id = index.toString(16).padStart(32, '0');
      insert.run(id, 100000000002 + index, `A Post ${index}`, `post-${index}`, POST_ID);
      return { kind: 'post' as const, reference_id: id };
    });
    references.push({ kind: 'post', reference_id: POST_ID });
    const prepare = vi.spyOn(d1, 'prepare');
    const resolved = await resolveMenuReferences({ db: d1, references });
    expect(resolved).toHaveLength(500);
    expect(resolved.at(-1)).toEqual({
      kind: 'post', reference_id: POST_ID, status: 'available', title: 'Post', detail: 'post.v0.7',
    });
    expect(resolved.every((item) => item.status === 'available')).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(6);
    for (const [sql] of prepare.mock.calls) expect((sql.match(/\?/gu) ?? []).length).toBeLessThanOrEqual(90);
    expect(await listMenus({ db: d1 })).toEqual([]);
    database.close();
  });

  it('preserves typed identities and full nested Page paths', async () => {
    const { database, d1 } = createTestDatabase();
    seedReferences(database);
    database.prepare(`
      INSERT INTO pages (
        id, public_id, parent_id, title, slug, content, document_type, excerpt,
        status, discoverability, allow_comments, revision, created_at_iso, updated_at_iso
      ) SELECT ?, 100000000002, id, 'Guide', 'guide', content, document_type, excerpt,
          status, discoverability, allow_comments, revision, created_at_iso, updated_at_iso
        FROM pages WHERE id = ?
    `).run(POST_ID, PAGE_ID);
    const references = [
      { kind: 'post' as const, reference_id: POST_ID },
      { kind: 'page' as const, reference_id: POST_ID },
      { kind: 'category' as const, reference_id: CATEGORY_ID },
      { kind: 'tag' as const, reference_id: TAG_ID },
    ];
    expect(await resolveMenuReferences({ db: d1, references })).toEqual([
      { ...references[0], status: 'available', title: 'Post', detail: 'post.v0.7' },
      { ...references[1], status: 'available', title: 'Guide', detail: '/docs/guide/' },
      { ...references[2], status: 'available', title: 'News', detail: 'news' },
      { ...references[3], status: 'available', title: 'Featured', detail: 'featured' },
    ]);
    database.close();
  });

  it('only reports missing or Trash after checking the actual target row', async () => {
    const { database, d1 } = createTestDatabase();
    seedReferences(database);
    database.prepare("UPDATE posts SET status = 'trash' WHERE id = ?").run(POST_ID);
    database.prepare("UPDATE pages SET status = 'trash' WHERE id = ?").run(PAGE_ID);
    const references = [
      { kind: 'post' as const, reference_id: POST_ID },
      { kind: 'page' as const, reference_id: PAGE_ID },
      { kind: 'category' as const, reference_id: 'a'.repeat(32) },
      { kind: 'tag' as const, reference_id: 'b'.repeat(32) },
    ];
    expect(await resolveMenuReferences({ db: d1, references })).toEqual([
      { ...references[0], status: 'trash' },
      { ...references[1], status: 'trash' },
      { ...references[2], status: 'missing' },
      { ...references[3], status: 'missing' },
    ]);
    database.close();
  });

  it('does not turn a database failure into missing references', async () => {
    const db = { prepare: vi.fn(() => { throw new Error('database unavailable'); }) } as unknown as D1Database;
    await expect(resolveMenuReferences({
      db, references: [{ kind: 'post', reference_id: POST_ID }],
    })).rejects.toBeInstanceOf(StudioOperationalError);
  });
});

describe('Default menu persistence', () => {
  it.each(DEFAULT_MENU_IDS)('keeps reads empty and stores both defaults on the first %s save', async (menuId) => {
    const { database, d1 } = createTestDatabase();
    await expect(listMenus({ db: d1 })).resolves.toEqual([]);
    await expect(listPreviewMenus({ db: d1 })).resolves.toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM menus').get()?.count).toBe(0);

    const result = await saveMenu({
      db: d1, menuId, name: 'Site links', enabled: true,
      items: [customItem()], expectedRevision: null, now: NOW,
    });
    expect(result).toMatchObject({
      kind: 'completed', menus: expect.arrayContaining([
        expect.objectContaining({ menu_id: menuId, name: 'Site links', items: [customItem()] }),
        expect.objectContaining({
          menu_id: menuId === 'primary' ? 'footer' : 'primary',
          enabled: true, items: [],
        }),
      ]),
    });
    await expect(listMenus({ db: d1 })).resolves.toHaveLength(2);
  });

  it('saves empty defaults and can later revise one without modifying the other', async () => {
    const { database, d1 } = createTestDatabase();
    const request = {
      db: d1, menuId: 'primary', name: 'Primary Menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
      createRevision: () => '2'.repeat(32),
    };
    await saveMenu(request);
    const footerBefore = storedMenu(database, 'footer');
    const primaryBefore = storedMenu(database, 'primary');
    await saveMenu({ ...request, expectedRevision: '2'.repeat(32) });
    expect(storedMenu(database, 'primary')).toEqual(primaryBefore);
    await expect(saveMenu({
      ...request, name: 'Navigation', enabled: false,
      expectedRevision: '2'.repeat(32),
      now: new Date('2026-08-01T09:00:00Z'), createRevision: () => '3'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });
    expect(storedMenu(database, 'primary')).toMatchObject({
      name: 'Navigation', enabled: 0, revision: '3'.repeat(32),
    });
    expect(storedMenu(database, 'footer')).toEqual(footerBefore);
    await expect(listPreviewMenus({ db: d1 })).resolves.toMatchObject([
      { menu_id: 'footer', items: [] },
    ]);
  });

  it('preserves an imported counterpart including its disabled state, metadata, and revision', async () => {
    const { database, d1 } = createTestDatabase();
    await createMenu({
      db: d1, menuId: 'footer', name: 'Imported legal links', enabled: false,
      items: [customItem()], now: NOW, createRevision: () => '7'.repeat(32),
    });
    const before = storedMenu(database, 'footer');
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'Primary Menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
    })).resolves.toMatchObject({ kind: 'completed' });
    expect(storedMenu(database, 'footer')).toEqual(before);
  });

  it('fills a missing counterpart even when the selected saved menu has no changes', async () => {
    const { database, d1 } = createTestDatabase();
    insertEmptyMenu(database, 'primary', 'Existing primary');
    const before = storedMenu(database, 'primary');
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'Existing primary', enabled: true,
      items: [], expectedRevision: '1'.repeat(32), now: NOW,
    })).resolves.toMatchObject({ kind: 'completed' });
    expect(storedMenu(database, 'primary')).toEqual(before);
    expect(storedMenu(database, 'footer')).toMatchObject({ name: 'Footer Menu', items: '[]' });
  });

  it('stores missing defaults alongside an existing custom menu save', async () => {
    const { database, d1 } = createTestDatabase();
    insertEmptyMenu(database, 'custom', 'Custom');
    await expect(saveMenu({
      db: d1, menuId: 'custom', name: 'Custom links', enabled: true,
      items: [customItem()], expectedRevision: '1'.repeat(32), now: NOW,
    })).resolves.toMatchObject({ kind: 'completed', menus: expect.any(Array) });
    const saved = await listMenus({ db: d1 });
    expect(saved.map((menu) => menu.menu_id)).toEqual(['custom', 'footer', 'primary']);
    expect(saved.find((menu) => menu.menu_id === 'custom')?.items).toEqual([customItem()]);
  });

  it('rolls back the entire first save if one default fails to insert', async () => {
    const { database, d1 } = createTestDatabase();
    database.exec(`
      CREATE TRIGGER reject_footer BEFORE INSERT ON menus
      WHEN NEW.menu_id = 'footer'
      BEGIN SELECT RAISE(ABORT, 'Injected footer write failure'); END;
    `);
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'Navigation', enabled: true,
      items: [customItem()], expectedRevision: null, now: NOW,
    })).rejects.toMatchObject({ code: 'MENU_MANAGEMENT_DATABASE_WRITE_FAILED' });
    await expect(listMenus({ db: d1 })).resolves.toEqual([]);
  });

  it('does not partially update a saved menu when its missing counterpart fails', async () => {
    const { database, d1 } = createTestDatabase();
    insertEmptyMenu(database, 'primary');
    const before = storedMenu(database, 'primary');
    database.exec(`
      CREATE TRIGGER reject_footer BEFORE INSERT ON menus
      WHEN NEW.menu_id = 'footer'
      BEGIN SELECT RAISE(ABORT, 'Injected footer write failure'); END;
    `);
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'Changed', enabled: true,
      items: [customItem()], expectedRevision: '1'.repeat(32), now: NOW,
    })).rejects.toMatchObject({ code: 'MENU_MANAGEMENT_DATABASE_WRITE_FAILED' });
    expect(storedMenu(database, 'primary')).toEqual(before);
    expect(storedMenu(database, 'footer')).toBeUndefined();
  });

  it('rejects a competing first save without creating the other default', async () => {
    const hooks: TestHooks = {};
    const { database, d1 } = createTestDatabase(hooks);
    hooks.beforeMenuSave = () => insertEmptyMenu(database, 'primary', 'Other editor');
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'My menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
    })).resolves.toEqual({ kind: 'id_conflict' });
    expect(storedMenu(database, 'primary')).toMatchObject({ name: 'Other editor' });
    expect(storedMenu(database, 'footer')).toBeUndefined();
  });

  it('checks the revision at write time before creating missing defaults', async () => {
    const hooks: TestHooks = {};
    const { database, d1 } = createTestDatabase(hooks);
    insertEmptyMenu(database, 'primary');
    hooks.beforeMenuSave = () => {
      database.prepare('UPDATE menus SET name = ?, revision = ? WHERE menu_id = ?')
        .run('Other editor', '2'.repeat(32), 'primary');
    };
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'My menu', enabled: true,
      items: [], expectedRevision: '1'.repeat(32), now: NOW,
      createRevision: () => '3'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(storedMenu(database, 'primary')).toMatchObject({
      name: 'Other editor', revision: '2'.repeat(32),
    });
    expect(storedMenu(database, 'footer')).toBeUndefined();
  });

  it('preserves a counterpart created by another editor just before the write', async () => {
    const hooks: TestHooks = {};
    const { database, d1 } = createTestDatabase(hooks);
    hooks.beforeMenuSave = () => insertEmptyMenu(database, 'footer', 'Other footer');
    await expect(saveMenu({
      db: d1, menuId: 'primary', name: 'My menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
    })).resolves.toMatchObject({ kind: 'completed' });
    expect(storedMenu(database, 'footer')).toMatchObject({
      name: 'Other footer', revision: '1'.repeat(32),
    });
  });

  it('reserves capacity for every missing default in the atomic write', async () => {
    const { database, d1 } = createTestDatabase();
    for (let index = 0; index < MENU_MAX_COUNT - 1; index += 1) {
      insertEmptyMenu(database, `custom_${index}`);
    }
    const request = {
      db: d1, menuId: 'primary', name: 'Primary Menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
    };
    await expect(saveMenu(request)).resolves.toEqual({ kind: 'limit_reached' });
    expect(storedMenu(database, 'primary')).toBeUndefined();
    expect(storedMenu(database, 'footer')).toBeUndefined();
    database.prepare('DELETE FROM menus WHERE menu_id = ?').run('custom_0');
    await expect(saveMenu(request)).resolves.toMatchObject({ kind: 'completed' });
    await expect(listMenus({ db: d1 })).resolves.toHaveLength(MENU_MAX_COUNT);
  });

  it('does not materialize defaults when a reference or expected stored menu is missing', async () => {
    const { d1 } = createTestDatabase();
    const request = {
      db: d1, menuId: 'primary', name: 'Primary Menu', enabled: true,
      items: [], expectedRevision: null, now: NOW,
    };
    await expect(saveMenu({
      ...request, items: [{ ...customItem(), link: { kind: 'post', reference_id: POST_ID } }],
    })).resolves.toEqual({ kind: 'reference_not_found' });
    await expect(saveMenu({ ...request, expectedRevision: '1'.repeat(32) }))
      .resolves.toEqual({ kind: 'not_found' });
    await expect(listMenus({ db: d1 })).resolves.toEqual([]);
  });
});

describe('Menu D1 repository', () => {
  it('creates, lists, no-op updates, revisioned updates, and deletes menus', async () => {
    const { d1 } = createTestDatabase();
    const created = await createMenu({
      db: d1,
      menuId: 'docs',
      name: 'Docs Menu',
      enabled: true,
      items: [customItem()],
      now: NOW,
      createRevision: () => '1'.repeat(32),
    });
    expect(created).toMatchObject({
      kind: 'completed',
      menu: { menu_id: 'docs', revision: '1'.repeat(32) },
    });
    await expect(createMenu({
      db: d1,
      menuId: 'docs',
      name: 'Duplicate',
      enabled: true,
      items: [],
    })).resolves.toEqual({ kind: 'id_conflict' });
    await expect(listMenus({ db: d1 })).resolves.toHaveLength(1);
    await expect(saveMenu({
      db: d1,
      menuId: 'docs',
      name: 'Docs Menu',
      enabled: true,
      items: [customItem()],
      expectedRevision: '1'.repeat(32),
      createRevision: () => '2'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      menus: expect.arrayContaining([expect.objectContaining({
        menu_id: 'docs', revision: '1'.repeat(32),
      })]),
    });
    await expect(saveMenu({
      db: d1,
      menuId: 'docs',
      name: 'Documentation',
      enabled: false,
      items: [customItem()],
      expectedRevision: '1'.repeat(32),
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '2'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      menus: expect.arrayContaining([expect.objectContaining({
        menu_id: 'docs', name: 'Documentation', enabled: false, revision: '2'.repeat(32),
      })]),
    });
    await expect(deleteMenu({
      db: d1,
      menuId: 'docs',
      expectedRevision: '1'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    await expect(deleteMenu({
      db: d1,
      menuId: 'docs',
      expectedRevision: '2'.repeat(32),
    })).resolves.toEqual({ kind: 'completed' });
  });

  it('protects primary/footer and validates typed references on writes', async () => {
    const { database, d1 } = createTestDatabase();
    seedReferences(database);
    const items: MenuItem[] = [
      {
        id: '5'.repeat(32),
        title: 'Post',
        link: { kind: 'post', reference_id: POST_ID },
        target: '_self',
        children: [],
      },
      {
        id: '6'.repeat(32),
        title: 'Docs',
        link: { kind: 'page', reference_id: PAGE_ID },
        target: '_self',
        children: [],
      },
      {
        id: '7'.repeat(32),
        title: 'News',
        link: { kind: 'category', reference_id: CATEGORY_ID },
        target: '_self',
        children: [],
      },
      {
        id: '8'.repeat(32),
        title: 'Featured',
        link: { kind: 'tag', reference_id: TAG_ID },
        target: '_self',
        children: [],
      },
    ];
    await expect(createMenu({
      db: d1,
      menuId: 'primary',
      name: 'Primary Menu',
      enabled: true,
      items,
      now: NOW,
      createRevision: () => '9'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });
    await expect(deleteMenu({
      db: d1,
      menuId: 'primary',
      expectedRevision: '9'.repeat(32),
    })).resolves.toEqual({ kind: 'protected' });
    database.prepare("UPDATE posts SET status = 'trash'").run();
    await expect(saveMenu({
      db: d1,
      menuId: 'primary',
      name: 'Primary Menu',
      enabled: true,
      items,
      expectedRevision: '9'.repeat(32),
    })).resolves.toEqual({ kind: 'reference_not_found' });
  });

  it('resolves Preview URLs at read time and preserves authored labels', async () => {
    const { database, d1 } = createTestDatabase();
    seedReferences(database);
    const menu = (await createMenu({
      db: d1,
      menuId: 'primary',
      name: 'Primary Menu',
      enabled: true,
      items: [{
        id: '5'.repeat(32),
        title: 'Old label kept',
        link: { kind: 'post', reference_id: POST_ID },
        target: '_self',
        children: [customItem('6'.repeat(32))],
      }, {
        id: '7'.repeat(32),
        title: 'Docs',
        link: { kind: 'page', reference_id: PAGE_ID },
        target: '_self',
        children: [],
      }, {
        id: '8'.repeat(32),
        title: 'Home',
        link: { kind: 'custom', url: '/' },
        target: '_self',
        children: [],
      }],
      now: NOW,
      createRevision: () => '9'.repeat(32),
    })) as Extract<Awaited<ReturnType<typeof createMenu>>, { kind: 'completed' }>;

    const resolved = resolvePreviewMenus({
      menus: [menu.menu],
      posts: [],
      pages: [{
        id: PAGE_ID,
        public_id: 100_000_000_001,
        parent: null,
        title: 'Docs',
        slug: 'docs',
        path: 'docs',
        content: '',
        document_type: 'markdown',
        editor_mode: 'source',
        editor_profile: null,
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: false,
        featured_image: null,
        revision: 'c'.repeat(32),
        created_at_iso: NOW.toISOString(),
        updated_at_iso: NOW.toISOString(),
      }],
      taxonomies: { categories: [], tags: [] },
      routing: materializeRoutingSettingsDefaults(),
      timezone: 'UTC',
    });
    expect(resolved.primary.items).toEqual([
      {
        title: 'External',
        url: 'https://example.com/docs',
        target: '_blank',
        meta: { badge: 'New', priority: 1 },
        children: [],
      },
      {
        title: 'Docs',
        url: '/docs/',
        target: '_self',
        children: [],
      },
      {
        title: 'Home',
        url: '/',
        target: '_self',
        children: [],
      },
    ]);
    await expect(listPreviewMenus({ db: d1 })).resolves.toHaveLength(1);
  });

  it('fails closed for non-canonical stored item JSON', async () => {
    const { database, d1 } = createTestDatabase();
    const item = customItem();
    const nonCanonicalItem = Object.fromEntries([
      ['target', item.target],
      ...Object.entries(item).filter(([key]) => key !== 'target'),
    ]);
    database.prepare(`
      INSERT INTO menus (
        menu_id, name, enabled, items, revision, created_at_iso, updated_at_iso
      ) VALUES ('bad', 'Bad', 1, ?, ?, ?, ?)
    `).run(
      JSON.stringify([nonCanonicalItem]),
      '1'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await expect(listMenus({ db: d1 })).rejects.toMatchObject({
      code: 'MENU_MANAGEMENT_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});
