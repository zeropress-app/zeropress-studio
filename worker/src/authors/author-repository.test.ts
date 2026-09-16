import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthorListQuery } from '../../../contracts/authors';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createAuthor,
  deleteAuthor,
  listAuthors,
  listAuthorUserOptions,
  listPreviewAuthors,
  updateAuthor,
} from './author-repository';

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

const NOW = new Date('2026-08-01T06:00:00.000Z');
const USER_ONE = '1'.repeat(32);
const USER_TWO = '2'.repeat(32);

function seedUser(
  database: DatabaseSync,
  id: string,
  email: string,
  name: string,
) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, ?, 'password-hash', ?, ?, 'active', 1, ?, ?)
  `).run(id, email, 'a'.repeat(32), name, NOW.toISOString(), NOW.toISOString());
}

const defaultQuery: AuthorListQuery = {
  search: '',
  linked: 'all',
  page: 1,
  per_page: 50,
};

function seedMedia(input: {
  database: DatabaseSync;
  id: string;
  kind?: 'image' | 'document';
  url: string;
}) {
  const kind = input.kind ?? 'image';
  input.database.prepare(`
    INSERT INTO media (
      id, kind, filename, mime_type, storage_type, storage_key, external_url,
      size_bytes, width, height, duration_ms, alt, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, 'external', NULL, ?, 100, ?, ?, NULL, '', ?, ?, ?)
  `).run(
    input.id,
    kind,
    kind === 'image' ? 'avatar.png' : 'document.pdf',
    kind === 'image' ? 'image/png' : 'application/pdf',
    input.url,
    kind === 'image' ? 100 : null,
    kind === 'image' ? 100 : null,
    '9'.repeat(32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

describe('author D1 repository', () => {
  it('returns a zero summary for the empty Author state after installation', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database, USER_ONE, 'owner@example.com', 'Studio Owner');

    await expect(listAuthors({
      db: d1,
      query: defaultQuery,
    })).resolves.toEqual({
      items: [],
      pagination: {
        page: 1,
        per_page: 50,
        total: 0,
        total_pages: 0,
      },
      summary: { total: 0, linked: 0, unlinked: 0 },
    });
  });

  it('creates case-sensitive canonical IDs and enforces one account link', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database, USER_ONE, 'owner@example.com', 'Studio Owner');
    seedUser(database, USER_TWO, 'editor@example.com', 'Site Editor');

    await expect(createAuthor({
      db: d1,
      id: 'Lael-Rukius',
      displayName: 'HYEONG HWAN, MUN',
      userId: USER_ONE,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => 'b'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      author: {
        id: 'Lael-Rukius',
        display_name: 'HYEONG HWAN, MUN',
        user: { id: USER_ONE, email: 'owner@example.com' },
        revision: 'b'.repeat(32),
      },
    });
    await expect(createAuthor({
      db: d1,
      id: 'Lael-Rukius',
      displayName: 'Duplicate',
      userId: null,
      avatarMediaId: null,
    })).resolves.toEqual({ kind: 'id_conflict' });
    await expect(createAuthor({
      db: d1,
      id: 'Another',
      displayName: 'Another',
      userId: USER_ONE,
      avatarMediaId: null,
    })).resolves.toEqual({ kind: 'user_conflict' });
    await expect(createAuthor({
      db: d1,
      id: 'MissingUser',
      displayName: 'Missing User',
      userId: 'f'.repeat(32),
      avatarMediaId: null,
    })).resolves.toEqual({ kind: 'user_not_found' });
    await expect(createAuthor({
      db: d1,
      id: 'lael-rukius',
      displayName: 'Case-distinct identity',
      userId: USER_TWO,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => 'c'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });

    expect(database.prepare('SELECT id FROM authors ORDER BY id').all())
      .toEqual([{ id: 'Lael-Rukius' }, { id: 'lael-rukius' }]);
  });

  it('lists deterministically with search, account filters, and pagination', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database, USER_ONE, 'owner@example.com', 'Studio Owner');
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES
        ('zeta', NULL, 'Zeta', ?, ?, ?),
        ('alpha', ?, 'Alpha', ?, ?, ?),
        ('beta', NULL, 'Beta', ?, ?, ?)
    `).run(
      '1'.repeat(32), NOW.toISOString(), NOW.toISOString(),
      USER_ONE, '2'.repeat(32), NOW.toISOString(), NOW.toISOString(),
      '3'.repeat(32), NOW.toISOString(), NOW.toISOString(),
    );

    await expect(listAuthors({
      db: d1,
      query: { ...defaultQuery, per_page: 2 },
    })).resolves.toMatchObject({
      items: [{ id: 'alpha' }, { id: 'beta' }],
      pagination: { page: 1, per_page: 2, total: 3, total_pages: 2 },
      summary: { total: 3, linked: 1, unlinked: 2 },
    });
    await expect(listAuthors({
      db: d1,
      query: { ...defaultQuery, search: 'owner@', linked: 'linked' },
    })).resolves.toMatchObject({
      items: [{ id: 'alpha' }],
      pagination: { total: 1 },
      summary: { total: 3, linked: 1, unlinked: 2 },
    });
    await expect(listAuthors({
      db: d1,
      query: { ...defaultQuery, search: 'no matching author' },
    })).resolves.toEqual({
      items: [],
      pagination: {
        page: 1,
        per_page: 50,
        total: 0,
        total_pages: 0,
      },
      summary: { total: 3, linked: 1, unlinked: 2 },
    });
    await expect(listAuthorUserOptions({ db: d1 })).resolves.toEqual([{
      id: USER_ONE,
      email: 'owner@example.com',
      name: 'Studio Owner',
      status: 'active',
      linked_author_id: 'alpha',
    }]);
  });

  it('stores an image-backed avatar, protects it, and projects only published authors', async () => {
    const { database, d1 } = createTestDatabase();
    const avatarId = 'a'.repeat(32);
    const documentId = 'd'.repeat(32);
    seedMedia({
      database,
      id: avatarId,
      url: 'https://media.example.com/authors/editor.png',
    });
    seedMedia({
      database,
      id: documentId,
      kind: 'document',
      url: 'https://media.example.com/files/document.pdf',
    });

    await expect(createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: null,
      avatarMediaId: documentId,
    })).resolves.toEqual({ kind: 'media_not_found' });
    await expect(createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: null,
      avatarMediaId: avatarId,
      now: NOW,
      createRevision: () => '4'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      author: {
        avatar: {
          id: avatarId,
          preview_url: 'https://media.example.com/authors/editor.png',
        },
      },
    });
    expect(() => database.prepare('DELETE FROM media WHERE id = ?').run(avatarId))
      .toThrow(/foreign key constraint/iu);
    expect(() => database.prepare(`
      UPDATE media
      SET kind = 'document', mime_type = 'application/pdf',
          width = NULL, height = NULL
      WHERE id = ?
    `).run(avatarId)).toThrow(/author avatar must remain image media/iu);

    expect(await listPreviewAuthors({ db: d1 })).toEqual([]);
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, content, document_type, excerpt,
        status, author_id, discoverability, allow_comments,
        published_at_iso, revision, created_at_iso, updated_at_iso
      ) VALUES (?, 100000000001, 'Published', 'published', '', 'markdown', '',
                'published', 'editor', 'default', 1, ?, ?, ?, ?)
    `).run(
      'e'.repeat(32),
      NOW.toISOString(),
      '5'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await expect(listPreviewAuthors({ db: d1 })).resolves.toEqual([{
      id: 'editor',
      displayName: 'Editor',
      avatarLocation: {
        type: 'external',
        url: 'https://media.example.com/authors/editor.png',
      },
      avatarMedia: {
        id: avatarId,
        kind: 'image',
        filename: 'avatar.png',
        mime_type: 'image/png',
        location: {
          type: 'external',
          url: 'https://media.example.com/authors/editor.png',
        },
        width: 100,
        height: 100,
        alt: '',
      },
    }]);
  });

  it('updates mutable fields only, keeps no-op revisions, and detects stale writes', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database, USER_ONE, 'owner@example.com', 'Studio Owner');
    await createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Original Name',
      userId: null,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => '4'.repeat(32),
    });
    await expect(updateAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Original Name',
      userId: null,
      avatarMediaId: null,
      expectedRevision: '4'.repeat(32),
      now: new Date('2026-08-01T07:00:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      author: {
        revision: '4'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    await expect(updateAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Updated Name',
      userId: USER_ONE,
      avatarMediaId: null,
      expectedRevision: '4'.repeat(32),
      now: new Date('2026-08-01T07:00:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      author: {
        id: 'editor',
        display_name: 'Updated Name',
        revision: '5'.repeat(32),
        user: { id: USER_ONE },
      },
    });
    await expect(updateAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Stale Name',
      userId: null,
      avatarMediaId: null,
      expectedRevision: '4'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('unlinks deleted users and deletes only with the current revision', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database, USER_ONE, 'owner@example.com', 'Studio Owner');
    await createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: USER_ONE,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    });
    database.prepare('DELETE FROM users WHERE id = ?').run(USER_ONE);
    await expect(listAuthors({ db: d1, query: defaultQuery }))
      .resolves.toMatchObject({ items: [{ id: 'editor', user: null }] });
    await expect(deleteAuthor({
      db: d1,
      id: 'editor',
      expectedRevision: '7'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    await expect(deleteAuthor({
      db: d1,
      id: 'editor',
      expectedRevision: '6'.repeat(32),
    })).resolves.toEqual({ kind: 'completed' });
    await expect(deleteAuthor({
      db: d1,
      id: 'editor',
      expectedRevision: '6'.repeat(32),
    })).resolves.toEqual({ kind: 'not_found' });
  });

  it('keeps an Author while a Post references the public identity', async () => {
    const { database, d1 } = createTestDatabase();
    await createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: null,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    });
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, content, document_type, excerpt,
        status, author_id, discoverability, allow_comments,
        published_at_iso, revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, '', 'markdown', '', 'draft', ?, 'default', 1,
                NULL, ?, ?, ?)
    `).run(
      '7'.repeat(32),
      100_000_000_001,
      'Referenced Post',
      'referenced-post',
      'editor',
      '8'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    await expect(listAuthors({ db: d1, query: defaultQuery }))
      .resolves.toMatchObject({
        items: [{ id: 'editor', post_count: 1 }],
      });

    await expect(deleteAuthor({
      db: d1,
      id: 'editor',
      expectedRevision: '6'.repeat(32),
    })).resolves.toEqual({ kind: 'in_use' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM authors').get())
      .toEqual({ count: 1 });
  });

  it('keeps an Author while a Profile Widget references the public identity', async () => {
    const { database, d1 } = createTestDatabase();
    await createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: null,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    });
    database.prepare(`
      INSERT INTO widget_areas (
        widget_area_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      ) VALUES ('sidebar', 'Sidebar Widgets', 1, ?, ?, ?, ?)
    `).run(
      JSON.stringify([{
        id: '7'.repeat(32),
        type: 'profile',
        title: '',
        enabled: true,
        settings: { author_id: 'editor' },
      }]),
      '8'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    await expect(deleteAuthor({
      db: d1,
      id: 'editor',
      expectedRevision: '6'.repeat(32),
    })).resolves.toEqual({ kind: 'in_use' });
  });

  it('fails closed when stored author data does not match the contract', async () => {
    const { database, d1 } = createTestDatabase();
    await createAuthor({
      db: d1,
      id: 'editor',
      displayName: 'Editor',
      userId: null,
      avatarMediaId: null,
      now: NOW,
      createRevision: () => '8'.repeat(32),
    });
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare("UPDATE authors SET display_name = ' Editor '").run();

    await expect(listAuthors({ db: d1, query: defaultQuery }))
      .rejects.toMatchObject({
        code: 'AUTHOR_MANAGEMENT_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);
  });
});
