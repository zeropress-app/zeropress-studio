import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENU_MAX_COUNT } from '../../../contracts/menus';
import type { WxrCoreImportChunkRequest } from '../../../contracts/wxr-import';
import { importWxrCoreChunk } from './wxr-core-import-repository';

type SqliteRunResult = { changes: number | bigint };
type SqliteChangeCountRow = { changes: number | bigint };

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
    const before = this.database.prepare(`
      SELECT total_changes() AS changes
    `).get() as SqliteChangeCountRow;
    (
      this.database.prepare(this.sql).run as (...params: unknown[]) => SqliteRunResult
    )(...this.params);
    const after = this.database.prepare(`
      SELECT total_changes() AS changes
    `).get() as SqliteChangeCountRow;
    return {
      success: true,
      results: [],
      // D1 reports statement-wide writes, including trigger side effects.
      meta: { changes: Number(after.changes) - Number(before.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...params: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const result = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return result ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(this.sql)
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

const NOW = new Date('2026-08-02T08:00:00.000Z');
const CREATED = '2026-07-01T01:02:03Z';
const UPDATED = '2026-07-02T01:02:03Z';
const MEDIA_KEY = 'imported/hero.jpg';
const MEDIA_LOCATION = { type: 'r2' as const, key: MEDIA_KEY };

function requests(): WxrCoreImportChunkRequest[] {
  return [
    {
      phase: 'authors',
      rows: [{ id: 'Lael-Rukius', display_name: 'HYEONG HWAN, MUN' }],
    },
    {
      phase: 'categories',
      rows: [{ name: 'News', slug: 'news', description: '' }],
    },
    {
      phase: 'tags',
      rows: [
        { name: 'First', slug: 'first', description: '' },
        { name: 'Second', slug: 'second', description: '' },
      ],
    },
    {
      phase: 'media',
      rows: [{
        external_id: 90,
        kind: 'image',
        filename: 'hero.jpg',
        mime_type: 'image/jpeg',
        location: MEDIA_LOCATION,
        size_bytes: null,
        width: 1018,
        height: 724,
        duration_ms: null,
        alt: 'Hero',
      }],
    },
    {
      phase: 'posts',
      rows: [{
        public_id: 13261,
        title: 'Imported Post',
        slug: 'imported-post',
        content: '<p>Hello</p>',
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
        excerpt: 'Hello',
        status: 'published',
        author_id: 'Lael-Rukius',
        category_slugs: ['news'],
        tag_slugs: ['second', 'first'],
        discoverability: 'default',
        allow_comments: true,
        featured_image_location: MEDIA_LOCATION,
        published_at_iso: CREATED,
        created_at_iso: CREATED,
        updated_at_iso: UPDATED,
      }],
    },
    {
      phase: 'pages',
      rows: [{
        public_id: 20,
        parent_public_id: null,
        title: 'Parent',
        slug: 'parent',
        content: '<p>Parent</p>',
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
        excerpt: '',
        status: 'draft',
        discoverability: 'default',
        allow_comments: false,
        featured_image_location: null,
        created_at_iso: CREATED,
        updated_at_iso: UPDATED,
      }, {
        public_id: 21,
        parent_public_id: 20,
        title: 'Child',
        slug: 'child',
        content: '<p>Child</p>',
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: true,
        featured_image_location: MEDIA_LOCATION,
        created_at_iso: CREATED,
        updated_at_iso: UPDATED,
      }],
    },
    {
      phase: 'menus',
      rows: [{
        menu_id: 'primary',
        name: 'Primary Navigation',
        items: [{
          id: '0'.repeat(31) + '1',
          title: 'Imported Post',
          link: { kind: 'post', public_id: 13261 },
          target: '_self',
          children: [{
            id: '0'.repeat(31) + '2',
            title: 'Child Page',
            link: { kind: 'page', public_id: 21 },
            target: '_self',
            children: [],
          }],
        }, {
          id: '0'.repeat(31) + '3',
          title: 'News',
          link: { kind: 'category', slug: 'news' },
          target: '_self',
          children: [],
        }, {
          id: '0'.repeat(31) + '4',
          title: 'First',
          link: { kind: 'tag', slug: 'first' },
          target: '_self',
          children: [],
        }, {
          id: '0'.repeat(31) + '5',
          title: 'External',
          link: { kind: 'custom', url: 'https://example.com/' },
          target: '_blank',
          children: [],
        }],
      }],
    },
  ];
}

async function importAll(db: D1Database, values = requests()) {
  const results = [];
  for (const request of values) {
    results.push(await importWxrCoreChunk({ db, request, now: NOW }));
  }
  return results;
}

describe('WXR core import D1 repository', () => {
  it('imports dependencies, ordered relations, and Page hierarchy', async () => {
    const { database, d1 } = createTestDatabase();
    const results = await importAll(d1);
    expect(results.map((result) => result.summary.created))
      .toEqual([1, 1, 2, 1, 1, 2, 1]);
    expect(database.prepare(`
      SELECT posts.public_id, posts.author_id, media.storage_key AS src,
        posts.created_at_iso, posts.updated_at_iso
      FROM posts LEFT JOIN media ON media.id = posts.featured_image_id
    `).get()).toEqual({
      public_id: 13261,
      author_id: 'Lael-Rukius',
      src: MEDIA_KEY,
      created_at_iso: CREATED,
      updated_at_iso: UPDATED,
    });
    expect(database.prepare(`
      SELECT tags.slug
      FROM post_tags INNER JOIN tags ON tags.id = post_tags.tag_id
      ORDER BY post_tags.sort_order
    `).all()).toEqual([{ slug: 'second' }, { slug: 'first' }]);
    expect(database.prepare(`
      SELECT child.public_id, parent.public_id AS parent_public_id
      FROM pages AS child LEFT JOIN pages AS parent ON parent.id = child.parent_id
      WHERE child.public_id = 21
    `).get()).toEqual({ public_id: 21, parent_public_id: 20 });
    const storedMenu = database.prepare(`
      SELECT name, enabled, items FROM menus WHERE menu_id = 'primary'
    `).get() as { name: string; enabled: number; items: string };
    expect(storedMenu).toMatchObject({ name: 'Primary Navigation', enabled: 1 });
    const storedItems = JSON.parse(storedMenu.items) as Array<{
      link: { kind: string; reference_id?: string };
      children: Array<{ link: { kind: string; reference_id?: string } }>;
    }>;
    expect(storedItems.map((item) => item.link.kind))
      .toEqual(['post', 'category', 'tag', 'custom']);
    expect(storedItems[0]?.children[0]?.link.kind).toBe('page');
    for (const referenceId of [
      storedItems[0]?.link.reference_id,
      storedItems[0]?.children[0]?.link.reference_id,
      storedItems[1]?.link.reference_id,
      storedItems[2]?.link.reference_id,
    ]) expect(referenceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('is deterministic on repeated imports and updates authored source state', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('edge_integration_mode', 'enabled', 'string', ?)
    `).run(NOW.toISOString());
    await importAll(d1);
    expect(database.prepare(`
      SELECT target_type, target_public_id, operation
      FROM edge_comment_target_projection_outbox
      ORDER BY id
    `).all()).toEqual([
      { target_type: 'post', target_public_id: 13261, operation: 'upsert' },
      { target_type: 'page', target_public_id: 20, operation: 'upsert' },
      { target_type: 'page', target_public_id: 21, operation: 'upsert' },
    ]);
    database.prepare('DELETE FROM edge_comment_target_projection_outbox').run();
    const avatar = database.prepare(`
      SELECT id FROM media WHERE storage_key = ?
    `).get(MEDIA_KEY) as { id: string };
    database.prepare(`
      UPDATE authors SET avatar_media_id = ? WHERE id = 'Lael-Rukius'
    `).run(avatar.id);
    const initialPostSearch = database.prepare(`
      SELECT rowid, revision, title, body
      FROM post_search_fts WHERE rowid = 13261
    `).get();
    const initialPageSearch = database.prepare(`
      SELECT rowid, revision, title, body
      FROM page_search_fts ORDER BY rowid
    `).all();
    expect(initialPostSearch).toMatchObject({
      rowid: 13261,
      title: 'Imported Post',
      body: 'Hello',
    });
    expect(initialPageSearch).toEqual([
      expect.objectContaining({ rowid: 20, title: 'Parent', body: 'Parent' }),
      expect.objectContaining({ rowid: 21, title: 'Child', body: 'Child' }),
    ]);
    const repeated = await importAll(d1);
    expect(repeated.map((result) => result.summary.unchanged))
      .toEqual([1, 1, 2, 1, 1, 2, 1]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT rowid, revision, title, body
      FROM post_search_fts WHERE rowid = 13261
    `).get()).toEqual(initialPostSearch);
    expect(database.prepare(`
      SELECT rowid, revision, title, body
      FROM page_search_fts ORDER BY rowid
    `).all()).toEqual(initialPageSearch);

    const changed = requests();
    changed[0] = {
      phase: 'authors',
      rows: [{ id: 'Lael-Rukius', display_name: 'Changed Display Name' }],
    };
    const postRequest = changed[4];
    if (postRequest?.phase !== 'posts') throw new TypeError('Expected Posts phase.');
    postRequest.rows[0] = { ...postRequest.rows[0]!, title: 'Updated Post' };
    const pageRequest = changed[5];
    if (pageRequest?.phase !== 'pages') throw new TypeError('Expected Pages phase.');
    pageRequest.rows[1] = { ...pageRequest.rows[1]!, title: 'Updated Child' };
    const menuRequest = changed[6];
    if (menuRequest?.phase !== 'menus') throw new TypeError('Expected Menus phase.');
    menuRequest.rows[0] = {
      ...menuRequest.rows[0]!,
      name: 'Updated Navigation',
    };
    const updated = await importAll(
      d1,
      [changed[0]!, postRequest, pageRequest, menuRequest],
    );
    expect(updated.map((result) => result.summary.updated)).toEqual([1, 1, 1, 1]);
    expect(database.prepare(`
      SELECT target_type, target_public_id, operation
      FROM edge_comment_target_projection_outbox
      ORDER BY id
    `).all()).toEqual([
      { target_type: 'post', target_public_id: 13261, operation: 'upsert' },
      { target_type: 'page', target_public_id: 21, operation: 'upsert' },
    ]);
    expect(database.prepare(`
      SELECT display_name, avatar_media_id FROM authors WHERE id = ?
    `).get('Lael-Rukius')).toEqual({
      display_name: 'Changed Display Name',
      avatar_media_id: avatar.id,
    });
    expect(database.prepare('SELECT title FROM posts WHERE public_id = 13261').get())
      .toEqual({ title: 'Updated Post' });
    expect(database.prepare('SELECT title FROM pages WHERE public_id = 21').get())
      .toEqual({ title: 'Updated Child' });
    expect(database.prepare(`
      SELECT fts.title, fts.revision = posts.revision AS current_revision
      FROM post_search_fts AS fts
      INNER JOIN posts ON posts.public_id = fts.rowid
      WHERE fts.rowid = 13261
    `).get()).toEqual({ title: 'Updated Post', current_revision: 1 });
    expect(database.prepare(`
      SELECT fts.title, fts.revision = pages.revision AS current_revision
      FROM page_search_fts AS fts
      INNER JOIN pages ON pages.public_id = fts.rowid
      WHERE fts.rowid = 21
    `).get()).toEqual({ title: 'Updated Child', current_revision: 1 });
    expect(database.prepare("SELECT name FROM menus WHERE menu_id = 'primary'").get())
      .toEqual({ name: 'Updated Navigation' });
    const storedPostRevision = database.prepare(`
      SELECT json_extract(snapshot_json, '$.draft.title') AS title
      FROM post_revisions
    `).get();
    expect(storedPostRevision).toEqual({ title: 'Imported Post' });
    const storedPageRevision = database.prepare(`
      SELECT json_extract(snapshot_json, '$.draft.title') AS title
      FROM page_revisions
    `).get();
    expect(storedPageRevision).toEqual({ title: 'Child' });
  });

  it('rolls back a canonical WXR update when its derived index write fails', async () => {
    const { database, d1 } = createTestDatabase();
    await importAll(d1);
    const original = database.prepare(`
      SELECT title, revision FROM posts WHERE public_id = 13261
    `).get();
    database.exec('DROP TABLE post_search_fts');
    const postRequest = requests()[4];
    if (postRequest?.phase !== 'posts') throw new TypeError('Expected Posts phase.');
    postRequest.rows[0] = {
      ...postRequest.rows[0]!,
      title: 'Must roll back',
    };

    await expect(importWxrCoreChunk({
      db: d1,
      request: postRequest,
      now: NOW,
    })).rejects.toMatchObject({
      operationalMetadata: { action: 'upsert_wxr_post' },
    });
    expect(database.prepare(`
      SELECT title, revision FROM posts WHERE public_id = 13261
    `).get()).toEqual(original);
  });

  it('keeps one Media row and its references when the WXR storage strategy changes', async () => {
    const { database, d1 } = createTestDatabase();
    await importAll(d1);
    const original = database.prepare(`
      SELECT id, revision, created_at_iso
      FROM media
      WHERE external_id = 90
    `).get() as { id: string; revision: string; created_at_iso: string };
    database.prepare(`
      INSERT INTO media_collections (
        id, name, revision, created_at_iso, updated_at_iso
      ) VALUES (?, 'WXR assets', ?, ?, ?)
    `).run(
      'a'.repeat(32),
      'b'.repeat(32),
      CREATED,
      UPDATED,
    );
    database.prepare(`
      UPDATE media SET collection_id = ? WHERE id = ?
    `).run('a'.repeat(32), original.id);

    const externalLocation = {
      type: 'external' as const,
      url: 'https://blog.example/wp-content/uploads/hero.jpg',
    };
    const mediaRequest = requests()[3];
    if (mediaRequest?.phase !== 'media') {
      throw new TypeError('Expected Media phase.');
    }
    const externalRequest: WxrCoreImportChunkRequest = {
      phase: 'media',
      rows: [{ ...mediaRequest.rows[0]!, location: externalLocation }],
    };
    const switched = await importWxrCoreChunk({
      db: d1,
      request: externalRequest,
      now: NOW,
    });
    expect(switched.summary).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    const switchedMedia = database.prepare(`
      SELECT id, external_id, storage_type, storage_key, external_url,
        collection_id, revision, created_at_iso
      FROM media
    `).get() as Record<string, unknown>;
    expect(switchedMedia).toEqual({
      id: original.id,
      external_id: 90,
      storage_type: 'external',
      storage_key: null,
      external_url: externalLocation.url,
      collection_id: 'a'.repeat(32),
      revision: expect.stringMatching(/^[0-9a-f]{32}$/u),
      created_at_iso: original.created_at_iso,
    });
    expect(switchedMedia.revision).not.toBe(original.revision);
    expect(database.prepare(`
      SELECT featured_image_id FROM posts WHERE public_id = 13261
    `).get()).toEqual({ featured_image_id: original.id });
    expect(database.prepare(`
      SELECT featured_image_id FROM pages WHERE public_id = 21
    `).get()).toEqual({ featured_image_id: original.id });
    expect(database.prepare('SELECT COUNT(*) AS count FROM media').get())
      .toEqual({ count: 1 });

    const repeated = await importWxrCoreChunk({
      db: d1,
      request: externalRequest,
      now: NOW,
    });
    expect(repeated.summary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      failed: 0,
    });
    expect(database.prepare(`
      SELECT revision FROM media WHERE id = ?
    `).get(original.id)).toEqual({
      revision: switchedMedia.revision,
    });

    const switchedBack = await importWxrCoreChunk({
      db: d1,
      request: mediaRequest,
      now: NOW,
    });
    expect(switchedBack.summary).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(database.prepare(`
      SELECT id, external_id, storage_type, storage_key, external_url,
        collection_id
      FROM media
    `).get()).toEqual({
      id: original.id,
      external_id: 90,
      storage_type: 'r2',
      storage_key: MEDIA_KEY,
      external_url: null,
      collection_id: 'a'.repeat(32),
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM media').get())
      .toEqual({ count: 1 });
  });

  it('claims an exact legacy Media location without replacing its internal ID', async () => {
    const { database, d1 } = createTestDatabase();
    const legacyId = 'c'.repeat(32);
    const location = 'https://blog.example/wp-content/uploads/hero.jpg';
    database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'image', 'hero.jpg', 'image/jpeg', 'external', NULL, ?,
        NULL, 1018, 724, NULL, 'Hero', ?, ?, ?)
    `).run(legacyId, location, 'd'.repeat(32), CREATED, UPDATED);
    const mediaRequest = requests()[3];
    if (mediaRequest?.phase !== 'media') {
      throw new TypeError('Expected Media phase.');
    }
    const result = await importWxrCoreChunk({
      db: d1,
      request: {
        phase: 'media',
        rows: [{
          ...mediaRequest.rows[0]!,
          location: { type: 'external', url: location },
        }],
      },
      now: NOW,
    });
    expect(result.summary).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(database.prepare(`
      SELECT id, external_id FROM media
    `).get()).toEqual({ id: legacyId, external_id: 90 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM media').get())
      .toEqual({ count: 1 });
  });

  it('reports a Media identity conflict without merging different owners', async () => {
    const { database, d1 } = createTestDatabase();
    const mediaRequest = requests()[3];
    if (mediaRequest?.phase !== 'media') {
      throw new TypeError('Expected Media phase.');
    }
    await importWxrCoreChunk({ db: d1, request: mediaRequest, now: NOW });
    const externalLocation = {
      type: 'external' as const,
      url: 'https://blog.example/wp-content/uploads/hero.jpg',
    };
    await importWxrCoreChunk({
      db: d1,
      request: {
        phase: 'media',
        rows: [{
          ...mediaRequest.rows[0]!,
          external_id: 91,
          location: externalLocation,
        }],
      },
      now: NOW,
    });

    const result = await importWxrCoreChunk({
      db: d1,
      request: {
        phase: 'media',
        rows: [{ ...mediaRequest.rows[0]!, location: externalLocation }],
      },
      now: NOW,
    });
    expect(result.summary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 1,
      failures: [{
        row_index: 0,
        key: '90',
        code: 'MEDIA_EXTERNAL_ID_CONFLICT',
      }],
    });
    expect(database.prepare(`
      SELECT external_id, storage_type, storage_key, external_url
      FROM media
      ORDER BY external_id
    `).all()).toEqual([
      {
        external_id: 90,
        storage_type: 'r2',
        storage_key: MEDIA_KEY,
        external_url: null,
      },
      {
        external_id: 91,
        storage_type: 'external',
        storage_key: null,
        external_url: externalLocation.url,
      },
    ]);
  });

  it('reports a missing typed Menu reference without creating the aggregate', async () => {
    const { database, d1 } = createTestDatabase();
    const request: WxrCoreImportChunkRequest = {
      phase: 'menus',
      rows: [{
        menu_id: 'primary',
        name: 'Primary',
        items: [{
          id: '0'.repeat(31) + '1',
          title: 'Missing Post',
          link: { kind: 'post', public_id: 999 },
          target: '_self',
          children: [],
        }],
      }],
    };
    await expect(importWxrCoreChunk({ db: d1, request, now: NOW }))
      .resolves.toMatchObject({
        summary: {
          created: 0,
          failed: 1,
          failures: [{
            row_index: 0,
            key: 'primary',
            code: 'MENU_REFERENCE_NOT_FOUND',
          }],
        },
      });
    expect(database.prepare('SELECT COUNT(*) AS count FROM menus').get())
      .toEqual({ count: 0 });
  });

  it('reports the aggregate limit without replacing an existing Menu', async () => {
    const { database, d1 } = createTestDatabase();
    const insert = database.prepare(`
      INSERT INTO menus (
        menu_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, 1, '[]', ?, ?, ?)
    `);
    for (let index = 0; index < MENU_MAX_COUNT; index += 1) {
      insert.run(
        `menu-${index}`,
        `Menu ${index}`,
        index.toString(16).padStart(32, '0'),
        CREATED,
        UPDATED,
      );
    }
    const request: WxrCoreImportChunkRequest = {
      phase: 'menus',
      rows: [{
        menu_id: 'additional',
        name: 'Additional',
        items: [],
      }],
    };
    await expect(importWxrCoreChunk({ db: d1, request, now: NOW }))
      .resolves.toMatchObject({
        summary: {
          created: 0,
          failed: 1,
          failures: [{
            row_index: 0,
            key: 'additional',
            code: 'MENU_LIMIT_REACHED',
          }],
        },
      });
    expect(database.prepare('SELECT COUNT(*) AS count FROM menus').get())
      .toEqual({ count: MENU_MAX_COUNT });
  });

  it('reports row conflicts without replacing unrelated native content', async () => {
    const { database, d1 } = createTestDatabase();
    await importAll(d1, requests().slice(0, 4));
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, content, document_type, excerpt, status,
        author_id, discoverability, allow_comments, featured_image_id,
        published_at_iso, revision, created_at_iso, updated_at_iso
      ) VALUES (?, 100000000001, 'Native', 'imported-post', '', 'html', '',
        'draft', 'Lael-Rukius', 'default', 0, NULL, NULL, ?, ?, ?)
    `).run('f'.repeat(32), 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());
    const postRequest = requests()[4]!;
    const result = await importWxrCoreChunk({ db: d1, request: postRequest, now: NOW });
    expect(result).toMatchObject({
      summary: {
        processed: 1,
        created: 0,
        failed: 1,
        failures: [{ row_index: 0, key: '13261', code: 'SLUG_CONFLICT' }],
      },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM posts').get())
      .toEqual({ count: 1 });
  });
});
