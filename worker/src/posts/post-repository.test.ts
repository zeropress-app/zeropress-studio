import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ZEROPRESS_NATIVE_PUBLIC_ID_BASE,
  createPostRequestSchema,
  type PostListQuery,
  type UpdatePostRequest,
} from '../../../contracts/posts';
import { normalizePostContentSnapshot } from '../../../contracts/post-autosaves';
import {
  createPost,
  deletePost,
  getPost,
  listPostEditorOptions,
  listPosts,
  listPreviewPosts,
  updatePost,
  updatePostBulkLifecycle,
} from './post-repository';
import {
  listPostRevisions,
  readPostRevision,
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
const AUTHOR_ID = 'site-author';
const CATEGORY_ID = '1'.repeat(32);
const TAG_A_ID = '2'.repeat(32);
const TAG_B_ID = '3'.repeat(32);
const MEDIA_ID = '8'.repeat(32);

function seedRelations(database: DatabaseSync) {
  const now = NOW.toISOString();
  database.prepare(`
    INSERT INTO authors (
      id, user_id, display_name, revision, created_at_iso, updated_at_iso
    ) VALUES (?, NULL, 'Site Author', ?, ?, ?)
  `).run(AUTHOR_ID, 'a'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO categories (
      id, name, slug, description, revision, created_at_iso, updated_at_iso
    ) VALUES (?, 'News', 'news', '', ?, ?, ?)
  `).run(CATEGORY_ID, 'b'.repeat(32), now, now);
  database.prepare(`
    INSERT INTO tags (
      id, name, slug, description, revision, created_at_iso, updated_at_iso
    ) VALUES
      (?, 'Alpha', 'alpha', '', ?, ?, ?),
      (?, 'Beta', 'beta', '', ?, ?, ?)
  `).run(
    TAG_A_ID, 'c'.repeat(32), now, now,
    TAG_B_ID, 'd'.repeat(32), now, now,
  );
}

function seedMedia(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO media (
      id, kind, filename, mime_type, storage_type, storage_key, external_url,
      size_bytes, width, height, duration_ms, alt, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'image', 'hero.jpg', 'image/jpeg', 'external', NULL,
      'https://media.example/uploads/hero.jpg', NULL, 1600, 900, NULL,
      'Hero', ?, ?, ?)
  `).run(MEDIA_ID, '8'.repeat(32), NOW.toISOString(), NOW.toISOString());
}

function authored(overrides: Record<string, unknown> = {}) {
  return createPostRequestSchema.parse({
    title: 'First Post',
    slug: 'first-post',
    content: '# First',
    document_type: 'markdown',
    editor_mode: 'source',
    editor_profile: null,
    excerpt: 'Summary.',
    status: 'draft',
    author_id: AUTHOR_ID,
    category_ids: [CATEGORY_ID],
    tag_ids: [TAG_B_ID, TAG_A_ID],
    discoverability: 'default',
    allow_comments: true,
    featured_image_id: null,
    ...overrides,
  });
}

const defaultQuery: PostListQuery = {
  search: '',
  status: 'all',
  page: 1,
  per_page: 50,
};

describe('Post D1 repository', () => {
  it('accepts trigger-inclusive D1 change counts for permanent deletion', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('edge_integration_mode', 'enabled', 'string', ?)
    `).run(NOW.toISOString());
    const postId = '4'.repeat(32);
    const revision = '5'.repeat(32);
    await expect(createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => revision,
    })).resolves.toMatchObject({ kind: 'completed' });
    database.prepare("UPDATE posts SET status = 'trash' WHERE id = ?")
      .run(postId);
    await expect(deletePost({
      db: d1,
      id: postId,
      expectedRevision: revision,
    })).resolves.toMatchObject({ kind: 'completed' });

    expect(database.prepare(`
      SELECT operation FROM edge_comment_target_projection_outbox ORDER BY id
    `).all()).toEqual([{ operation: 'upsert' }, { operation: 'delete' }]);
  });

  it('atomically removes the new-draft autosave after canonical creation', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
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
      INSERT INTO post_autosaves (
        user_id, draft_id, post_id, base_revision, snapshot_version,
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
    expect(await createPost({
      db: d1,
      authored: authored({ autosave_draft_id: draftId }),
      autosaveUserId: userId,
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    })).toMatchObject({ kind: 'completed' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM post_autosaves').get())
      .toEqual({ count: 0 });
  });

  it('atomically promotes and binds a matching recovery snapshot as a Draft', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
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
      INSERT INTO post_autosaves (
        user_id, draft_id, post_id, base_revision, snapshot_version,
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
    const result = await createPost({
      db: d1,
      authored: authored({ autosave_draft_id: draftId }),
      autosaveUserId: userId,
      bindAutosaveSnapshotSha256: digest,
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    });
    expect(result).toMatchObject({ kind: 'completed', post: { status: 'draft' } });
    expect(database.prepare(`
      SELECT post_id, base_revision, expires_at_iso
      FROM post_autosaves WHERE user_id = ? AND draft_id = ?
    `).get(userId, draftId)).toEqual({
      post_id: '6'.repeat(32),
      base_revision: '7'.repeat(32),
      expires_at_iso: null,
    });
  });

  it('does not create a Draft when the autosave changed before promotion', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
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
      INSERT INTO post_autosaves (
        user_id, draft_id, post_id, base_revision, snapshot_version,
        snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso,
        expires_at_iso
      ) VALUES (?, ?, NULL, NULL, 1, '{}', ?, ?, ?, ?)
    `).run(
      userId,
      draftId,
      'a'.repeat(64),
      NOW.toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    await expect(createPost({
      db: d1,
      authored: authored({ autosave_draft_id: draftId }),
      autosaveUserId: userId,
      bindAutosaveSnapshotSha256: 'b'.repeat(64),
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    })).resolves.toEqual({ kind: 'autosave_conflict' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM posts').get())
      .toEqual({ count: 0 });
  });

  it('allocates non-reusable native public IDs and stores relations atomically', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    seedMedia(database);
    const result = await createPost({
      db: d1,
      authored: authored({ featured_image_id: MEDIA_ID }),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      post: {
        public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 1,
        categories: [{ slug: 'news' }],
        tags: [{ slug: 'beta' }, { slug: 'alpha' }],
        featured_image: {
          id: MEDIA_ID,
          kind: 'image',
          filename: 'hero.jpg',
          mime_type: 'image/jpeg',
          location: {
            type: 'external',
            url: 'https://media.example/uploads/hero.jpg',
          },
          width: 1600,
          height: 900,
          alt: 'Hero',
        },
      },
    });
    expect(database.prepare(`
      SELECT last_public_id
      FROM content_public_id_counters
      WHERE content_type = 'post'
    `).get()).toEqual({
      last_public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 1,
    });

    database.prepare("UPDATE posts SET status = 'trash'").run();
    database.prepare('DELETE FROM posts').run();
    const second = await createPost({
      db: d1,
      authored: authored({ slug: 'second-post' }),
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    });
    expect(second).toMatchObject({
      kind: 'completed',
      post: { public_id: ZEROPRESS_NATIVE_PUBLIC_ID_BASE + 2 },
    });
  });

  it('updates scalar and ordered relation state with optimistic revisions', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    const update = {
      ...authored({
        title: 'Published Post',
        status: 'published',
        tag_ids: [TAG_A_ID, TAG_B_ID],
      }),
      expected_revision: '5'.repeat(32),
    } satisfies UpdatePostRequest;
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: update,
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '6'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      post: {
        title: 'Published Post',
        status: 'published',
        published_at_iso: '2026-08-01T09:00:00.000Z',
        revision: '6'.repeat(32),
        tags: [{ slug: 'alpha' }, { slug: 'beta' }],
      },
    });
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: update,
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_tags WHERE post_id = ?
    `).get('4'.repeat(32))).toEqual({ count: 2 });
  });

  it('converges bounded lifecycle retries while preserving autosaves and derived state', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('edge_integration_mode', 'enabled', 'string', ?)
    `).run(NOW.toISOString());
    const firstId = '4'.repeat(32);
    const secondId = '6'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => firstId,
      createRevision: () => '5'.repeat(32),
    });
    await createPost({
      db: d1,
      authored: authored({
        title: 'Already published',
        slug: 'already-published',
        status: 'published',
      }),
      now: NOW,
      createId: () => secondId,
      createRevision: () => '7'.repeat(32),
    });
    const userId = '9'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, failed_login_attempts, created_at_iso, updated_at_iso
      ) VALUES (?, 'editor@example.com', 'hash', ?, 'Site Editor', 'active',
        1, 0, ?, ?)
    `).run(userId, 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO post_autosaves (
        user_id, draft_id, post_id, base_revision, snapshot_version,
        snapshot_json, snapshot_sha256, created_at_iso, updated_at_iso,
        expires_at_iso
      ) VALUES (?, ?, ?, ?, 2, '{}', ?, ?, ?, NULL)
    `).run(
      userId,
      'a'.repeat(32),
      firstId,
      '5'.repeat(32),
      'b'.repeat(64),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    const result = await updatePostBulkLifecycle({
      db: d1,
      request: {
        target_status: 'published',
        items: [
          { id: firstId, expected_revision: '5'.repeat(32) },
          { id: secondId, expected_revision: '0'.repeat(32) },
          { id: '8'.repeat(32), expected_revision: '0'.repeat(32) },
        ],
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '8'.repeat(32),
    });
    expect(result).toEqual({
      target_status: 'published',
      results: [
        {
          id: firstId,
          outcome: 'updated',
          status: 'published',
          revision: '8'.repeat(32),
        },
        {
          id: secondId,
          outcome: 'unchanged',
          status: 'published',
          revision: '7'.repeat(32),
        },
        { id: '8'.repeat(32), outcome: 'skipped', reason: 'not_found' },
      ],
      summary: {
        requested: 3,
        updated: 1,
        unchanged: 1,
        conflict: 0,
        skipped: 1,
      },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_autosaves WHERE post_id = ?
    `).get(firstId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT revision FROM post_search_fts
      WHERE rowid = (SELECT public_id FROM posts WHERE id = ?)
    `).get(firstId)).toEqual({ revision: '8'.repeat(32) });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_revisions WHERE post_id = ?
    `).get(firstId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT operation FROM edge_comment_target_projection_outbox ORDER BY id
    `).all()).toEqual([
      { operation: 'upsert' },
      { operation: 'upsert' },
      { operation: 'upsert' },
    ]);

    await expect(updatePostBulkLifecycle({
      db: d1,
      request: {
        target_status: 'published',
        items: [{ id: firstId, expected_revision: '5'.repeat(32) }],
      },
      createRevision: () => {
        throw new TypeError('A converged retry must not create a revision.');
      },
    })).resolves.toMatchObject({
      results: [{ outcome: 'unchanged', revision: '8'.repeat(32) }],
    });
  });

  it('archives an editor-mode-only change and treats its exact replay as a no-op', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    const nextRevision = '6'.repeat(32);
    const visual = authored({
      content: '<p>Hello</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    await createPost({
      db: d1,
      authored: visual,
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    const source = {
      ...visual,
      editor_mode: 'source' as const,
      editor_profile: null,
      expected_revision: initialRevision,
    } satisfies UpdatePostRequest;
    const changed = await updatePost({
      db: d1,
      id: postId,
      authored: source,
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => nextRevision,
    });
    expect(changed).toMatchObject({
      kind: 'completed',
      post: {
        revision: nextRevision,
        editor_mode: 'source',
        editor_profile: null,
      },
    });
    expect(database.prepare(`
      SELECT snapshot_version,
        json_extract(snapshot_json, '$.draft.editor_mode') AS editor_mode,
        json_extract(snapshot_json, '$.draft.editor_profile') AS editor_profile
      FROM post_revisions WHERE post_id = ?
    `).get(postId)).toEqual({
      snapshot_version: 2,
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });

    const repeated = await updatePost({
      db: d1,
      id: postId,
      authored: { ...source, expected_revision: nextRevision },
      createRevision: () => {
        throw new TypeError('A no-op must not allocate a revision.');
      },
    });
    expect(repeated).toMatchObject({
      kind: 'completed',
      post: { revision: nextRevision },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_revisions WHERE post_id = ?
    `).get(postId)).toEqual({ count: 1 });
  });

  it('changes document type only when both stored and requested content are empty', async () => {
    const emptyDatabase = createTestDatabase();
    seedRelations(emptyDatabase.database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    const emptyHtml = authored({
      content: '',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    await createPost({
      db: emptyDatabase.d1,
      authored: emptyHtml,
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    await expect(updatePost({
      db: emptyDatabase.d1,
      id: postId,
      authored: {
        ...emptyHtml,
        document_type: 'markdown',
        editor_mode: 'source',
        editor_profile: null,
        expected_revision: initialRevision,
      },
      createRevision: () => '6'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      post: { document_type: 'markdown' },
    });

    const nonemptyDatabase = createTestDatabase();
    seedRelations(nonemptyDatabase.database);
    await createPost({
      db: nonemptyDatabase.d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    await expect(updatePost({
      db: nonemptyDatabase.d1,
      id: postId,
      authored: {
        ...authored(),
        content: '',
        document_type: 'html',
        editor_mode: 'source',
        editor_profile: null,
        expected_revision: initialRevision,
      },
    })).resolves.toEqual({ kind: 'document_type_change_forbidden' });
  });

  it('archives the exact prior Post snapshot and exposes current plus history', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    const nextRevision = '6'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    const savedAt = new Date('2026-08-01T09:00:00.000Z');
    const update = await updatePost({
      db: d1,
      id: postId,
      authored: {
        ...authored({ title: 'Second title', content: '# Second' }),
        expected_revision: initialRevision,
      },
      now: savedAt,
      createRevision: () => nextRevision,
    });
    expect(update).toMatchObject({ kind: 'completed' });
    if (update.kind !== 'completed') throw new TypeError('Post update failed.');

    await expect(listPostRevisions({ db: d1, post: update.post }))
      .resolves.toMatchObject({
        current_revision: nextRevision,
        items: [
          { revision_id: nextRevision, current: true, title: 'Second title' },
          { revision_id: initialRevision, current: false, title: 'First Post' },
        ],
      });
    await expect(readPostRevision({
      db: d1,
      post: update.post,
      revisionId: initialRevision,
    })).resolves.toMatchObject({
      revision_id: initialRevision,
      current: false,
      snapshot: {
        content_type: 'post',
        draft: {
          title: 'First Post',
          content: '# First',
          tag_ids: [TAG_B_ID, TAG_A_ID],
        },
        references: {
          author: { id: AUTHOR_ID, display_name: 'Site Author' },
          categories: [{ id: CATEGORY_ID, slug: 'news' }],
          tags: [{ id: TAG_B_ID }, { id: TAG_A_ID }],
        },
      },
      snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(database.prepare(`
      SELECT saved_at_iso, archived_at_iso FROM post_revisions
      WHERE post_id = ? AND revision_id = ?
    `).get(postId, initialRevision)).toEqual({
      saved_at_iso: NOW.toISOString(),
      archived_at_iso: savedAt.toISOString(),
    });
  });

  it('retains only the 20 most recently archived Post snapshots', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    let revision = initialRevision;
    let latestPost = await getPost({ db: d1, id: postId });
    for (let index = 1; index <= 21; index += 1) {
      const nextRevision = (index + 5).toString(16).padStart(32, '0');
      const result = await updatePost({
        db: d1,
        id: postId,
        authored: {
          ...authored({ title: `Saved state ${index}` }),
          expected_revision: revision,
        },
        now: new Date(NOW.getTime() + index * 60_000),
        createRevision: () => nextRevision,
      });
      expect(result).toMatchObject({ kind: 'completed' });
      if (result.kind !== 'completed') throw new TypeError('Post update failed.');
      revision = nextRevision;
      latestPost = result.post;
    }
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_revisions WHERE post_id = ?
    `).get(postId)).toEqual({ count: 20 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM post_revisions
      WHERE post_id = ? AND revision_id = ?
    `).get(postId, initialRevision)).toEqual({ count: 0 });
    if (!latestPost) throw new TypeError('Updated Post was not returned.');
    const list = await listPostRevisions({ db: d1, post: latestPost });
    expect(list.items).toHaveLength(21);
    expect(list.items[0]).toMatchObject({ revision_id: revision, current: true });
    expect(list.items[1]).toMatchObject({
      revision_id: (25).toString(16).padStart(32, '0'),
      current: false,
    });
  });

  it('restores a saved snapshot as a new current revision without rewriting history', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    const secondRevision = '6'.repeat(32);
    const restoredRevision = '7'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    const second = await updatePost({
      db: d1,
      id: postId,
      authored: {
        ...authored({ title: 'Second title', content: '# Second' }),
        expected_revision: initialRevision,
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => secondRevision,
    });
    if (second.kind !== 'completed') throw new TypeError('Post update failed.');
    const selected = await readPostRevision({
      db: d1,
      post: second.post,
      revisionId: initialRevision,
    });
    if (!selected) throw new TypeError('Saved revision was not found.');
    const restored = await updatePost({
      db: d1,
      id: postId,
      authored: {
        ...normalizePostContentSnapshot(selected.snapshot).draft,
        expected_revision: secondRevision,
      },
      now: new Date('2026-08-01T10:00:00.000Z'),
      createRevision: () => restoredRevision,
    });
    expect(restored).toMatchObject({
      kind: 'completed',
      post: {
        title: 'First Post',
        content: '# First',
        revision: restoredRevision,
      },
    });
    expect(database.prepare(`
      SELECT revision_id, json_extract(snapshot_json, '$.draft.title') AS title
      FROM post_revisions WHERE post_id = ? ORDER BY archived_at_iso
    `).all(postId)).toEqual([
      { revision_id: initialRevision, title: 'First Post' },
      { revision_id: secondRevision, title: 'Second title' },
    ]);
  });

  it('rolls back canonical Post changes when revision archival fails', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const revision = '5'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => revision,
    });
    database.exec(`
      CREATE TRIGGER fail_post_revision_archive
      BEFORE INSERT ON post_revisions
      BEGIN
        SELECT RAISE(ABORT, 'forced revision archive failure');
      END
    `);
    await expect(updatePost({
      db: d1,
      id: postId,
      authored: {
        ...authored({ title: 'Must roll back' }),
        expected_revision: revision,
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '6'.repeat(32),
    })).rejects.toMatchObject({ code: 'POST_MANAGEMENT_DATABASE_WRITE_FAILED' });
    await expect(getPost({ db: d1, id: postId })).resolves.toMatchObject({
      title: 'First Post',
      revision,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM post_revisions').get())
      .toEqual({ count: 0 });
  });

  it('fails closed when a stored Post revision integrity digest is corrupted', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const postId = '4'.repeat(32);
    const initialRevision = '5'.repeat(32);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => postId,
      createRevision: () => initialRevision,
    });
    const updated = await updatePost({
      db: d1,
      id: postId,
      authored: {
        ...authored({ title: 'Second title' }),
        expected_revision: initialRevision,
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '6'.repeat(32),
    });
    if (updated.kind !== 'completed') throw new TypeError('Post update failed.');
    database.prepare(`
      UPDATE post_revisions SET snapshot_sha256 = ?
      WHERE post_id = ? AND revision_id = ?
    `).run('0'.repeat(64), postId, initialRevision);
    await expect(readPostRevision({
      db: d1,
      post: updated.post,
      revisionId: initialRevision,
    })).rejects.toMatchObject({ code: 'POST_MANAGEMENT_DATA_INVALID' });
  });

  it('returns relation and slug conflicts without partial Posts', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await expect(createPost({
      db: d1,
      authored: authored({ author_id: 'missing-author' }),
      now: NOW,
    })).resolves.toEqual({ kind: 'author_not_found' });
    await expect(createPost({
      db: d1,
      authored: authored({ category_ids: ['9'.repeat(32)] }),
      now: NOW,
    })).resolves.toEqual({ kind: 'category_not_found' });
    await expect(createPost({
      db: d1,
      authored: authored({ featured_image_id: '9'.repeat(32) }),
      now: NOW,
    })).resolves.toEqual({ kind: 'media_not_found' });
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await expect(createPost({
      db: d1,
      authored: authored(),
      now: NOW,
    })).resolves.toEqual({ kind: 'slug_conflict' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM posts').get())
      .toEqual({ count: 1 });
  });

  it('lists with search/status counts and bounded editor options', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await createPost({
      db: d1,
      authored: authored({
        title: 'Published Product',
        slug: 'published-product',
        status: 'published',
      }),
      now: new Date('2026-08-01T09:00:00.000Z'),
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    });
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES ('second-author', NULL, 'Second Author', ?, ?, ?)
    `).run('8'.repeat(32), NOW.toISOString(), NOW.toISOString());
    await createPost({
      db: d1,
      authored: authored({
        title: 'Second Author Draft',
        slug: 'second-author-draft',
        author_id: 'second-author',
      }),
      now: new Date('2026-08-01T10:00:00.000Z'),
      createId: () => '9'.repeat(32),
      createRevision: () => 'a'.repeat(32),
    });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'Product', status: 'published' },
    })).resolves.toMatchObject({
      items: [{ slug: 'published-product' }],
      pagination: { total: 1 },
      status_counts: { all: 1, draft: 0, published: 1, trash: 0 },
    });
    await expect(listPosts({
      db: d1,
      query: defaultQuery,
      authorId: AUTHOR_ID,
    })).resolves.toMatchObject({
      items: [{ author: { id: AUTHOR_ID } }, { author: { id: AUTHOR_ID } }],
      pagination: { total: 2 },
      status_counts: { all: 2, draft: 1, published: 1, trash: 0 },
    });
    await expect(listPosts({
      db: d1,
      query: defaultQuery,
      authorId: 'second-author',
    })).resolves.toMatchObject({
      items: [{ author: { id: 'second-author' } }],
      pagination: { total: 1 },
      status_counts: { all: 1, draft: 1, published: 0, trash: 0 },
    });
    await expect(listPostEditorOptions({
      db: d1,
      kind: 'tag',
      search: 'Bet',
    })).resolves.toEqual([{
      kind: 'tag',
      id: TAG_B_ID,
      label: 'Beta',
      slug: 'beta',
    }]);
  });

  it('keeps normal and equal-rank search results in deterministic creation order', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const olderId = '4'.repeat(32);
    const firstNewerId = '8'.repeat(32);
    const secondNewerId = '6'.repeat(32);
    const shared = {
      title: 'Shared ordering title',
      content: 'Shared ordering body',
      excerpt: 'Shared ordering excerpt',
    };
    await createPost({
      db: d1,
      authored: authored({ ...shared, slug: 'order-a' }),
      now: NOW,
      createId: () => olderId,
      createRevision: () => '5'.repeat(32),
    });
    const newerAt = new Date('2026-08-01T09:00:00.000Z');
    await createPost({
      db: d1,
      authored: authored({ ...shared, slug: 'order-c' }),
      now: newerAt,
      createId: () => firstNewerId,
      createRevision: () => '9'.repeat(32),
    });
    await createPost({
      db: d1,
      authored: authored({ ...shared, slug: 'order-b' }),
      now: newerAt,
      createId: () => secondNewerId,
      createRevision: () => '7'.repeat(32),
    });
    await expect(updatePost({
      db: d1,
      id: olderId,
      authored: {
        ...authored({ ...shared, slug: 'order-a', allow_comments: false }),
        expected_revision: '5'.repeat(32),
      },
      now: new Date('2026-08-01T10:00:00.000Z'),
      createRevision: () => 'a'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });

    const expectedIds = [secondNewerId, firstNewerId, olderId];
    await expect(listPosts({ db: d1, query: defaultQuery })).resolves.toMatchObject({
      items: expectedIds.map((id) => ({ id })),
    });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'Shared ordering' },
    })).resolves.toMatchObject({
      items: expectedIds.map((id) => ({ id })),
    });
  });

  it('supports long UTF-8 literal contains searches without D1 LIKE patterns', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const title = 'Ubuntu 24.04 LTS 에서 웹서버(Apache + PHP + MySQL) 구성하기';
    await createPost({
      db: d1,
      authored: authored({
        title,
        slug: 'ubuntu-24.04-lts-web-server',
        status: 'published',
      }),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });

    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: title },
    })).resolves.toMatchObject({
      items: [{ title }],
      pagination: { total: 1 },
      status_counts: { all: 1, draft: 0, published: 1, trash: 0 },
    });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'ubuntu 24.04 lts' },
    })).resolves.toMatchObject({ items: [{ title }], pagination: { total: 1 } });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'Apache PHP MySQL' },
    })).resolves.toMatchObject({ items: [{ title }], pagination: { total: 1 } });
  });

  it('searches visible body text with AND semantics and safe plain snippets', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored({
        title: 'Apache operations',
        slug: 'server-guide',
        excerpt: 'PHP deployment notes',
        content: '<p>Café MySQL 운영 문서입니다.</p><script>privateSearchToken</script>',
        document_type: 'html',
        status: 'published',
      }),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });

    const distributed = await listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'Apache PHP MySQL' },
    });
    expect(distributed).toMatchObject({
      items: [{
        slug: 'server-guide',
        search_match: {
          field: 'excerpt',
          text: 'PHP deployment notes',
        },
      }],
      pagination: { total: 1 },
    });
    const accent = await listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'cafe' },
    });
    expect(accent.items[0]?.search_match).toEqual({
      field: 'content',
      text: 'Café MySQL 운영 문서입니다.',
      highlights: [{ start: 0, end: 4 }],
    });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'privateSearchToken' },
    })).resolves.toMatchObject({ items: [], pagination: { total: 0 } });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: '운영' },
    })).resolves.toMatchObject({ items: [{ slug: 'server-guide' }] });
  });

  it('uses weighted relevance and returns no redundant context for metadata hits', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const documents = [
      { title: 'Needle title', slug: 'rank-title', excerpt: '', content: '' },
      { title: 'Slug result', slug: 'needle-slug', excerpt: '', content: '' },
      { title: 'Excerpt result', slug: 'rank-excerpt', excerpt: 'Needle summary', content: '' },
      { title: 'Body result', slug: 'rank-body', excerpt: '', content: 'Needle body' },
    ];
    for (const [index, document] of documents.entries()) {
      await createPost({
        db: d1,
        authored: authored({ ...document, status: 'published' }),
        now: NOW,
        createId: () => (index + 4).toString(16).repeat(32),
        createRevision: () => (index + 10).toString(16).repeat(32),
      });
    }

    const result = await listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'needle' },
    });
    expect(result.items.map(({ slug }) => slug)).toEqual([
      'rank-title', 'needle-slug', 'rank-excerpt', 'rank-body',
    ]);
    expect(result.items.map(({ search_match }) => search_match?.field ?? null))
      .toEqual([null, null, 'excerpt', 'content']);
  });

  it('supports literal technology names and rejects a non-ready derived index', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored({
        title: 'C++ and C# handbook',
        slug: 'cpp-csharp-handbook',
      }),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'C++ C#' },
    })).resolves.toMatchObject({ items: [{ slug: 'cpp-csharp-handbook' }] });
    database.prepare(`
      UPDATE content_search_index_state
      SET state = 'rebuild_required', reason = 'schema_upgrade'
      WHERE id = 1
    `).run();
    await expect(listPosts({
      db: d1,
      query: { ...defaultQuery, search: 'handbook' },
    })).rejects.toMatchObject({
      name: 'ContentSearchIndexNotReadyError',
      state: 'rebuild_required',
    });
  });

  it('enforces the linked Author scope at repository write boundaries', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    const userId = '9'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, failed_login_attempts, created_at_iso, updated_at_iso
      ) VALUES (?, 'author@example.com', 'hash', ?, 'Site Author', 'active',
        1, 0, ?, ?)
    `).run(userId, 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());
    database.prepare('UPDATE authors SET user_id = ? WHERE id = ?')
      .run(userId, AUTHOR_ID);
    const authorScope = { authorId: AUTHOR_ID, userId };
    const created = await createPost({
      db: d1,
      authored: authored(),
      authorScope,
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    expect(created).toMatchObject({ kind: 'completed' });
    await expect(createPost({
      db: d1,
      authored: authored({ author_id: 'another-author' }),
      authorScope,
    })).resolves.toEqual({ kind: 'author_scope_changed' });
    await expect(listPosts({
      db: d1,
      query: defaultQuery,
      authorId: AUTHOR_ID,
    })).resolves.toMatchObject({
      items: [{ id: '4'.repeat(32), author: { id: AUTHOR_ID } }],
      status_counts: { all: 1 },
    });
    await expect(listPosts({
      db: d1,
      query: defaultQuery,
      authorId: null,
    })).resolves.toMatchObject({ items: [], status_counts: { all: 0 } });

    database.prepare('UPDATE authors SET user_id = NULL WHERE id = ?')
      .run(AUTHOR_ID);
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: {
        ...authored({ title: 'Must not be written' }),
        expected_revision: '5'.repeat(32),
      },
      authorScope,
    })).resolves.toEqual({ kind: 'author_scope_changed' });
    await expect(deletePost({
      db: d1,
      id: '4'.repeat(32),
      expectedRevision: '5'.repeat(32),
      authorScope,
    })).resolves.toEqual({ kind: 'not_found' });
    expect(database.prepare('SELECT title FROM posts WHERE id = ?')
      .get('4'.repeat(32))).toEqual({ title: 'First Post' });

    const successorUserId = '8'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, failed_login_attempts, created_at_iso, updated_at_iso
      ) VALUES (?, 'successor@example.com', 'hash', ?, 'Successor', 'active',
        1, 0, ?, ?)
    `).run(
      successorUserId,
      'f'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    database.prepare('UPDATE authors SET user_id = ? WHERE id = ?')
      .run(successorUserId, AUTHOR_ID);
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: {
        ...authored({ title: 'Old account cannot write' }),
        expected_revision: '5'.repeat(32),
      },
      authorScope,
    })).resolves.toEqual({ kind: 'author_scope_changed' });
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: {
        ...authored({ title: 'New account owns the workspace' }),
        expected_revision: '5'.repeat(32),
      },
      authorScope: { authorId: AUTHOR_ID, userId: successorUserId },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '6'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      post: { title: 'New account owns the workspace' },
    });
  });

  it('moves scoped visibility when a manager reassigns the Post Author', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES ('next-author', NULL, 'Next Author', ?, ?, ?)
    `).run('b'.repeat(32), NOW.toISOString(), NOW.toISOString());
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await expect(updatePost({
      db: d1,
      id: '4'.repeat(32),
      authored: {
        ...authored({ author_id: 'next-author' }),
        expected_revision: '5'.repeat(32),
      },
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '6'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      post: { author: { id: 'next-author' } },
    });
    await expect(getPost({
      db: d1,
      id: '4'.repeat(32),
      authorId: AUTHOR_ID,
    })).resolves.toBeNull();
    await expect(getPost({
      db: d1,
      id: '4'.repeat(32),
      authorId: 'next-author',
    })).resolves.toMatchObject({ author: { id: 'next-author' } });
  });

  it('projects only published Posts and their referenced Authors', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await createPost({
      db: d1,
      authored: authored({
        title: 'Published',
        slug: 'published',
        status: 'published',
      }),
      now: NOW,
      createId: () => '6'.repeat(32),
      createRevision: () => '7'.repeat(32),
    });
    await createPost({
      db: d1,
      authored: authored({ title: 'Trash', slug: 'trash', status: 'trash' }),
      now: NOW,
      createId: () => '8'.repeat(32),
      createRevision: () => '9'.repeat(32),
    });
    const previewPosts = await listPreviewPosts({ db: d1 });
    expect(previewPosts).toHaveLength(1);
    expect(previewPosts).toMatchObject([{
      slug: 'published',
      status: 'published',
      author: { id: AUTHOR_ID },
      categories: [{ slug: 'news' }],
      tags: [{ slug: 'beta' }, { slug: 'alpha' }],
    }]);
  });

  it('allows permanent deletion only from trash and protects referenced terms', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    await expect(deletePost({
      db: d1,
      id: '4'.repeat(32),
      expectedRevision: '5'.repeat(32),
    })).resolves.toEqual({ kind: 'not_in_trash' });
    expect(() => database.prepare('DELETE FROM categories WHERE id = ?')
      .run(CATEGORY_ID)).toThrow(/foreign key/iu);
    database.prepare("UPDATE posts SET status = 'trash'").run();
    await expect(deletePost({
      db: d1,
      id: '4'.repeat(32),
      expectedRevision: '5'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      publicId: 100_000_000_001,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM post_tags').get())
      .toEqual({ count: 0 });
  });

  it('fails closed for malformed stored Post data', async () => {
    const { database, d1 } = createTestDatabase();
    seedRelations(database);
    await createPost({
      db: d1,
      authored: authored(),
      now: NOW,
      createId: () => '4'.repeat(32),
      createRevision: () => '5'.repeat(32),
    });
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare("UPDATE posts SET slug = '.invalid'").run();
    await expect(getPost({ db: d1, id: '4'.repeat(32) }))
      .rejects.toMatchObject({ code: 'POST_MANAGEMENT_DATA_INVALID' });
  });
});
