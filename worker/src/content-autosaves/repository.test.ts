import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentPostContentSnapshotSchema } from '../../../contracts/post-autosaves';
import { currentPageContentSnapshotSchema } from '../../../contracts/page-autosaves';
import {
  deletePostAutosave,
  garbageCollectExpiredContentAutosaves,
  putPageAutosave,
  putPostAutosave,
  readRecentPostAutosave,
  readPostAutosave,
} from './repository';

type RunResult = { changes: number | bigint };

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    private readonly parameters: unknown[] = [],
  ) {}

  bind(...parameters: unknown[]) {
    return new Statement(this.sqlite, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    const statement = this.sqlite.prepare(this.sql);
    const result = statement.run(
      ...this.parameters as SQLInputValue[],
    ) as RunResult;
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    const statement = this.sqlite.prepare(this.sql);
    return statement.get(
      ...this.parameters as SQLInputValue[],
    ) as T | undefined ?? null;
  }

  execute() {
    return /^\s*SELECT\b/iu.test(this.sql) ? this.first() : this.run();
  }
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const db = {
    prepare(sql: string) {
      return new Statement(sqlite, sql);
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of open.splice(0)) sqlite.close();
});

const USER_ID = '1'.repeat(32);
const POST_ID = '2'.repeat(32);
const PAGE_ID = '3'.repeat(32);
const SECOND_POST_ID = '8'.repeat(32);
const REVISION = '4'.repeat(32);
const DRAFT_ID = '5'.repeat(32);
const NOW = new Date('2026-08-03T12:00:00.000Z');

function seed(sqlite: DatabaseSync) {
  const now = NOW.toISOString();
  sqlite.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, failed_login_attempts, locked_until,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'hash', ?, 'Site Owner', 'active',
      1, 0, NULL, ?, ?)
  `).run(USER_ID, 'a'.repeat(32), now, now);
  sqlite.prepare(`
    INSERT INTO authors (
      id, user_id, display_name, revision, created_at_iso, updated_at_iso
    ) VALUES ('owner', ?, 'Site Owner', ?, ?, ?)
  `).run(USER_ID, 'b'.repeat(32), now, now);
  sqlite.prepare(`
    INSERT INTO posts (
      id, public_id, title, slug, content, document_type, excerpt,
      status, author_id, discoverability, allow_comments,
      featured_image_id, published_at_iso, revision, created_at_iso,
      updated_at_iso
    ) VALUES (?, 10, 'Saved', 'saved', '', 'markdown', '', 'draft',
      'owner', 'default', 1, NULL, NULL, ?, ?, ?)
  `).run(POST_ID, REVISION, now, now);
  sqlite.prepare(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type,
      excerpt, status, discoverability, allow_comments, featured_image_id,
      revision, created_at_iso, updated_at_iso
    ) VALUES (?, 10, NULL, 'Saved Page', 'saved-page', '', 'markdown', '',
      'draft', 'default', 0, NULL, ?, ?, ?)
  `).run(PAGE_ID, REVISION, now, now);
}

function seedSecondPost(sqlite: DatabaseSync) {
  const now = NOW.toISOString();
  sqlite.prepare(`
    INSERT INTO posts (
      id, public_id, title, slug, content, document_type, excerpt,
      status, author_id, discoverability, allow_comments,
      featured_image_id, published_at_iso, revision, created_at_iso,
      updated_at_iso
    ) VALUES (?, 11, 'Second', 'second', '', 'markdown', '', 'draft',
      'owner', 'default', 1, NULL, NULL, ?, ?, ?)
  `).run(SECOND_POST_ID, REVISION, now, now);
}

function postSnapshot(title: string, authorId = '') {
  return currentPostContentSnapshotSchema.parse({
    version: 2,
    content_type: 'post',
    draft: {
      title,
      slug: '',
      content: 'Unsaved content',
      document_type: 'markdown',
      editor_mode: 'source',
      editor_profile: null,
      excerpt: '',
      status: 'draft',
      author_id: authorId,
      category_ids: [],
      tag_ids: [],
      discoverability: 'default',
      allow_comments: true,
      featured_image_id: null,
    },
    references: {
      author: authorId === ''
        ? null
        : { id: authorId, display_name: authorId },
      categories: [],
      tags: [],
      featured_image: null,
    },
  });
}

function pageSnapshot(title: string) {
  return currentPageContentSnapshotSchema.parse({
    version: 2,
    content_type: 'page',
    draft: {
      parent_id: null,
      title,
      slug: '',
      content: 'Unsaved page content',
      document_type: 'markdown',
      editor_mode: 'source',
      editor_profile: null,
      excerpt: '',
      status: 'draft',
      discoverability: 'default',
      allow_comments: false,
      featured_image_id: null,
    },
    references: { parent: null, featured_image: null },
  });
}

