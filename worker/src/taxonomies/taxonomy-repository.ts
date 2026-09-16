import {
  taxonomyListItemSchema,
  taxonomyListSummarySchema,
  taxonomyTermIdSchema,
  taxonomyTermSchema,
  type TaxonomyKind,
  type TaxonomyListItem,
  type TaxonomyListQuery,
  type TaxonomyListSummary,
  type TaxonomyTerm,
} from '../../../contracts/taxonomies';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

type TaxonomyTermRow = {
  id: unknown;
  name: unknown;
  slug: unknown;
  description: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
};

type CountRow = { row_count?: unknown };
type TaxonomyListRow = TaxonomyTermRow & { post_count: unknown };

export type TaxonomyListResult = {
  items: TaxonomyListItem[];
  summary: TaxonomyListSummary;
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
};

export type PreviewTaxonomies = {
  categories: TaxonomyTerm[];
  tags: TaxonomyTerm[];
};

export type CreateTaxonomyTermResult =
  | { kind: 'completed'; term: TaxonomyTerm }
  | { kind: 'slug_conflict' };

export type UpdateTaxonomyTermResult =
  | { kind: 'completed'; term: TaxonomyTerm }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'slug_conflict' };

export type DeleteTaxonomyTermResult =
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'in_use' };

function tableFor(taxonomy: TaxonomyKind): 'categories' | 'tags' {
  return taxonomy === 'category' ? 'categories' : 'tags';
}

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown>): number {
  const changes = result.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'TAXONOMY_MANAGEMENT_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'TAXONOMY_MANAGEMENT_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('TAXONOMY_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_taxonomy_data' },
  });
}

