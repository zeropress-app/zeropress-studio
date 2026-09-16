import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaxonomyListQuery } from '../../../contracts/taxonomies';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createTaxonomyTerm,
  deleteTaxonomyTerm,
  listPreviewTaxonomies,
  listTaxonomyTerms,
  updateTaxonomyTerm,
} from './taxonomy-repository';

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
const defaultQuery: TaxonomyListQuery = {
  search: '',
  page: 1,
  per_page: 50,
};

describe('taxonomy D1 repository', () => {
  it('creates separate Category/Tag identities and edits public slugs', async () => {
    const { database, d1 } = createTestDatabase();
    const category = await createTaxonomyTerm({
      db: d1,
      taxonomy: 'category',
      name: 'Product News',
      slug: 'product-news',
      description: 'Announcements.',
      now: NOW,
      createId: () => '1'.repeat(32),
      createRevision: () => '2'.repeat(32),
    });
    expect(category).toMatchObject({
      kind: 'completed',
      term: {
        id: '1'.repeat(32),
        taxonomy: 'category',
        slug: 'product-news',
      },
    });
    await expect(createTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      name: 'Product News',
      slug: 'product-news',
      description: '',
      now: NOW,
      createId: () => '3'.repeat(32),
      createRevision: () => '4'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      term: { taxonomy: 'tag' },
    });
    await expect(updateTaxonomyTerm({
      db: d1,
      taxonomy: 'category',
      id: '1'.repeat(32),
      name: 'Releases',
      slug: 'releases.v0.7',
      description: '',
      expectedRevision: '2'.repeat(32),
      now: new Date('2026-08-01T07:00:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      term: {
        id: '1'.repeat(32),
        slug: 'releases.v0.7',
        revision: '5'.repeat(32),
      },
    });
    expect(database.prepare('SELECT id FROM categories').get()).toEqual({
      id: '1'.repeat(32),
    });
  });

  it('lists deterministically with escaped search and bounded pagination', async () => {
    const { database, d1 } = createTestDatabase();
    const now = NOW.toISOString();
    database.prepare(`
      INSERT INTO tags (
        id, name, slug, description, revision, created_at_iso, updated_at_iso
      ) VALUES
        (?, 'Zeta', 'zeta', '', ?, ?, ?),
        (?, 'Alpha', 'alpha', '100% useful', ?, ?, ?),
        (?, 'Beta', 'beta', '', ?, ?, ?)
    `).run(
      '1'.repeat(32), 'a'.repeat(32), now, now,
      '2'.repeat(32), 'b'.repeat(32), now, now,
      '3'.repeat(32), 'c'.repeat(32), now, now,
    );
    await expect(listTaxonomyTerms({
      db: d1,
      taxonomy: 'tag',
      query: { ...defaultQuery, per_page: 2 },
    })).resolves.toMatchObject({
      items: [{ name: 'Alpha', post_count: 0 }, { name: 'Beta', post_count: 0 }],
      pagination: { total: 3, total_pages: 2 },
      summary: { categories: 0, tags: 3 },
    });
    await expect(listTaxonomyTerms({
      db: d1,
      taxonomy: 'tag',
      query: { ...defaultQuery, search: '100%' },
    })).resolves.toMatchObject({
      items: [{ slug: 'alpha' }],
      pagination: { total: 1 },
      summary: { categories: 0, tags: 3 },
    });
    await expect(listTaxonomyTerms({
      db: d1, taxonomy: 'tag', query: { ...defaultQuery, search: 'no matches' },
    })).resolves.toMatchObject({
      items: [], pagination: { total: 0 }, summary: { categories: 0, tags: 3 },
    });
  });

  it('counts all linked Post states independently per kind without changing public terms', async () => {
    const { database, d1 } = createTestDatabase();
    for (const taxonomy of ['category', 'tag'] as const) {
      for (const [id, name] of [['1', 'Linked'], ['2', 'Unused']] as const) {
        await createTaxonomyTerm({
          db: d1, taxonomy, name, slug: name.toLowerCase(), description: '',
          now: NOW, createId: () => id.repeat(32), createRevision: () => 'a'.repeat(32),
        });
      }
    }
    const now = NOW.toISOString();
    database.prepare(`
      INSERT INTO authors (id, display_name, created_at_iso, updated_at_iso)
      VALUES ('writer', 'Writer', ?, ?)
    `).run(now, now);
    for (const [index, status] of ['draft', 'published', 'trash'].entries()) {
      const postId = String(index + 3).repeat(32);
      database.prepare(`
        INSERT INTO posts (
          id, public_id, title, slug, author_id, status, published_at_iso,
          created_at_iso, updated_at_iso
        ) VALUES (?, ?, ?, ?, 'writer', ?, ?, ?, ?)
      `).run(postId, index + 1, status, status, status,
        status === 'published' ? now : null, now, now);
      database.prepare('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)')
        .run(postId, '1'.repeat(32));
      if (status === 'trash') {
        database.prepare('INSERT INTO post_tags (post_id, tag_id, sort_order) VALUES (?, ?, 0)')
          .run(postId, '1'.repeat(32));
      }
    }
    for (const [taxonomy, count] of [['category', 3], ['tag', 1]] as const) {
      const first = await listTaxonomyTerms({
        db: d1, taxonomy, query: { ...defaultQuery, per_page: 1 },
      });
      expect(first).toMatchObject({
        items: [{ name: 'Linked', post_count: count }],
        pagination: { total: 2, total_pages: 2 },
        summary: { categories: 2, tags: 2 },
      });
      expect((await listTaxonomyTerms({
        db: d1, taxonomy, query: { ...defaultQuery, page: 2, per_page: 1 },
      })).items).toMatchObject([{ name: 'Unused', post_count: 0 }]);
      expect((await listTaxonomyTerms({
        db: d1, taxonomy, query: { ...defaultQuery, search: 'linked' },
      })).items).toMatchObject([{ name: 'Linked', post_count: count }]);
      await expect(deleteTaxonomyTerm({
        db: d1, taxonomy, id: '1'.repeat(32), expectedRevision: 'a'.repeat(32),
      })).resolves.toEqual({ kind: 'in_use' });
    }
    const preview = await listPreviewTaxonomies({ db: d1 });
    expect(preview.categories).toHaveLength(2);
    expect(preview.tags).toHaveLength(2);
    for (const term of [...preview.categories, ...preview.tags]) {
      expect(term).not.toHaveProperty('post_count');
      expect(term.revision).toBe('a'.repeat(32));
    }
    await deleteTaxonomyTerm({
      db: d1, taxonomy: 'tag', id: '2'.repeat(32), expectedRevision: 'a'.repeat(32),
    });
    expect((await listTaxonomyTerms({ db: d1, taxonomy: 'category', query: defaultQuery }))
      .summary).toEqual({ categories: 2, tags: 1 });
    database.close();
  });

  it('preserves no-op revisions and reports slug and revision conflicts', async () => {
    const { d1 } = createTestDatabase();
    for (const [id, slug, revision] of [
      ['1'.repeat(32), 'alpha', 'a'.repeat(32)],
      ['2'.repeat(32), 'beta', 'b'.repeat(32)],
    ]) {
      await createTaxonomyTerm({
        db: d1,
        taxonomy: 'tag',
        name: slug,
        slug,
        description: '',
        now: NOW,
        createId: () => id,
        createRevision: () => revision,
      });
    }
    await expect(updateTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      id: '1'.repeat(32),
      name: 'alpha',
      slug: 'alpha',
      description: '',
      expectedRevision: 'a'.repeat(32),
      createRevision: () => 'c'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      term: { revision: 'a'.repeat(32) },
    });
    await expect(updateTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      id: '1'.repeat(32),
      name: 'Alpha',
      slug: 'beta',
      description: '',
      expectedRevision: 'a'.repeat(32),
    })).resolves.toEqual({ kind: 'slug_conflict' });
    await expect(updateTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      id: '1'.repeat(32),
      name: 'Alpha',
      slug: 'alpha',
      description: '',
      expectedRevision: 'f'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('protects future references and projects every public taxonomy row', async () => {
    const { database, d1 } = createTestDatabase();
    await createTaxonomyTerm({
      db: d1,
      taxonomy: 'category',
      name: 'News',
      slug: 'news',
      description: '',
      now: NOW,
      createId: () => '1'.repeat(32),
      createRevision: () => '2'.repeat(32),
    });
    await createTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      name: 'Featured',
      slug: 'featured',
      description: 'Public tag.',
      now: NOW,
      createId: () => '3'.repeat(32),
      createRevision: () => '4'.repeat(32),
    });
    await expect(listPreviewTaxonomies({ db: d1 })).resolves.toMatchObject({
      categories: [{ slug: 'news' }],
      tags: [{ slug: 'featured' }],
    });

    database.exec(`
      CREATE TABLE taxonomy_test_reference (
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT
      );
      INSERT INTO taxonomy_test_reference (category_id)
      VALUES ('${'1'.repeat(32)}');
    `);
    await expect(deleteTaxonomyTerm({
      db: d1,
      taxonomy: 'category',
      id: '1'.repeat(32),
      expectedRevision: '2'.repeat(32),
    })).resolves.toEqual({ kind: 'in_use' });
  });

  it('fails closed for malformed stored taxonomy data', async () => {
    const { database, d1 } = createTestDatabase();
    await createTaxonomyTerm({
      db: d1,
      taxonomy: 'tag',
      name: 'Valid',
      slug: 'valid',
      description: '',
      now: NOW,
      createId: () => '1'.repeat(32),
      createRevision: () => '2'.repeat(32),
    });
    database.exec('PRAGMA ignore_check_constraints = ON');
    database.prepare("UPDATE tags SET slug = '.invalid'").run();
    await expect(listTaxonomyTerms({
      db: d1,
      taxonomy: 'tag',
      query: defaultQuery,
    })).rejects.toMatchObject({
      code: 'TAXONOMY_MANAGEMENT_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});
