import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
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
