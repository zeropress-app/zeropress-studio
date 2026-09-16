import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZEROPRESS_NATIVE_PUBLIC_ID_BASE } from '../../../contracts/content-public-id';
import {
  createPageRequestSchema,
  type PageListQuery,
  type UpdatePageRequest,
} from '../../../contracts/pages';
import {
  materializeRoutingSettingsDefaults,
  ROUTING_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/routing-settings';
import { updateRoutingSettings } from '../settings/routing-settings-repository';
import {
  createPage,
  deletePage,
  getPage,
  listPageParentOptions,
  listPages,
  listPreviewPages,
  updatePage,
  updatePageBulkLifecycle,
} from './page-repository';
import {
  listPageRevisions,
  readPageRevision,
} from '../content-revisions/repository';

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

function createTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  database.prepare(`
    INSERT INTO content_search_index_state (
      id, state, reason, phase, operation_id,
      post_public_id_cursor, page_public_id_cursor,
      processed_posts, processed_pages, total_posts, total_pages,
      started_at_iso, updated_at_iso
    ) VALUES (1, 'ready', NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, ?)
  `).run('2026-08-01T08:00:00.000Z');
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

const NOW = new Date('2026-08-01T08:00:00.000Z');
const MEDIA_ID = '8'.repeat(32);

function seedMedia(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO media (
      id, kind, filename, mime_type, storage_type, storage_key, external_url,
      size_bytes, width, height, duration_ms, alt, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'image', 'page.jpg', 'image/jpeg', 'external', NULL,
      'https://media.example/uploads/page.jpg', NULL, 1200, 630, NULL,
      'Page', ?, ?, ?)
  `).run(MEDIA_ID, '8'.repeat(32), NOW.toISOString(), NOW.toISOString());
}
const defaultQuery: PageListQuery = {
  search: '',
  status: 'all',
  page: 1,
  per_page: 50,
};

function authored(overrides: Record<string, unknown> = {}) {
  return createPageRequestSchema.parse({
    parent_id: null,
    title: 'About',
    slug: 'about',
    content: '# About',
    document_type: 'markdown',
    editor_mode: 'source',
    editor_profile: null,
    excerpt: 'About this site.',
    status: 'draft',
    discoverability: 'default',
    allow_comments: false,
    featured_image_id: null,
    ...overrides,
  });
}

async function insertPage(input: {
  db: D1Database;
  id: string;
  revision: string;
  overrides?: Record<string, unknown>;
}) {
  return createPage({
    db: input.db,
    authored: authored(input.overrides),
    now: NOW,
    createId: () => input.id,
    createRevision: () => input.revision,
  });
}

describe('Page D1 repository', () => {
  it('accepts trigger-inclusive D1 change counts for create and delete', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('edge_integration_mode', 'enabled', 'string', ?)
    `).run(NOW.toISOString());
    const pageId = '1'.repeat(32);
    const revision = '2'.repeat(32);

    await expect(insertPage({
      db: d1,
      id: pageId,
      revision,
    })).resolves.toMatchObject({ kind: 'completed' });
    database.prepare("UPDATE pages SET status = 'trash' WHERE id = ?")
      .run(pageId);
    await expect(deletePage({
      db: d1,
      id: pageId,
      expectedRevision: revision,
    })).resolves.toMatchObject({ kind: 'completed' });

    expect(database.prepare(`
      SELECT operation FROM edge_comment_target_projection_outbox ORDER BY id
    `).all()).toEqual([{ operation: 'upsert' }, { operation: 'delete' }]);
  });

  it('atomically removes the new-draft autosave after canonical creation', async () => {
    const { database, d1 } = createTestDatabase();
    const userId = '9'.repeat(32);
    const draftId = '7'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, failed_login_attempts, created_at_iso, updated_at_iso
      ) VALUES (?, 'editor@example.com', 'hash', ?, 'Site Editor', 'active',
        1, 0, ?, ?)
    `).run(userId, 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO page_autosaves (
        user_id, draft_id, page_id, base_revision, snapshot_version,
        snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso,
        expires_at_iso
      ) VALUES (?, ?, NULL, NULL, 1, '{}', ?, ?, ?, ?)
    `).run(
      userId,
      draftId,
      'f'.repeat(64),
      NOW.toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    expect(await createPage({
      db: d1,
      authored: authored({ autosave_draft_id: draftId }),
      autosaveUserId: userId,
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    })).toMatchObject({ kind: 'completed' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM page_autosaves').get())
      .toEqual({ count: 0 });
  });

  it('atomically promotes and binds a matching recovery snapshot as a Draft', async () => {
    const { database, d1 } = createTestDatabase();
    const userId = '9'.repeat(32);
    const draftId = '7'.repeat(32);
    const digest = 'f'.repeat(64);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, failed_login_attempts, created_at_iso, updated_at_iso
      ) VALUES (?, 'editor@example.com', 'hash', ?, 'Site Editor', 'active',
        1, 0, ?, ?)
    `).run(userId, 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO page_autosaves (
        user_id, draft_id, page_id, base_revision, snapshot_version,
        snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso,
        expires_at_iso
      ) VALUES (?, ?, NULL, NULL, 1, '{}', ?, ?, ?, ?)
    `).run(
      userId,
      draftId,
      digest,
      NOW.toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    const result = await createPage({
      db: d1,
      authored: authored({ autosave_draft_id: draftId }),
      autosaveUserId: userId,
      bindAutosaveSnapshotSha256: digest,
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    });
    expect(result).toMatchObject({ kind: 'completed', page: { status: 'draft' } });
    expect(database.prepare(`
      SELECT page_id, base_revision, expires_at_iso
      FROM page_autosaves WHERE user_id = ? AND draft_id = ?
    `).get(userId, draftId)).toEqual({
      page_id: '6'.repeat(32),
      base_revision: '7'.repeat(32),
      expires_at_iso: null,
    });
  });

  it('allocates a non-reusable Page ID from the independent content counter', async () => {
    const { database, d1 } = createTestDatabase();
    seedMedia(database);
    await expect(insertPage({
      db: d1,
      id: '1'.repeat(32),
      revision: '2'.repeat(32),
      overrides: { featured_image_id: MEDIA_ID },
    })).resolves.toMatchObject({
      kind: 'completed',
      page: {
        public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 1,
        featured_image: {
          id: MEDIA_ID,
          kind: 'image',
          filename: 'page.jpg',
          mime_type: 'image/jpeg',
          location: {
            type: 'external',
            url: 'https://media.example/uploads/page.jpg',
          },
          width: 1200,
          height: 630,
          alt: 'Page',
        },
      },
    });
    expect(database.prepare(`
      SELECT content_type, last_public_id
      FROM content_public_id_counters
      ORDER BY content_type
    `).all()).toEqual([
      { content_type: 'page', last_public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 1 },
      { content_type: 'post', last_public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE },
    ]);

    database.prepare("UPDATE pages SET status = 'trash'").run();
    database.prepare('DELETE FROM pages').run();
    await expect(insertPage({
      db: d1,
      id: '3'.repeat(32),
      revision: '4'.repeat(32),
      overrides: { title: 'Contact', slug: 'contact' },
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 2 },
    });
  });

  it('archives the exact prior Page snapshot before a canonical save', async () => {
    const { database, d1 } = createTestDatabase();
    const pageId = '1'.repeat(32);
    const initialRevision = '2'.repeat(32);
    const nextRevision = '3'.repeat(32);
    await insertPage({ db: d1, id: pageId, revision: initialRevision });
    const result = await updatePage({
      db: d1,
      id: pageId,
      authored: {
        ...authored({ title: 'About us', content: '# Updated' }),
        expected_revision: initialRevision,
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => nextRevision,
    });
    expect(result).toMatchObject({ kind: 'completed' });
    if (result.kind !== 'completed') throw new TypeError('Page update failed.');
    await expect(listPageRevisions({ db: d1, page: result.page }))
      .resolves.toMatchObject({
        current_revision: nextRevision,
        items: [
          { revision_id: nextRevision, current: true, title: 'About us' },
          { revision_id: initialRevision, current: false, title: 'About' },
        ],
      });
    await expect(readPageRevision({
      db: d1,
      page: result.page,
      revisionId: initialRevision,
    })).resolves.toMatchObject({
      revision_id: initialRevision,
      current: false,
      snapshot: {
        content_type: 'page',
        draft: { title: 'About', content: '# About' },
        references: { parent: null, featured_image: null },
      },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM page_revisions WHERE page_id = ?
    `).get(pageId)).toEqual({ count: 1 });
  });

  it('persists Page editor mode in v2 history and does not revise an exact replay', async () => {
    const { database, d1 } = createTestDatabase();
    const pageId = '1'.repeat(32);
    const initialRevision = '2'.repeat(32);
    const nextRevision = '3'.repeat(32);
    const visual = authored({
      content: '<p>About</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    await createPage({
      db: d1,
      authored: visual,
      now: NOW,
      createId: () => pageId,
      createRevision: () => initialRevision,
    });
    const source = {
      ...visual,
      editor_mode: 'source' as const,
      editor_profile: null,
      expected_revision: initialRevision,
    } satisfies UpdatePageRequest;
    await expect(updatePage({
      db: d1,
      id: pageId,
      authored: source,
      createRevision: () => nextRevision,
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { editor_mode: 'source', revision: nextRevision },
    });
    expect(database.prepare(`
      SELECT snapshot_version,
        json_extract(snapshot_json, '$.draft.editor_mode') AS editor_mode,
        json_extract(snapshot_json, '$.draft.editor_profile') AS editor_profile
      FROM page_revisions WHERE page_id = ?
    `).get(pageId)).toEqual({
      snapshot_version: 2,
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    await expect(updatePage({
      db: d1,
      id: pageId,
      authored: { ...source, expected_revision: nextRevision },
      createRevision: () => {
        throw new TypeError('A no-op must not allocate a revision.');
      },
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { revision: nextRevision },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM page_revisions WHERE page_id = ?
    `).get(pageId)).toEqual({ count: 1 });
  });

  it('changes a Page document type only while stored and requested content are empty', async () => {
    const { d1 } = createTestDatabase();
    const pageId = '1'.repeat(32);
    const initialRevision = '2'.repeat(32);
    const emptyHtml = authored({
      content: '',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    await createPage({
      db: d1,
      authored: emptyHtml,
      now: NOW,
      createId: () => pageId,
      createRevision: () => initialRevision,
    });
    await expect(updatePage({
      db: d1,
      id: pageId,
      authored: {
        ...emptyHtml,
        document_type: 'plaintext',
        editor_mode: 'source',
        editor_profile: null,
        expected_revision: initialRevision,
      },
      createRevision: () => '3'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { document_type: 'plaintext' },
    });
  });

  it('allows repeated leaf slugs in different branches but not among siblings', async () => {
    const { d1 } = createTestDatabase();
    const aboutId = '1'.repeat(32);
    const docsId = '3'.repeat(32);
    await insertPage({ db: d1, id: aboutId, revision: '2'.repeat(32) });
    await insertPage({
      db: d1,
      id: docsId,
      revision: '4'.repeat(32),
      overrides: { title: 'Docs', slug: 'docs' },
    });
    await expect(insertPage({
      db: d1,
      id: '5'.repeat(32),
      revision: '6'.repeat(32),
      overrides: { parent_id: aboutId, title: 'Guide', slug: 'guide' },
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { path: 'about/guide' },
    });
    await expect(insertPage({
      db: d1,
      id: '7'.repeat(32),
      revision: '8'.repeat(32),
      overrides: { parent_id: docsId, title: 'Guide', slug: 'guide' },
    })).resolves.toMatchObject({
      kind: 'completed',
      page: { path: 'docs/guide' },
    });
    await expect(insertPage({
      db: d1,
      id: '9'.repeat(32),
      revision: 'a'.repeat(32),
      overrides: { parent_id: aboutId, title: 'Another Guide', slug: 'guide' },
    })).resolves.toEqual({ kind: 'slug_conflict' });
    await expect(insertPage({
      db: d1,
      id: 'b'.repeat(32),
      revision: 'c'.repeat(32),
    })).resolves.toEqual({ kind: 'slug_conflict' });
  });

  it('rejects a missing featured Media reference without inserting a Page', async () => {
    const { database, d1 } = createTestDatabase();
    await expect(insertPage({
      db: d1,
      id: '1'.repeat(32),
      revision: '2'.repeat(32),
      overrides: { featured_image_id: '9'.repeat(32) },
    })).resolves.toEqual({ kind: 'media_not_found' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM pages').get())
      .toEqual({ count: 0 });
  });

  it('rejects self/descendant parents and excludes descendants from options', async () => {
    const { d1 } = createTestDatabase();
    const rootId = '1'.repeat(32);
    const childId = '3'.repeat(32);
    const leafId = '5'.repeat(32);
    await insertPage({ db: d1, id: rootId, revision: '2'.repeat(32) });
    await insertPage({
      db: d1,
      id: childId,
      revision: '4'.repeat(32),
      overrides: { parent_id: rootId, title: 'Team', slug: 'team' },
    });
    await insertPage({
      db: d1,
      id: leafId,
      revision: '6'.repeat(32),
      overrides: { parent_id: childId, title: 'People', slug: 'people' },
    });
    const root = await getPage({ db: d1, id: rootId });
    const update = {
      ...authored({ parent_id: leafId }),
      expected_revision: root?.revision,
    } as UpdatePageRequest;
    await expect(updatePage({
      db: d1,
      id: rootId,
      authored: update,
    })).resolves.toEqual({ kind: 'parent_cycle' });
    await expect(listPageParentOptions({
      db: d1,
      search: '',
      currentPageId: rootId,
    })).resolves.toEqual([]);
    await expect(listPageParentOptions({
      db: d1,
      search: 'About',
      currentPageId: leafId,
    })).resolves.toMatchObject([{ id: rootId, path: 'about' }]);
  });

  it('guards hierarchy-changing lifecycle operations and permanent deletion', async () => {
    const { d1 } = createTestDatabase();
    const rootId = '1'.repeat(32);
    const childId = '3'.repeat(32);
    await insertPage({ db: d1, id: rootId, revision: '2'.repeat(32) });
    await insertPage({
      db: d1,
      id: childId,
      revision: '4'.repeat(32),
      overrides: { parent_id: rootId, title: 'Team', slug: 'team' },
    });
    await expect(updatePage({
      db: d1,
      id: rootId,
      authored: {
        ...authored({ status: 'trash' }),
        expected_revision: '2'.repeat(32),
      },
    })).resolves.toEqual({ kind: 'has_children' });

    const childTrash = await updatePage({
      db: d1,
      id: childId,
      authored: {
        ...authored({
          parent_id: rootId,
          title: 'Team',
          slug: 'team',
          status: 'trash',
        }),
        expected_revision: '4'.repeat(32),
      },
      createRevision: () => '5'.repeat(32),
    });
    expect(childTrash).toMatchObject({ kind: 'completed' });
    await expect(deletePage({
      db: d1,
      id: childId,
      expectedRevision: '5'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      publicId: 100_000_000_002,
    });
    const rootTrash = await updatePage({
      db: d1,
      id: rootId,
      authored: {
        ...authored({ status: 'trash' }),
        expected_revision: '2'.repeat(32),
      },
      createRevision: () => '6'.repeat(32),
    });
    expect(rootTrash).toMatchObject({ kind: 'completed' });
    await expect(deletePage({
      db: d1,
      id: rootId,
      expectedRevision: '6'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      publicId: 100_000_000_001,
    });
  });

  it('continues bounded Page lifecycle updates around protected and missing rows', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('edge_integration_mode', 'enabled', 'string', ?)
    `).run(NOW.toISOString());
    const rootId = '1'.repeat(32);
    const childId = '3'.repeat(32);
    const trashedId = '6'.repeat(32);
    await insertPage({ db: d1, id: rootId, revision: '2'.repeat(32) });
    await insertPage({
      db: d1,
      id: childId,
      revision: '4'.repeat(32),
      overrides: { parent_id: rootId, title: 'Team', slug: 'team' },
    });
    await insertPage({
      db: d1,
      id: trashedId,
      revision: '7'.repeat(32),
      overrides: { title: 'Old', slug: 'old', status: 'trash' },
    });

    const result = await updatePageBulkLifecycle({
      db: d1,
      request: {
        target_status: 'trash',
        items: [
          { id: rootId, expected_revision: '2'.repeat(32) },
          { id: childId, expected_revision: '4'.repeat(32) },
          { id: trashedId, expected_revision: '0'.repeat(32) },
          { id: '9'.repeat(32), expected_revision: '0'.repeat(32) },
        ],
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '5'.repeat(32),
    });
    expect(result).toEqual({
      target_status: 'trash',
      results: [
        { id: rootId, outcome: 'skipped', reason: 'has_children' },
        {
          id: childId,
          outcome: 'updated',
          status: 'trash',
          revision: '5'.repeat(32),
        },
        {
          id: trashedId,
          outcome: 'unchanged',
          status: 'trash',
          revision: '7'.repeat(32),
        },
        { id: '9'.repeat(32), outcome: 'skipped', reason: 'not_found' },
      ],
      summary: {
        requested: 4,
        updated: 1,
        unchanged: 1,
        conflict: 0,
        skipped: 2,
      },
    });
    expect(database.prepare(`
      SELECT status, revision FROM pages WHERE id = ?
    `).get(childId)).toEqual({ status: 'trash', revision: '5'.repeat(32) });
    expect(database.prepare(`
      SELECT revision FROM page_search_fts
      WHERE rowid = (SELECT public_id FROM pages WHERE id = ?)
    `).get(childId)).toEqual({ revision: '5'.repeat(32) });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM page_revisions WHERE page_id = ?
    `).get(childId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 4 });
  });

  it('lists bounded summaries and projects only published paths', async () => {
    const { d1 } = createTestDatabase();
    const rootId = '1'.repeat(32);
    await insertPage({ db: d1, id: rootId, revision: '2'.repeat(32) });
    await insertPage({
      db: d1,
      id: '3'.repeat(32),
      revision: '4'.repeat(32),
      overrides: {
        parent_id: rootId,
        title: 'Published Team',
        slug: 'team',
        status: 'published',
        allow_comments: true,
      },
    });
    await insertPage({
      db: d1,
      id: '5'.repeat(32),
      revision: '6'.repeat(32),
      overrides: { title: 'Discarded', slug: 'discarded', status: 'trash' },
    });
    await expect(listPages({
      db: d1,
      query: { ...defaultQuery, search: 'Published', status: 'published' },
    })).resolves.toMatchObject({
      items: [{ path: 'about/team', status: 'published' }],
      pagination: { total: 1 },
      status_counts: { all: 1, draft: 0, published: 1, trash: 0 },
    });
    const previewPages = await listPreviewPages({ db: d1 });
    expect(previewPages).toHaveLength(1);
    expect(previewPages).toMatchObject([
      { path: 'about/team', status: 'published', allow_comments: true },
    ]);
  });

  it('keeps normal and equal-rank search results in deterministic creation order', async () => {
    const { d1 } = createTestDatabase();
    const olderId = '1'.repeat(32);
    const firstNewerId = '8'.repeat(32);
    const secondNewerId = '6'.repeat(32);
    const shared = {
      title: 'Shared ordering title',
      content: 'Shared ordering body',
      excerpt: 'Shared ordering excerpt',
    };
    await createPage({
      db: d1,
      authored: authored({ ...shared, slug: 'order-a' }),
      now: NOW,
      createId: () => olderId,
      createRevision: () => '2'.repeat(32),
    });
    const newerAt = new Date('2026-08-01T09:00:00.000Z');
    await createPage({
      db: d1,
      authored: authored({ ...shared, slug: 'order-c' }),
      now: newerAt,
      createId: () => firstNewerId,
      createRevision: () => '9'.repeat(32),
    });
    await createPage({
      db: d1,
      authored: authored({ ...shared, slug: 'order-b' }),
      now: newerAt,
      createId: () => secondNewerId,
      createRevision: () => '7'.repeat(32),
    });
    await expect(updatePage({
      db: d1,
      id: olderId,
      authored: {
        ...authored({ ...shared, slug: 'order-a', allow_comments: true }),
        expected_revision: '2'.repeat(32),
      },
      now: new Date('2026-08-01T10:00:00.000Z'),
      createRevision: () => 'a'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });

    const expectedIds = [secondNewerId, firstNewerId, olderId];
    await expect(listPages({ db: d1, query: defaultQuery })).resolves.toMatchObject({
      items: expectedIds.map((id) => ({ id })),
    });
    await expect(listPages({
      db: d1,
      query: { ...defaultQuery, search: 'Shared ordering' },
    })).resolves.toMatchObject({
      items: expectedIds.map((id) => ({ id })),
    });
  });

  it('searches reader-visible Page content and returns a plain-text context', async () => {
    const { d1 } = createTestDatabase();
    await insertPage({
      db: d1,
      id: '1'.repeat(32),
      revision: '2'.repeat(32),
      overrides: {
        title: 'Operations',
        slug: 'operations',
        content: '# 데이터베이스\n\nRead [the recovery guide](https://private.example/recovery).',
        excerpt: '',
        document_type: 'markdown',
        status: 'published',
      },
    });
    const result = await listPages({
      db: d1,
      query: { ...defaultQuery, search: '데이터베이스 recovery' },
    });
    expect(result).toMatchObject({
      items: [{
        path: 'operations',
        search_match: {
          field: 'content',
          text: '데이터베이스 Read the recovery guide.',
        },
      }],
      pagination: { total: 1 },
    });
    await expect(listPages({
      db: d1,
      query: { ...defaultQuery, search: 'private.example' },
    })).resolves.toMatchObject({ items: [], pagination: { total: 0 } });
  });

  it('preserves revision and timestamp on a no-op update', async () => {
    const { d1 } = createTestDatabase();
    const id = '1'.repeat(32);
    await insertPage({ db: d1, id, revision: '2'.repeat(32) });
    await expect(updatePage({
      db: d1,
      id,
      authored: {
        ...authored(),
        expected_revision: '2'.repeat(32),
      },
      now: new Date('2026-08-01T10:00:00.000Z'),
      createRevision: () => '3'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      page: {
        revision: '2'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
  });

  it('protects the configured Front Page from unpublishing and deletion', async () => {
    const { database, d1 } = createTestDatabase();
    const pageId = '1'.repeat(32);
    const userId = 'a'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, 'owner@example.com', 'hash', ?, 'Studio Owner',
                'active', 1, ?, ?)
    `).run(userId, 'b'.repeat(32), NOW.toISOString(), NOW.toISOString());
    await insertPage({
      db: d1,
      id: pageId,
      revision: '2'.repeat(32),
      overrides: { status: 'published' },
    });
    const defaults = materializeRoutingSettingsDefaults();
    await updateRoutingSettings({
      db: d1,
      settings: {
        ...defaults,
        front_page: { type: 'page', page_id: pageId },
        post_index: { ...defaults.post_index, path: '/blog/' },
      },
      expectedRevision: ROUTING_SETTINGS_INITIAL_REVISION,
      updatedBy: userId,
      now: NOW,
      createRevision: () => 'c'.repeat(32),
    });

    await expect(updatePage({
      db: d1,
      id: pageId,
      authored: {
        ...authored({ status: 'draft' }),
        expected_revision: '2'.repeat(32),
      },
    })).resolves.toEqual({ kind: 'front_page_protected' });

    database.prepare("UPDATE pages SET status = 'trash' WHERE id = ?")
      .run(pageId);
    await expect(deletePage({
      db: d1,
      id: pageId,
      expectedRevision: '2'.repeat(32),
    })).resolves.toEqual({ kind: 'front_page_protected' });
  });
});
