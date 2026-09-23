import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import { createPostRequestSchema, updatePostRequestSchema } from '../../../contracts/posts';
import { createPageRequestSchema, updatePageRequestSchema } from '../../../contracts/pages';
import { createPost, updatePost, deletePost, listPosts } from '../posts/post-repository';
import { createPage, updatePage, deletePage, listPages } from '../pages/page-repository';
import { importWxrCoreChunk } from '../imports/wxr-core-import-repository';
import { sqliteD1, type SqliteD1Hooks } from '../test-helpers/sqlite-d1';
import {
  applyContentSearchIndexRebuildStep,
  ContentSearchRebuildError,
  inspectContentSearchIndex,
  readContentSearchRebuildInitiator,
  startContentSearchIndexRebuild,
} from './rebuild';

const NOW = new Date('2026-08-16T01:00:00.000Z');
const INITIATOR = {
  userId: 'a'.repeat(32),
  userEmail: 'administrator@example.com',
} as const;

function createDatabase() {
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
  `).run(NOW.toISOString());
  database.prepare(`
    INSERT INTO authors (
      id, user_id, display_name, revision, created_at_iso, updated_at_iso
    ) VALUES ('site-author', NULL, 'Site Author', ?, ?, ?)
  `).run('b'.repeat(32), NOW.toISOString(), NOW.toISOString());
  const hooks: SqliteD1Hooks = {};
  return { database, hooks, db: sqliteD1(database, hooks) };
}

function insertPost(database: DatabaseSync, publicId: number) {
  database.prepare(`
    INSERT INTO posts (
      id, public_id, title, slug, content, document_type, excerpt,
      status, author_id, revision, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, 'html', '', 'draft', 'site-author', ?, ?, ?)
  `).run(
    publicId.toString(16).padStart(32, '0'),
    publicId,
    `Post ${publicId}`,
    `post-${publicId}`,
    `<p>Visible body ${publicId}</p><script>hidden-${publicId}</script>`,
    publicId.toString(16).padStart(32, 'a').slice(-32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function insertPage(database: DatabaseSync, publicId: number) {
  database.prepare(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type,
      excerpt, status, revision, created_at_iso, updated_at_iso
    ) VALUES (?, ?, NULL, ?, ?, ?, 'markdown', '', 'draft', ?, ?, ?)
  `).run(
    (publicId + 100).toString(16).padStart(32, '0'),
    publicId,
    `Page ${publicId}`,
    `page-${publicId}`,
    `# Page ${publicId}\n\nVisible recovery guide ${publicId}.`,
    (publicId + 100).toString(16).padStart(32, 'c').slice(-32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function stepRequest(status: ContentSearchIndexStatus) {
  if (!status.operation_id || !status.phase) {
    throw new TypeError('Expected an active content-search rebuild.');
  }
  return {
    operation_id: status.operation_id,
    expected_phase: status.phase,
    expected_post_public_id_cursor: status.post_public_id_cursor,
    expected_page_public_id_cursor: status.page_public_id_cursor,
  };
}

async function finishRebuild(input: {
  db: D1Database;
  status: ContentSearchIndexStatus;
}) {
  let status = input.status;
  while (status.state === 'in_progress') {
    status = await applyContentSearchIndexRebuildStep({
      db: input.db,
      request: stepRequest(status),
      now: NOW,
    });
  }
  return status;
}

describe('checkpointed content-search index rebuild', () => {
  it('allows only one dashboard start and preserves the active checkpoint on later attempts', async () => {
    const { database, db } = createDatabase();
    database.exec("UPDATE content_search_index_state SET state = 'rebuild_required'");
    insertPost(database, 1);
    const results = await Promise.allSettled(['d', 'e'].map((id) =>
      startContentSearchIndexRebuild({
        db, initiator: INITIATOR, operationId: id.repeat(32), now: NOW,
        expectedState: 'rebuild_required',
      })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ issue: 'state_conflict' });
    let status = await inspectContentSearchIndex({ db, available: true });
    status = await applyContentSearchIndexRebuildStep({ db, request: stepRequest(status) });
    const checkpoint = status;
    await expect(startContentSearchIndexRebuild({
      db, initiator: INITIATOR, expectedState: 'rebuild_required',
    })).rejects.toMatchObject({ issue: 'state_conflict' });
    expect(await inspectContentSearchIndex({ db, available: true })).toEqual(checkpoint);
    expect(database.prepare('SELECT count(*) AS count FROM post_search_fts').get()).toEqual({ count: 1 });
    await finishRebuild({ db, status });
    await expect(startContentSearchIndexRebuild({
      db, initiator: INITIATOR, expectedState: 'rebuild_required',
    })).rejects.toMatchObject({ issue: 'state_conflict' });
    database.exec("UPDATE content_search_index_state SET state = 'recovery_required'");
    await expect(startContentSearchIndexRebuild({
      db, initiator: INITIATOR, expectedState: 'rebuild_required',
    })).rejects.toMatchObject({ issue: 'state_conflict' });
  });

  it('keeps live edits, deletions, new content and WXR writes made after a rebuild batch reads its rows', async () => {
    const { database, db } = createDatabase();
    for (let id = 1; id <= 3; id++) insertPost(database, id);
    for (let id = 1; id <= 2; id++) insertPage(database, id);
    let status = await startContentSearchIndexRebuild({ db, initiator: INITIATOR });
    const postInput = (title: string) => createPostRequestSchema.parse({
      title, slug: title, content: title, document_type: 'html',
      editor_mode: 'source', editor_profile: null, excerpt: '', status: 'draft',
      author_id: 'site-author', category_ids: [], tag_ids: [], discoverability: 'default',
      allow_comments: false, featured_image_id: null,
    });
    const pageInput = (title: string) => createPageRequestSchema.parse({
      title, slug: title, content: title, document_type: 'markdown',
      editor_mode: 'source', editor_profile: null, excerpt: '', status: 'draft',
      parent_id: null, discoverability: 'default', allow_comments: false, featured_image_id: null,
    });
    const firstPost = database.prepare('SELECT id, revision FROM posts WHERE public_id = 1').get() as { id: string; revision: string };
    const deletedPost = database.prepare('SELECT id, revision FROM posts WHERE public_id = 2').get() as { id: string; revision: string };
    database.exec("UPDATE posts SET status = 'trash' WHERE public_id = 2");
    const batch = db.batch.bind(db);
    const postHook = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      postHook.mockRestore();
      expect(await updatePost({
        db, id: firstPost.id, authored: updatePostRequestSchema.parse({
          ...postInput('latest-post'), expected_revision: firstPost.revision,
        }),
      })).toMatchObject({ kind: 'completed' });
      expect(await deletePost({
        db, id: deletedPost.id, expectedRevision: deletedPost.revision,
      })).toMatchObject({ kind: 'completed' });
      expect(await createPost({ db, authored: postInput('new-post') }))
        .toMatchObject({ kind: 'completed' });
      const wxr = await importWxrCoreChunk({
        db, request: {
          phase: 'posts', rows: [{
            public_id: 3, title: 'Imported update', slug: 'imported-update',
            content: 'latest imported text', document_type: 'html',
            editor_mode: 'source', editor_profile: null, excerpt: '', status: 'draft',
            author_id: 'site-author', category_slugs: [], tag_slugs: [],
            discoverability: 'default', allow_comments: false, featured_image_location: null,
            published_at_iso: null, created_at_iso: NOW.toISOString(), updated_at_iso: NOW.toISOString(),
          }],
        },
      });
      expect(wxr.summary).toMatchObject({ updated: 1, failed: 0 });
      return batch(statements);
    });
    status = await applyContentSearchIndexRebuildStep({ db, request: stepRequest(status) });
    expect(status.phase).toBe('pages');
    expect(database.prepare('SELECT body FROM post_search_fts WHERE rowid = 1').get())
      .toEqual({ body: 'latest-post' });
    expect(database.prepare('SELECT body FROM post_search_fts WHERE rowid = 3').get())
      .toEqual({ body: 'latest imported text' });

    const firstPage = database.prepare('SELECT id, revision FROM pages WHERE public_id = 1').get() as { id: string; revision: string };
    const deletedPage = database.prepare('SELECT id, revision FROM pages WHERE public_id = 2').get() as { id: string; revision: string };
    database.exec("UPDATE pages SET status = 'trash' WHERE public_id = 2");
    const pageHook = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      pageHook.mockRestore();
      expect(await updatePage({
        db, id: firstPage.id, authored: updatePageRequestSchema.parse({
          ...pageInput('latest-page'), expected_revision: firstPage.revision,
        }),
      })).toMatchObject({ kind: 'completed' });
      expect(await deletePage({
        db, id: deletedPage.id, expectedRevision: deletedPage.revision,
      })).toMatchObject({ kind: 'completed' });
      expect(await createPage({ db, authored: pageInput('new-page') }))
        .toMatchObject({ kind: 'completed' });
      return batch(statements);
    });
    status = await applyContentSearchIndexRebuildStep({ db, request: stepRequest(status) });
    expect(status.phase).toBe('verify');
    expect(database.prepare('SELECT body FROM page_search_fts WHERE rowid = 1').get())
      .toEqual({ body: 'latest-page' });
    // Imports can insert a public ID behind an already committed rebuild cursor.
    const imported = await importWxrCoreChunk({
      db, request: {
        phase: 'pages', rows: [{
          public_id: 2, parent_public_id: null, title: 'Imported page', slug: 'imported-page',
          content: 'imported behind cursor', document_type: 'html',
          editor_mode: 'source', editor_profile: null, excerpt: '', status: 'draft',
          discoverability: 'default', allow_comments: false, featured_image_location: null,
          created_at_iso: NOW.toISOString(), updated_at_iso: NOW.toISOString(),
        }],
      },
    });
    expect(imported.summary).toMatchObject({ created: 1, failed: 0 });
    const query = { search: '', status: 'all' as const, page: 1, per_page: 50 };
    await expect(listPosts({ db, query })).resolves.toBeDefined();
    await expect(listPages({ db, query })).resolves.toBeDefined();
    await expect(listPosts({ db, query: { ...query, search: 'latest' } }))
      .rejects.toMatchObject({ state: 'in_progress' });
    await expect(finishRebuild({ db, status })).resolves.toMatchObject({ state: 'ready' });
    for (const [table, index] of [['posts', 'post_search_fts'], ['pages', 'page_search_fts']]) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get())
        .toEqual(database.prepare(`SELECT count(*) AS count FROM ${index}`).get());
      expect(database.prepare(`SELECT count(*) AS count FROM ${table} AS source
        LEFT JOIN ${index} AS indexed ON source.public_id = indexed.rowid AND source.revision = indexed.revision
        WHERE indexed.rowid IS NULL`).get()).toEqual({ count: 0 });
    }
    expect(database.prepare('SELECT body FROM page_search_fts WHERE rowid = 2').get())
      .toEqual({ body: 'imported behind cursor' });
  });

  it('resumes five-row batches after response loss and verifies FTS parity', async () => {
    const { database, db, hooks } = createDatabase();
    for (let id = 1; id <= 7; id += 1) insertPost(database, id);
    for (let id = 1; id <= 6; id += 1) insertPage(database, id);

    const started = await startContentSearchIndexRebuild({
      db,
      initiator: INITIATOR,
      operationId: 'd'.repeat(32),
      now: NOW,
    });
    expect(started).toMatchObject({
      state: 'in_progress',
      phase: 'posts',
      processed_posts: 0,
      total_posts: 7,
      total_pages: 6,
    });
    expect(await readContentSearchRebuildInitiator({
      db,
      operationId: 'd'.repeat(32),
    })).toEqual(INITIATOR);

    const firstRequest = stepRequest(started);
    hooks.throwAfterCommitOnce = true;
    await expect(applyContentSearchIndexRebuildStep({
      db,
      request: firstRequest,
      now: NOW,
    })).rejects.toMatchObject({
      name: 'ContentSearchRebuildError',
      issue: 'state_conflict',
    });
    const resumed = await inspectContentSearchIndex({ db, available: true });
    expect(resumed).toMatchObject({
      phase: 'posts',
      post_public_id_cursor: 5,
      processed_posts: 5,
    });
    await expect(applyContentSearchIndexRebuildStep({
      db,
      request: firstRequest,
      now: NOW,
    })).rejects.toBeInstanceOf(ContentSearchRebuildError);
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM post_search_fts',
    ).get()).toEqual({ count: 5 });
    await expect(inspectContentSearchIndex({ db, available: true }))
      .resolves.toMatchObject({
        phase: 'posts',
        post_public_id_cursor: 5,
        processed_posts: 5,
      });

    const completed = await finishRebuild({ db, status: resumed });
    expect(completed).toMatchObject({
      state: 'ready',
      phase: null,
      operation_id: null,
      processed_posts: 7,
      processed_pages: 6,
    });
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM post_search_fts',
    ).get()).toEqual({ count: 7 });
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM page_search_fts',
    ).get()).toEqual({ count: 6 });
    expect(database.prepare(
      'SELECT body FROM post_search_fts WHERE rowid = 1',
    ).get()).toEqual({ body: 'Visible body 1' });
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT rowid FROM post_search_fts
      WHERE post_search_fts MATCH '"Visible"'
    `).all() as Array<{ detail?: string }>;
    expect(plan.some(({ detail }) =>
      /VIRTUAL TABLE INDEX/iu.test(detail ?? ''))).toBe(true);
  });

  it('supports explicit restart and recovers a failed integrity check', async () => {
    const { database, db } = createDatabase();
    insertPost(database, 1);
    let status = await startContentSearchIndexRebuild({
      db,
      initiator: INITIATOR,
      operationId: 'd'.repeat(32),
      now: NOW,
    });
    status = await applyContentSearchIndexRebuildStep({
      db,
      request: stepRequest(status),
      now: NOW,
    });
    const restarted = await startContentSearchIndexRebuild({
      db,
      initiator: INITIATOR,
      operationId: 'e'.repeat(32),
      now: new Date('2026-08-16T01:01:00.000Z'),
    });
    expect(restarted).toMatchObject({
      operation_id: 'e'.repeat(32),
      phase: 'posts',
      post_public_id_cursor: 0,
      processed_posts: 0,
    });

    while (restarted.state === 'in_progress' && restarted.phase !== 'verify') {
      status = await applyContentSearchIndexRebuildStep({
        db,
        request: stepRequest(status.operation_id === restarted.operation_id
          ? status
          : restarted),
        now: NOW,
      });
      if (status.phase === 'verify') break;
    }
    database.prepare(`
      INSERT INTO post_search_fts (
        rowid, revision, title, slug, excerpt, body
      ) VALUES (999, ?, 'Orphan', 'orphan', '', '')
    `).run('f'.repeat(32));
    await expect(applyContentSearchIndexRebuildStep({
      db,
      request: stepRequest(status),
      now: NOW,
    })).rejects.toMatchObject({ issue: 'integrity_failed' });
    await expect(inspectContentSearchIndex({ db, available: true }))
      .resolves.toMatchObject({
        state: 'recovery_required',
        reason: 'integrity_failure',
      });

    const recovery = await startContentSearchIndexRebuild({
      db,
      initiator: INITIATOR,
      operationId: '1'.repeat(32),
      now: new Date('2026-08-16T01:02:00.000Z'),
    });
    await expect(finishRebuild({ db, status: recovery }))
      .resolves.toMatchObject({ state: 'ready' });
  });
});