function parseTerm(
  taxonomy: TaxonomyKind,
  row: TaxonomyTermRow,
): TaxonomyTerm {
  const parsed = taxonomyTermSchema.safeParse({
    ...row,
    taxonomy,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseListItem(
  taxonomy: TaxonomyKind,
  row: TaxonomyListRow,
): TaxonomyListItem {
  const parsed = taxonomyListItemSchema.safeParse({ ...row, taxonomy });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function readCount(result: D1Result<unknown> | undefined): number {
  const row = result?.results?.[0] as CountRow | undefined;
  if (!Number.isInteger(row?.row_count) || (row?.row_count as number) < 0) {
    throw new TypeError('D1 returned an invalid taxonomy count.');
  }
  return row?.row_count as number;
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

async function readTerm(
  db: D1Database,
  taxonomy: TaxonomyKind,
  id: string,
): Promise<TaxonomyTerm | null> {
  const table = tableFor(taxonomy);
  const row = await db.prepare(`
    SELECT id, name, slug, description, revision,
           created_at_iso, updated_at_iso
    FROM ${table}
    WHERE id = ?
    LIMIT 1
  `).bind(id).first<TaxonomyTermRow>();
  return row ? parseTerm(taxonomy, row) : null;
}

async function readTermBySlug(
  db: D1Database,
  taxonomy: TaxonomyKind,
  slug: string,
): Promise<TaxonomyTerm | null> {
  const table = tableFor(taxonomy);
  const row = await db.prepare(`
    SELECT id, name, slug, description, revision,
           created_at_iso, updated_at_iso
    FROM ${table}
    WHERE slug = ?
    LIMIT 1
  `).bind(slug).first<TaxonomyTermRow>();
  return row ? parseTerm(taxonomy, row) : null;
}

export async function listTaxonomyTerms(input: {
  db: D1Database;
  taxonomy: TaxonomyKind;
  query: TaxonomyListQuery;
}): Promise<TaxonomyListResult> {
  const table = tableFor(input.taxonomy);
  const relation = input.taxonomy === 'category' ? 'post_categories' : 'post_tags';
  const reference = input.taxonomy === 'category' ? 'category_id' : 'tag_id';
  const params: unknown[] = [];
  let filter = '';
  if (input.query.search) {
    const search = input.query.search;
    filter = `WHERE (
      instr(lower(name), lower(?)) > 0
      OR instr(lower(slug), lower(?)) > 0
      OR instr(lower(description), lower(?)) > 0
    )`;
    params.push(search, search, search);
  }
  const offset = (input.query.page - 1) * input.query.per_page;

  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM ${table}
        ${filter}
      `).bind(...params),
      input.db.prepare(`
        SELECT id, name, slug, description, revision,
               created_at_iso, updated_at_iso,
               (SELECT COUNT(*) FROM ${relation}
                WHERE ${reference} = ${table}.id) AS post_count
        FROM ${table}
        ${filter}
        ORDER BY name COLLATE NOCASE, name, slug, id
        LIMIT ? OFFSET ?
      `).bind(...params, input.query.per_page, offset),
      input.db.prepare(`
        SELECT (SELECT COUNT(*) FROM categories) AS categories,
               (SELECT COUNT(*) FROM tags) AS tags
      `),
    ]);
    const total = readCount(results[0]);
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid taxonomy list.');
    }
    const summary = taxonomyListSummarySchema.safeParse(results[2]?.results?.[0]);
    if (!summary.success) throw dataInvalid(summary.error);
    return {
      items: (rows as TaxonomyListRow[])
        .map((row) => parseListItem(input.taxonomy, row)),
      summary: summary.data,
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0
          ? 0
          : Math.ceil(total / input.query.per_page),
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, `list_${table}`);
  }
}

export async function listPreviewTaxonomies(input: {
  db: D1Database;
}): Promise<PreviewTaxonomies> {
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT id, name, slug, description, revision,
               created_at_iso, updated_at_iso
        FROM categories
        ORDER BY name COLLATE NOCASE, name, slug, id
      `),
      input.db.prepare(`
        SELECT id, name, slug, description, revision,
               created_at_iso, updated_at_iso
        FROM tags
        ORDER BY name COLLATE NOCASE, name, slug, id
      `),
    ]);
    const categories = results[0]?.results;
    const tags = results[1]?.results;
    if (!Array.isArray(categories) || !Array.isArray(tags)) {
      throw new TypeError('D1 returned invalid Preview taxonomy rows.');
    }
    return {
      categories: (categories as TaxonomyTermRow[])
        .map((row) => parseTerm('category', row)),
      tags: (tags as TaxonomyTermRow[])
        .map((row) => parseTerm('tag', row)),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_taxonomies');
  }
}

export async function createTaxonomyTerm(input: {
  db: D1Database;
  taxonomy: TaxonomyKind;
  name: string;
  slug: string;
  description: string;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<CreateTaxonomyTermResult> {
  const table = tableFor(input.taxonomy);
  try {
    if (await readTermBySlug(input.db, input.taxonomy, input.slug)) {
      return { kind: 'slug_conflict' };
    }
    const id = taxonomyTermIdSchema.parse((input.createId ?? createHexId)());
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO ${table} (
        id, name, slug, description, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.name,
      input.slug,
      input.description,
      revision,
      nowIso,
      nowIso,
    ).run();
    if (readChanges(result) === 0) {
      if (await readTermBySlug(input.db, input.taxonomy, input.slug)) {
        return { kind: 'slug_conflict' };
      }
      throw new TypeError('D1 ignored a valid taxonomy insert.');
    }
    const term = await readTerm(input.db, input.taxonomy, id);
    if (!term) throw new TypeError('D1 did not return the created taxonomy.');
    return { kind: 'completed', term };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, `create_${table}`);
  }
}

export async function updateTaxonomyTerm(input: {
  db: D1Database;
  taxonomy: TaxonomyKind;
  id: string;
  name: string;
  slug: string;
  description: string;
  expectedRevision: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdateTaxonomyTermResult> {
  const table = tableFor(input.taxonomy);
  try {
    const current = await readTerm(input.db, input.taxonomy, input.id);
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const slugOwner = await readTermBySlug(
      input.db,
      input.taxonomy,
      input.slug,
    );
    if (slugOwner && slugOwner.id !== input.id) {
      return { kind: 'slug_conflict' };
    }
    if (
      current.name === input.name
      && current.slug === input.slug
      && current.description === input.description
    ) {
      return { kind: 'completed', term: current };
    }
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Taxonomy revision must advance.');
    }
    const result = await input.db.prepare(`
      UPDATE OR IGNORE ${table}
      SET name = ?, slug = ?, description = ?, revision = ?,
          updated_at_iso = ?
      WHERE id = ? AND revision = ?
    `).bind(
      input.name,
      input.slug,
      input.description,
      revision,
      (input.now ?? new Date()).toISOString(),
      input.id,
      input.expectedRevision,
    ).run();
    if (readChanges(result) === 0) {
      const latest = await readTerm(input.db, input.taxonomy, input.id);
      if (!latest) return { kind: 'not_found' };
      if (latest.revision !== input.expectedRevision) {
        return { kind: 'revision_conflict' };
      }
      const latestSlugOwner = await readTermBySlug(
        input.db,
        input.taxonomy,
        input.slug,
      );
      if (latestSlugOwner && latestSlugOwner.id !== input.id) {
        return { kind: 'slug_conflict' };
      }
      throw new TypeError('D1 ignored a valid taxonomy update.');
    }
    const term = await readTerm(input.db, input.taxonomy, input.id);
    if (!term) throw new TypeError('D1 did not return updated taxonomy.');
    return { kind: 'completed', term };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, `update_${table}`);
  }
}

export async function deleteTaxonomyTerm(input: {
  db: D1Database;
  taxonomy: TaxonomyKind;
  id: string;
  expectedRevision: string;
}): Promise<DeleteTaxonomyTermResult> {
  const table = tableFor(input.taxonomy);
  try {
    const result = await input.db.prepare(`
      DELETE FROM ${table}
      WHERE id = ? AND revision = ?
    `).bind(input.id, input.expectedRevision).run();
    if (readChanges(result) === 1) return { kind: 'completed' };
    const current = await readTerm(input.db, input.taxonomy, input.id);
    return current
      ? { kind: 'revision_conflict' }
      : { kind: 'not_found' };
  } catch (error) {
    if (isForeignKeyConstraint(error)) return { kind: 'in_use' };
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, `delete_${table}`);
  }
}