describe('content autosave repository', () => {
  it('upserts one mutable new-Post snapshot without allocating a public ID', async () => {
    const value = database();
    open.push(value.sqlite);
    seed(value.sqlite);
    const before = value.sqlite.prepare(`
      SELECT last_public_id FROM content_public_id_counters WHERE content_type = 'post'
    `).get();

    const first = await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: null,
        base_revision: null,
        snapshot: postSnapshot(''),
      },
      now: NOW,
    });
    expect(first).toMatchObject({
      kind: 'completed',
      autosave: { target_id: null, snapshot: { draft: { title: '' } } },
    });
    const second = await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: null,
        base_revision: null,
        snapshot: postSnapshot('Recovered'),
      },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second).toMatchObject({
      kind: 'completed',
      autosave: {
        created_at_iso: NOW.toISOString(),
        snapshot: { draft: { title: 'Recovered' } },
      },
    });
    expect(value.sqlite.prepare(`
      SELECT last_public_id FROM content_public_id_counters WHERE content_type = 'post'
    `).get()).toEqual(before);
  });

  it('discovers the latest unbound Post recovery copy within Author scope', async () => {
    const value = database();
    open.push(value.sqlite);
    seed(value.sqlite);
    await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: null,
        base_revision: null,
        snapshot: postSnapshot('Owner recovery', 'owner'),
      },
      now: NOW,
    });
    await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: '6'.repeat(32),
        target_id: null,
        base_revision: null,
        snapshot: postSnapshot('Other recovery', 'other'),
      },
      now: new Date(NOW.getTime() + 60_000),
    });
    await expect(readRecentPostAutosave({
      db: value.db,
      userId: USER_ID,
      authorId: 'owner',
      now: new Date(NOW.getTime() + 120_000),
    })).resolves.toMatchObject({
      snapshot: { draft: { title: 'Owner recovery' } },
    });
    await expect(readRecentPostAutosave({
      db: value.db,
      userId: USER_ID,
      now: new Date(NOW.getTime() + 120_000),
    })).resolves.toMatchObject({
      snapshot: { draft: { title: 'Other recovery' } },
    });
  });

  it('binds an existing autosave to the current content revision', async () => {
    const value = database();
    open.push(value.sqlite);
    seed(value.sqlite);
    expect(await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: POST_ID,
        base_revision: REVISION,
        snapshot: postSnapshot('Current'),
      },
      now: NOW,
    })).toMatchObject({ kind: 'completed' });

    value.sqlite.prepare('UPDATE posts SET revision = ? WHERE id = ?')
      .run('6'.repeat(32), POST_ID);
    expect(await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: POST_ID,
        base_revision: REVISION,
        snapshot: postSnapshot('Stale'),
      },
      now: new Date(NOW.getTime() + 60_000),
    })).toEqual({ kind: 'revision_conflict' });
    expect(await readPostAutosave({
      db: value.db,
      userId: USER_ID,
      locator: { targetId: POST_ID },
      now: NOW,
    })).toMatchObject({ snapshot: { draft: { title: 'Current' } } });
  });

  it('does not delete another target autosave when a draft ID is rebound', async () => {
    const value = database();
    open.push(value.sqlite);
    seed(value.sqlite);
    seedSecondPost(value.sqlite);
    await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: POST_ID,
        base_revision: REVISION,
        snapshot: postSnapshot('First target'),
      },
      now: NOW,
    });
    await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: '9'.repeat(32),
        target_id: SECOND_POST_ID,
        base_revision: REVISION,
        snapshot: postSnapshot('Second target'),
      },
      now: NOW,
    });

    expect(await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: SECOND_POST_ID,
        base_revision: REVISION,
        snapshot: postSnapshot('Invalid rebind'),
      },
      now: new Date(NOW.getTime() + 60_000),
    })).toEqual({ kind: 'draft_conflict' });
    expect(await readPostAutosave({
      db: value.db,
      userId: USER_ID,
      locator: { targetId: SECOND_POST_ID },
      now: NOW,
    })).toMatchObject({ snapshot: { draft: { title: 'Second target' } } });
  });

  it('deletes explicitly and garbage-collects expired Post/Page autosaves', async () => {
    const value = database();
    open.push(value.sqlite);
    seed(value.sqlite);
    await putPostAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: DRAFT_ID,
        target_id: null,
        base_revision: null,
        snapshot: postSnapshot('Draft'),
      },
      now: NOW,
    });
    expect(await deletePostAutosave({
      db: value.db,
      userId: USER_ID,
      draftId: DRAFT_ID,
    })).toBe(true);
    expect(await deletePostAutosave({
      db: value.db,
      userId: USER_ID,
      draftId: DRAFT_ID,
    })).toBe(false);

    await putPageAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: '7'.repeat(32),
        target_id: PAGE_ID,
        base_revision: REVISION,
        snapshot: pageSnapshot('Draft Page'),
      },
      now: NOW,
    });
    await putPageAutosave({
      db: value.db,
      userId: USER_ID,
      request: {
        draft_id: '8'.repeat(32),
        target_id: null,
        base_revision: null,
        snapshot: pageSnapshot('Abandoned Page'),
      },
      now: NOW,
    });
    const result = await garbageCollectExpiredContentAutosaves({
      db: value.db,
      now: new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1_000),
    });
    expect(result.deletedRows).toBe(1);
    expect(value.sqlite.prepare('SELECT COUNT(*) AS count FROM page_autosaves').get())
      .toEqual({ count: 1 });
    expect(value.sqlite.prepare(
      'SELECT expires_at_iso FROM page_autosaves WHERE page_id = ?',
    ).get(PAGE_ID)).toEqual({ expires_at_iso: null });
  });
});
