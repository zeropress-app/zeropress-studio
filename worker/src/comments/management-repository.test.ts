import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  bulkModerateManagedComments,
  createStudioComment,
  deleteManagedComment,
  listCommentTargetOptions,
  listManagedComments,
  updateManagedComment,
} from './management-repository';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly parameters: unknown[] = [],
  ) {}

  bind(...parameters: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (...values: unknown[]) =>
        SqliteRunResult
    )(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...values: unknown[]) => T[]
    )(...this.parameters);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...values: unknown[]) =>
        T | undefined
    )(...this.parameters);
    return row ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function databases() {
  const edge = new DatabaseSync(':memory:');
  edge.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE edge_comment_targets (
      id INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL,
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL,
      request_token_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      comments_cache_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      UNIQUE (target_type, public_id)
    );
    CREATE TABLE edge_comment_settings (
      id INTEGER PRIMARY KEY,
      thread_comments INTEGER NOT NULL,
      thread_comments_depth INTEGER NOT NULL
    );
    INSERT INTO edge_comment_settings (
      id, thread_comments, thread_comments_depth
    ) VALUES (1, 1, 2);
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      public_id INTEGER NOT NULL UNIQUE,
      target_id INTEGER NOT NULL REFERENCES edge_comment_targets(id)
        ON DELETE CASCADE,
      parent_public_id INTEGER,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_kind TEXT NOT NULL DEFAULT 'guest',
      author_user_id TEXT,
      author_identity_issuer TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      imported INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT,
      ip_address_recorded_at TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      asn INTEGER,
      as_organization TEXT,
      country_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const studio = new DatabaseSync(':memory:');
  studio.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      public_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      allow_comments INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE pages (
      id TEXT PRIMARY KEY,
      public_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      allow_comments INTEGER NOT NULL DEFAULT 1
    );
  `);
  return {
    edge,
    studio,
    edgeDb: d1(edge),
    studioDb: d1(studio),
  };
}

const INITIAL_TIME = '2026-08-02T00:00:00Z';
const STUDIO_USER = {
  id: '9'.repeat(32),
  email: 'editor@example.com',
  name: 'Site Editor',
  roles: ['editor'],
};

function insertTarget(
  database: DatabaseSync,
  type: 'post' | 'page',
  publicId: number,
): number {
  database.prepare(`
    INSERT INTO edge_comment_targets (
      target_type, public_id, status, allow_comments
    ) VALUES (?, ?, 'published', 1)
  `).run(type, publicId);
  return Number((database.prepare('SELECT last_insert_rowid() AS id').get() as {
    id: number;
  }).id);
}

function insertComment(input: {
  database: DatabaseSync;
  id: string;
  publicId: number;
  targetId: number;
  status: 'pending' | 'approved' | 'spam' | 'trash';
  parentPublicId?: number | null;
  content?: string;
}) {
  input.database.prepare(`
    INSERT INTO comments (
      id, public_id, target_id, parent_public_id, author_name,
      author_email, author_kind, content, status, ip_address, user_agent,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Reader', 'reader@example.com', 'guest', ?, ?,
      '203.0.113.1', 'Example browser', ?, ?)
  `).run(
    input.id,
    input.publicId,
    input.targetId,
    input.parentPublicId ?? null,
    input.content ?? `Comment ${input.publicId}`,
    input.status,
    INITIAL_TIME,
    INITIAL_TIME,
  );
}

describe('comment moderation repository', () => {
  it('lists only published, comment-enabled targets projected to Edge', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    insertTarget(edge, 'post', 101);
    insertTarget(edge, 'post', 102);
    studio.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, status, allow_comments
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('1'.repeat(32), 101, 'Alpha target', 'alpha-target', 'published', 1);
    studio.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, status, allow_comments
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('2'.repeat(32), 102, 'Hidden target', 'hidden-target', 'draft', 1);
    studio.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, status, allow_comments
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('3'.repeat(32), 103, 'Not projected', 'not-projected', 'published', 1);

    await expect(listCommentTargetOptions({
      db: studioDb,
      edgeDb,
      query: { target_type: 'post', search: 'target' },
    })).resolves.toEqual([{
      type: 'post',
      id: '1'.repeat(32),
      public_id: 101,
      title: 'Alpha target',
      slug: 'alpha-target',
    }]);
  });

  it('lists typed targets and computes counts without the selected status', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    const publicId = 100_000_000_001;
    const postTargetId = insertTarget(edge, 'post', publicId);
    const pageTargetId = insertTarget(edge, 'page', publicId);
    studio.prepare(
      'INSERT INTO posts (id, public_id, title, slug) VALUES (?, ?, ?, ?)',
    ).run('1'.repeat(32), publicId, 'Post title', 'post-title');
    studio.prepare(
      'INSERT INTO pages (id, public_id, title, slug) VALUES (?, ?, ?, ?)',
    ).run('2'.repeat(32), publicId, 'Page title', 'page-title');
    insertComment({
      database: edge,
      id: 'a'.repeat(32),
      publicId: 101,
      targetId: postTargetId,
      status: 'pending',
    });
    insertComment({
      database: edge,
      id: 'b'.repeat(32),
      publicId: 102,
      targetId: postTargetId,
      status: 'approved',
    });
    insertComment({
      database: edge,
      id: 'c'.repeat(32),
      publicId: 103,
      targetId: pageTargetId,
      status: 'pending',
    });

    const result = await listManagedComments({
      db: studioDb,
      edgeDb,
      query: {
        search: '',
        status: 'pending',
        target_type: 'post',
        page: 1,
        per_page: 50,
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      target_type: 'post',
      target_public_id: publicId,
      target: { type: 'post', title: 'Post title' },
      status: 'pending',
      created_at_iso: '2026-08-02T00:00:00.000Z',
    });
    expect(result.pagination.total).toBe(1);
    expect(result.status_counts).toEqual({
      all: 2,
      pending: 1,
      approved: 1,
      spam: 0,
      trash: 0,
    });
  });

  it('keeps target metadata visible but disables replies for an unavailable target', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    const targetId = insertTarget(edge, 'post', 150);
    studio.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, status, allow_comments
      ) VALUES (?, ?, ?, ?, 'draft', 1)
    `).run('f'.repeat(32), 150, 'Draft target', 'draft-target');
    insertComment({
      database: edge,
      id: 'e'.repeat(32),
      publicId: 151,
      targetId,
      status: 'approved',
    });

    const result = await listManagedComments({
      db: studioDb,
      edgeDb,
      query: {
        search: '',
        status: 'all',
        target_type: 'post',
        page: 1,
        per_page: 50,
      },
    });
    expect(result.items[0]).toMatchObject({
      target: { title: 'Draft target' },
      reply: { available: false, reason: 'target_unavailable' },
    });
  });

  it('updates a comment and its target cache revision atomically', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    const targetId = insertTarget(edge, 'post', 200);
    studio.prepare(
      'INSERT INTO posts (id, public_id, title, slug) VALUES (?, ?, ?, ?)',
    ).run('3'.repeat(32), 200, 'Target', 'target');
    insertComment({
      database: edge,
      id: 'd'.repeat(32),
      publicId: 201,
      targetId,
      status: 'pending',
    });
    const before = edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(targetId) as { comments_cache_revision: string };
    const result = await updateManagedComment({
      db: studioDb,
      edgeDb,
      id: 'd'.repeat(32),
      update: {
        content_text: 'Updated comment ©😊 👨‍👩‍👧‍👦',
        status: 'approved',
        expected_updated_at_iso: '2026-08-02T00:00:00.000Z',
      },
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      comment: {
        content_text: 'Updated comment ©😊 👨‍👩‍👧‍👦',
        status: 'approved',
        updated_at_iso: '2026-08-02T00:00:00.001Z',
      },
    });
    const after = edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(targetId) as { comments_cache_revision: string };
    expect(after.comments_cache_revision).not.toBe(before.comments_cache_revision);
    await expect(updateManagedComment({
      db: studioDb,
      edgeDb,
      id: 'd'.repeat(32),
      update: {
        status: 'spam',
        expected_updated_at_iso: '2026-08-02T00:00:00.000Z',
      },
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('bulk moderates revision-bound rows and rotates each changed target once', async () => {
    const { edge, edgeDb } = databases();
    const firstTargetId = insertTarget(edge, 'post', 600);
    const secondTargetId = insertTarget(edge, 'page', 601);
    const ids = ['a', 'b', 'c', 'd'].map((value) => value.repeat(32));
    insertComment({
      database: edge,
      id: ids[0]!,
      publicId: 610,
      targetId: firstTargetId,
      status: 'pending',
    });
    insertComment({
      database: edge,
      id: ids[1]!,
      publicId: 611,
      targetId: firstTargetId,
      status: 'spam',
    });
    insertComment({
      database: edge,
      id: ids[2]!,
      publicId: 612,
      targetId: firstTargetId,
      status: 'approved',
    });
    insertComment({
      database: edge,
      id: ids[3]!,
      publicId: 613,
      targetId: secondTargetId,
      status: 'pending',
    });
    edge.exec(`
      CREATE TABLE cache_rotation_audit (target_id INTEGER NOT NULL);
      CREATE TRIGGER audit_comment_cache_rotation
      AFTER UPDATE OF comments_cache_revision ON edge_comment_targets
      BEGIN
        INSERT INTO cache_rotation_audit (target_id) VALUES (NEW.id);
      END;
    `);
    const request = {
      operation: 'set_status' as const,
      status: 'approved' as const,
      items: [
        { id: ids[0]!, expected_updated_at_iso: `${INITIAL_TIME.slice(0, -1)}.000Z` },
        { id: ids[1]!, expected_updated_at_iso: `${INITIAL_TIME.slice(0, -1)}.000Z` },
        { id: ids[2]!, expected_updated_at_iso: '2026-01-01T00:00:00.000Z' },
        { id: ids[3]!, expected_updated_at_iso: '2026-01-01T00:00:00.000Z' },
        { id: 'e'.repeat(32), expected_updated_at_iso: `${INITIAL_TIME.slice(0, -1)}.000Z` },
      ],
    };

    const result = await bulkModerateManagedComments({
      edgeDb,
      request,
      now: new Date(INITIAL_TIME),
    });
    expect(result).toMatchObject({
      operation: 'set_status',
      status: 'approved',
      results: [
        { id: ids[0], outcome: 'updated', status: 'approved' },
        { id: ids[1], outcome: 'updated', status: 'approved' },
        { id: ids[2], outcome: 'unchanged', status: 'approved' },
        { id: ids[3], outcome: 'conflict' },
        { id: 'e'.repeat(32), outcome: 'skipped', reason: 'not_found' },
      ],
      summary: {
        requested: 5,
        updated: 2,
        unchanged: 1,
        conflict: 1,
        skipped: 1,
        deleted_comments: 0,
      },
    });
    expect(edge.prepare(`
      SELECT target_id FROM cache_rotation_audit ORDER BY rowid
    `).all()).toEqual([{ target_id: firstTargetId }]);

    const replay = await bulkModerateManagedComments({ edgeDb, request });
    expect(replay.summary).toMatchObject({ updated: 0, unchanged: 3 });
    expect(edge.prepare('SELECT COUNT(*) AS count FROM cache_rotation_audit').get())
      .toEqual({ count: 1 });
  });

  it('creates an approved Studio comment with a native public ID and no network snapshot', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    const targetId = insertTarget(edge, 'post', 400);
    studio.prepare(
      'INSERT INTO posts (id, public_id, title, slug) VALUES (?, ?, ?, ?)',
    ).run('4'.repeat(32), 400, 'Target', 'target');
    const before = edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(targetId) as { comments_cache_revision: string };

    const result = await createStudioComment({
      db: studioDb,
      edgeDb,
      author: STUDIO_USER,
      comment: {
        target_type: 'post',
        target_public_id: 400,
        parent_public_id: null,
        content_text: 'A Studio-authored comment ©😊 👨‍👩‍👧‍👦',
      },
      now: new Date('2026-08-02T00:00:00.999Z'),
      createId: () => '5'.repeat(32),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      comment: {
        id: '5'.repeat(32),
        public_id: 100_000_000_001,
        parent_public_id: null,
        author: {
          name: 'Site Editor',
          email: 'editor@example.com',
          kind: 'site_user',
        },
        content_text: 'A Studio-authored comment ©😊 👨‍👩‍👧‍👦',
        status: 'approved',
        reply: { available: true },
        ip_address: null,
        user_agent: null,
        created_at_iso: '2026-08-02T00:00:00.000Z',
      },
    });
    expect(edge.prepare(`
      SELECT
        imported,
        author_user_id,
        author_kind,
        author_identity_issuer,
        ip_address,
        ip_hash,
        user_agent,
        asn,
        as_organization,
        country_code
      FROM comments
      WHERE id = ?
    `).get('5'.repeat(32))).toEqual({
      imported: 0,
      author_user_id: STUDIO_USER.id,
      author_kind: 'site_user',
      author_identity_issuer: 'zeropress:studio',
      ip_address: null,
      ip_hash: null,
      user_agent: null,
      asn: null,
      as_organization: null,
      country_code: null,
    });
    const after = edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(targetId) as { comments_cache_revision: string };
    expect(after.comments_cache_revision).not.toBe(before.comments_cache_revision);
  });

  it('creates only same-target approved replies within the configured depth', async () => {
    const { edge, studio, edgeDb, studioDb } = databases();
    const targetId = insertTarget(edge, 'page', 500);
    studio.prepare(
      'INSERT INTO pages (id, public_id, title, slug) VALUES (?, ?, ?, ?)',
    ).run('6'.repeat(32), 500, 'Page target', 'page-target');
    insertComment({
      database: edge,
      id: '7'.repeat(32),
      publicId: 501,
      targetId,
      status: 'approved',
    });

    const reply = await createStudioComment({
      db: studioDb,
      edgeDb,
      author: STUDIO_USER,
      comment: {
        target_type: 'page',
        target_public_id: 500,
        parent_public_id: 501,
        content_text: 'Studio reply',
      },
      createId: () => '8'.repeat(32),
    });
    expect(reply).toMatchObject({
      kind: 'completed',
      comment: {
        parent_public_id: 501,
        reply: { available: false, reason: 'depth_limit' },
      },
    });
    const replyPublicId = reply.kind === 'completed'
      ? reply.comment.public_id
      : 0;
    await expect(createStudioComment({
      db: studioDb,
      edgeDb,
      author: STUDIO_USER,
      comment: {
        target_type: 'page',
        target_public_id: 500,
        parent_public_id: replyPublicId,
        content_text: 'Too deep',
      },
      createId: () => 'a'.repeat(32),
    })).resolves.toEqual({ kind: 'reply_not_available' });

    const otherTargetId = insertTarget(edge, 'post', 500);
    insertComment({
      database: edge,
      id: 'b'.repeat(32),
      publicId: 502,
      targetId: otherTargetId,
      status: 'approved',
    });
    await expect(createStudioComment({
      db: studioDb,
      edgeDb,
      author: STUDIO_USER,
      comment: {
        target_type: 'page',
        target_public_id: 500,
        parent_public_id: 502,
        content_text: 'Cross-target reply',
      },
      createId: () => 'c'.repeat(32),
    })).resolves.toEqual({ kind: 'reply_not_available' });
  });

  it('deletes a target-scoped cyclic descendant subtree and nothing else', async () => {
    const { edge, edgeDb, studioDb } = databases();
    const postTargetId = insertTarget(edge, 'post', 300);
    const pageTargetId = insertTarget(edge, 'page', 300);
    insertComment({
      database: edge,
      id: 'e'.repeat(32),
      publicId: 301,
      targetId: postTargetId,
      status: 'trash',
      parentPublicId: 303,
    });
    insertComment({
      database: edge,
      id: 'f'.repeat(32),
      publicId: 302,
      targetId: postTargetId,
      status: 'approved',
      parentPublicId: 301,
    });
    insertComment({
      database: edge,
      id: '1a'.repeat(16),
      publicId: 303,
      targetId: postTargetId,
      status: 'pending',
      parentPublicId: 302,
    });
    insertComment({
      database: edge,
      id: '2b'.repeat(16),
      publicId: 304,
      targetId: pageTargetId,
      status: 'approved',
      parentPublicId: 301,
    });
    const pageRevision = (edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(pageTargetId) as { comments_cache_revision: string })
      .comments_cache_revision;

    await expect(deleteManagedComment({
      db: studioDb,
      edgeDb,
      id: 'e'.repeat(32),
      expectedUpdatedAtIso: '2026-08-02T00:00:00.000Z',
    })).resolves.toEqual({
      kind: 'permanently_deleted',
      deletedCount: 3,
    });
    expect(edge.prepare('SELECT public_id FROM comments').all())
      .toEqual([{ public_id: 304 }]);
    expect((edge.prepare(`
      SELECT comments_cache_revision FROM edge_comment_targets WHERE id = ?
    `).get(pageTargetId) as { comments_cache_revision: string })
      .comments_cache_revision).toBe(pageRevision);
  });

  it('bulk deletes only revision-bound Trash subtrees and rotates a target once', async () => {
    const { edge, edgeDb } = databases();
    const postTargetId = insertTarget(edge, 'post', 700);
    const pageTargetId = insertTarget(edge, 'page', 700);
    const rootId = '3c'.repeat(16);
    const childId = '4d'.repeat(16);
    const pendingId = '5e'.repeat(16);
    const staleId = '6f'.repeat(16);
    insertComment({
      database: edge,
      id: rootId,
      publicId: 701,
      targetId: postTargetId,
      status: 'trash',
      parentPublicId: 702,
    });
    insertComment({
      database: edge,
      id: childId,
      publicId: 702,
      targetId: postTargetId,
      status: 'trash',
      parentPublicId: 701,
    });
    insertComment({
      database: edge,
      id: pendingId,
      publicId: 703,
      targetId: postTargetId,
      status: 'pending',
    });
    insertComment({
      database: edge,
      id: staleId,
      publicId: 704,
      targetId: pageTargetId,
      status: 'trash',
    });
    insertComment({
      database: edge,
      id: '7a'.repeat(16),
      publicId: 705,
      targetId: pageTargetId,
      status: 'approved',
      parentPublicId: 701,
    });
    edge.exec(`
      CREATE TABLE cache_rotation_audit (target_id INTEGER NOT NULL);
      CREATE TRIGGER audit_comment_cache_rotation
      AFTER UPDATE OF comments_cache_revision ON edge_comment_targets
      BEGIN
        INSERT INTO cache_rotation_audit (target_id) VALUES (NEW.id);
      END;
    `);

    const result = await bulkModerateManagedComments({
      edgeDb,
      request: {
        operation: 'delete_permanently',
        items: [
          { id: rootId, expected_updated_at_iso: '2026-08-02T00:00:00.000Z' },
          { id: childId, expected_updated_at_iso: '2026-08-02T00:00:00.000Z' },
          { id: pendingId, expected_updated_at_iso: '2026-08-02T00:00:00.000Z' },
          { id: staleId, expected_updated_at_iso: '2026-01-01T00:00:00.000Z' },
          { id: '8b'.repeat(16), expected_updated_at_iso: '2026-08-02T00:00:00.000Z' },
        ],
      },
    });
    expect(result).toEqual({
      operation: 'delete_permanently',
      results: [
        { id: rootId, outcome: 'updated', deleted_count: 2 },
        { id: childId, outcome: 'skipped', reason: 'not_found' },
        { id: pendingId, outcome: 'skipped', reason: 'not_in_trash' },
        { id: staleId, outcome: 'conflict' },
        { id: '8b'.repeat(16), outcome: 'skipped', reason: 'not_found' },
      ],
      summary: {
        requested: 5,
        updated: 1,
        unchanged: 0,
        conflict: 1,
        skipped: 3,
        deleted_comments: 2,
      },
    });
    expect(edge.prepare('SELECT public_id FROM comments ORDER BY public_id').all())
      .toEqual([{ public_id: 703 }, { public_id: 704 }, { public_id: 705 }]);
    expect(edge.prepare('SELECT target_id FROM cache_rotation_audit').all())
      .toEqual([{ target_id: postTargetId }]);
  });
});
