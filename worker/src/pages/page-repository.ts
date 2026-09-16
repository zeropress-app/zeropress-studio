import {
  PAGE_PARENT_OPTIONS_MAX_ITEMS,
  pageEffectivePathSchema,
  pageIdSchema,
  pageListRecordSchema,
  pageParentOptionSchema,
  pageSchema,
  type CreatePageRequest,
  type Page,
  type PageBulkLifecycleData,
  type PageBulkLifecycleRequest,
  type PageListRecord,
  type PageListQuery,
  type PageParentOption,
  type UpdatePageRequest,
} from '../../../contracts/pages';
import {
  ContentSearchQueryInvalidError,
  parseContentSearchQuery,
  type ContentSearchPlan,
} from '../../../contracts/content-search';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { allocateContentPublicId } from '../content/public-id-counter';
import { StudioOperationalError } from '../lib/operational-error';
import { isConfiguredFrontPage } from '../settings/front-page-reference';
import {
  archivePageRevisionStatements,
  preparePageRevision,
} from '../content-revisions/repository';
import {
  assertContentSearchIndexReady,
  buildContentSearchMatch,
  contentSearchCte,
  contentSearchOrderExpression,
  contentSearchPredicate,
  ContentSearchIndexNotReadyError,
  prepareContentSearchReplaceStatements,
} from '../content-search/index-repository';

type PageRow = {
  id: unknown;
  public_id: unknown;
  parent_id: unknown;
  parent_title: unknown;
  parent_slug: unknown;
  title: unknown;
  slug: unknown;
  content?: unknown;
  document_type: unknown;
  editor_mode?: unknown;
  editor_profile?: unknown;
  excerpt: unknown;
  status: unknown;
  discoverability: unknown;
  allow_comments: unknown;
  featured_image_id: unknown;
  featured_image_kind: unknown;
  featured_image_filename: unknown;
  featured_image_mime_type: unknown;
  featured_image_storage_type: unknown;
  featured_image_storage_key: unknown;
  featured_image_external_url: unknown;
  featured_image_width: unknown;
  featured_image_height: unknown;
  featured_image_alt: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
  search_excerpt?: unknown;
  search_body?: unknown;
};

type PagePathRow = {
  origin_id: unknown;
  id: unknown;
  parent_id: unknown;
  slug: unknown;
};

type ParentChainRow = {
  id: unknown;
  parent_id: unknown;
  status: unknown;
};

type CountsRow = {
  all_count?: unknown;
  draft_count?: unknown;
  published_count?: unknown;
  trash_count?: unknown;
};

type IdRow = { id?: unknown };

export type PageListResult = {
  items: PageListRecord[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
  status_counts: {
    all: number;
    draft: number;
    published: number;
    trash: number;
  };
};

export type PageParentFailure = 'parent_not_found' | 'parent_cycle';
export type PageReferenceFailure = PageParentFailure | 'media_not_found';

export type CreatePageResult =
  | { kind: 'completed'; page: Page }
  | { kind: 'slug_conflict' }
  | { kind: 'autosave_conflict' }
  | { kind: PageReferenceFailure };

export type UpdatePageResult =
  | { kind: 'completed'; page: Page }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'slug_conflict' }
  | { kind: 'has_children' }
  | { kind: 'front_page_protected' }
  | { kind: 'document_type_change_forbidden' }
  | { kind: PageReferenceFailure };

export type DeletePageResult =
  | { kind: 'completed'; publicId: number }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'not_in_trash' }
  | { kind: 'has_children' }
  | { kind: 'front_page_protected' };

function pageSelect(includeContent: boolean, includeSearch = false): string {
  return `
    SELECT
      pages.id,
      pages.public_id,
      pages.parent_id,
      parent.title AS parent_title,
      parent.slug AS parent_slug,
      pages.title,
      pages.slug,
      ${includeContent ? 'pages.content,' : ''}
      pages.document_type,
      ${includeContent ? 'pages.editor_mode, pages.editor_profile,' : ''}
      pages.excerpt,
      pages.status,
      pages.discoverability,
      pages.allow_comments,
      ${includeContent ? `
        featured_media.id AS featured_image_id,
        featured_media.kind AS featured_image_kind,
        featured_media.filename AS featured_image_filename,
        featured_media.mime_type AS featured_image_mime_type,
        featured_media.storage_type AS featured_image_storage_type,
        featured_media.storage_key AS featured_image_storage_key,
        featured_media.external_url AS featured_image_external_url,
        featured_media.width AS featured_image_width,
        featured_media.height AS featured_image_height,
        featured_media.alt AS featured_image_alt,
      ` : ''}
      pages.revision,
      pages.created_at_iso,
      pages.updated_at_iso
      ${includeSearch ? ', search_fts.excerpt AS search_excerpt, search_fts.body AS search_body' : ''}
    FROM pages
    LEFT JOIN pages AS parent ON parent.id = pages.parent_id
    ${includeContent
      ? 'LEFT JOIN media AS featured_media ON featured_media.id = pages.featured_image_id'
      : ''}
  `;
}

const PAGE_SELECT = pageSelect(true);
const PAGE_SUMMARY_SELECT = pageSelect(false);
const PAGE_SEARCH_SUMMARY_SELECT = pageSelect(false, true);

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  // Projection triggers can make a successful Page mutation report > 1.
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('PAGE_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('PAGE_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function dataInvalid(cause?: unknown, action = 'validate_page_data') {
  return new StudioOperationalError('PAGE_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action },
  });
}

function parseAllowComments(value: unknown): unknown {
  if (value === 0) return false;
  if (value === 1) return true;
  return value;
}

function pageValue(row: PageRow, path: string, includeContent: boolean) {
  const parent = row.parent_id === null
    ? null
    : {
        id: row.parent_id,
        title: row.parent_title,
        slug: row.parent_slug,
      };
  return {
    id: row.id,
    public_id: row.public_id,
    parent,
    title: row.title,
    slug: row.slug,
    path,
    ...(includeContent ? { content: row.content } : {}),
    document_type: row.document_type,
    ...(includeContent ? {
      editor_mode: row.editor_mode,
      editor_profile: row.editor_profile,
    } : {}),
    excerpt: row.excerpt,
    status: row.status,
    discoverability: row.discoverability,
    allow_comments: parseAllowComments(row.allow_comments),
    ...(includeContent
      ? {
          featured_image: row.featured_image_id === null
            ? null
            : {
                id: row.featured_image_id,
                kind: row.featured_image_kind,
                filename: row.featured_image_filename,
                mime_type: row.featured_image_mime_type,
                location: row.featured_image_storage_type === 'external'
                  ? {
                      type: 'external',
                      url: row.featured_image_external_url,
                    }
                  : {
                      type: row.featured_image_storage_type,
                      key: row.featured_image_storage_key,
                    },
                width: row.featured_image_width,
                height: row.featured_image_height,
                alt: row.featured_image_alt,
              },
        }
      : {}),
    revision: row.revision,
    created_at_iso: row.created_at_iso,
    updated_at_iso: row.updated_at_iso,
  };
}

function parsePageListItem(
  row: PageRow,
  path: string,
  plan?: ContentSearchPlan,
): PageListRecord {
  const parsed = pageListRecordSchema.safeParse({
    ...pageValue(row, path, false),
    search_match: plan === undefined
      ? null
      : buildContentSearchMatch({
          excerpt: typeof row.search_excerpt === 'string'
            ? row.search_excerpt
            : '',
          body: typeof row.search_body === 'string' ? row.search_body : '',
          plan,
        }),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parsePage(row: PageRow, path: string): Page {
  const parsed = pageSchema.safeParse(pageValue(row, path, true));
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned an invalid Page count.');
  }
  return value as number;
}

function parseCounts(row: CountsRow | undefined) {
  return {
    all: parseCount(row?.all_count),
    draft: parseCount(row?.draft_count),
    published: parseCount(row?.published_count),
    trash: parseCount(row?.trash_count),
  };
}

function isSlugConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unique constraint failed:\s*pages\.(?:parent_id,\s*)?slug|idx_pages_(?:root|sibling)_slug_unique)/iu
    .test(message);
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

type PagePathNode = { parentId: string | null; slug: string };

function resolvePagePath(
  nodes: Map<string, PagePathNode>,
  originId: string,
): string {
  const segments: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = originId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw dataInvalid(undefined, 'validate_page_hierarchy');
    }
    visited.add(currentId);
    const node = nodes.get(currentId);
    if (!node) throw dataInvalid(undefined, 'validate_page_hierarchy');
    segments.push(node.slug);
    currentId = node.parentId;
  }
  const path = segments.reverse().join('/');
  const parsed = pageEffectivePathSchema.safeParse(path);
  if (!parsed.success) {
    throw dataInvalid(parsed.error, 'validate_page_hierarchy');
  }
  return parsed.data;
}

function resolvePagePaths(
  rows: PagePathRow[],
  originIds: string[],
): Map<string, string> {
  const nodesByOrigin = new Map<string, Map<string, PagePathNode>>();
  for (const row of rows) {
    if (
      typeof row.origin_id !== 'string'
      || typeof row.id !== 'string'
      || (row.parent_id !== null && typeof row.parent_id !== 'string')
      || typeof row.slug !== 'string'
    ) throw dataInvalid(undefined, 'validate_page_hierarchy');
    const nodes = nodesByOrigin.get(row.origin_id) ?? new Map();
    nodes.set(row.id, { parentId: row.parent_id, slug: row.slug });
    nodesByOrigin.set(row.origin_id, nodes);
  }

  const paths = new Map<string, string>();
  for (const originId of originIds) {
    const nodes = nodesByOrigin.get(originId);
    if (!nodes) throw dataInvalid(undefined, 'validate_page_hierarchy');
    paths.set(originId, resolvePagePath(nodes, originId));
  }
  return paths;
}

export async function readPagePaths(
  db: D1Database,
  pageIds: string[],
): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const result = await db.prepare(`
    WITH RECURSIVE page_ancestors(origin_id, id, parent_id, slug) AS (
      SELECT id, id, parent_id, slug
      FROM pages
      WHERE id IN (${pageIds.map(() => '?').join(', ')})
      UNION
      SELECT page_ancestors.origin_id, parent.id, parent.parent_id, parent.slug
      FROM pages AS parent
      INNER JOIN page_ancestors ON parent.id = page_ancestors.parent_id
    )
    SELECT origin_id, id, parent_id, slug
    FROM page_ancestors
    ORDER BY origin_id, id
  `).bind(...pageIds).all<PagePathRow>();
  if (!Array.isArray(result.results)) {
    throw new TypeError('D1 returned invalid Page hierarchy rows.');
  }
  return resolvePagePaths(result.results, pageIds);
}

async function readPageRow(
  db: D1Database,
  pageId: string,
): Promise<PageRow | null> {
  return db.prepare(`
    ${PAGE_SELECT}
    WHERE pages.id = ?
    LIMIT 1
  `).bind(pageId).first<PageRow>();
}

export async function getPage(input: {
  db: D1Database;
  id: string;
}): Promise<Page | null> {
  try {
    const row = await readPageRow(input.db, input.id);
    if (!row) return null;
    const paths = await readPagePaths(input.db, [input.id]);
    const path = paths.get(input.id);
    if (!path) throw dataInvalid(undefined, 'validate_page_hierarchy');
    return parsePage(row, path);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_page');
  }
}

export async function listPages(input: {
  db: D1Database;
  query: PageListQuery;
}): Promise<PageListResult> {
  if (input.query.search) return listSearchedPages(input);
  const commonWhere: string[] = [];
  const commonParams: unknown[] = [];
  const listWhere = [...commonWhere];
  const listParams = [...commonParams];
  if (input.query.status !== 'all') {
    listWhere.push('pages.status = ?');
    listParams.push(input.query.status);
  }
  const commonFilter = commonWhere.length > 0
    ? `WHERE ${commonWhere.join(' AND ')}`
    : '';
  const listFilter = listWhere.length > 0
    ? `WHERE ${listWhere.join(' AND ')}`
    : '';
  const offset = (input.query.page - 1) * input.query.per_page;

  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT
          COUNT(*) AS all_count,
          COALESCE(SUM(pages.status = 'draft'), 0) AS draft_count,
          COALESCE(SUM(pages.status = 'published'), 0) AS published_count,
          COALESCE(SUM(pages.status = 'trash'), 0) AS trash_count
        FROM pages
        ${commonFilter}
      `).bind(...commonParams),
      input.db.prepare(`
        ${PAGE_SUMMARY_SELECT}
        ${listFilter}
        ORDER BY pages.created_at_iso DESC, pages.id
        LIMIT ? OFFSET ?
      `).bind(...listParams, input.query.per_page, offset),
    ]);
    const statusCounts = parseCounts(
      results[0]?.results?.[0] as CountsRow | undefined,
    );
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid Page list.');
    }
    const pageRows = rows as PageRow[];
    const pageIds = pageRows.map((row) => pageIdSchema.parse(row.id));
    const paths = await readPagePaths(input.db, pageIds);
    const total = input.query.status === 'all'
      ? statusCounts.all
      : statusCounts[input.query.status];
    return {
      items: pageRows.map((row, index) => {
        const path = paths.get(pageIds[index]);
        if (!path) throw dataInvalid(undefined, 'validate_page_hierarchy');
        return parsePageListItem(row, path);
      }),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
      status_counts: statusCounts,
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_pages');
  }
}

async function listSearchedPages(input: {
  db: D1Database;
  query: PageListQuery;
}): Promise<PageListResult> {
  const plan = parseContentSearchQuery(input.query.search);
  await assertContentSearchIndexReady(input.db);
  const cte = contentSearchCte(plan);
  const predicate = contentSearchPredicate({
    plan,
    ftsTable: 'page_search_fts',
    ftsAlias: 'search_fts',
  });
  const commonWhere = [predicate.sql];
  const commonParams = [...predicate.params];
  const listWhere = [...commonWhere];
  const listParams: unknown[] = [...commonParams];
  if (input.query.status !== 'all') {
    listWhere.push('pages.status = ?');
    listParams.push(input.query.status);
  }
  const offset = (input.query.page - 1) * input.query.per_page;
  const order = contentSearchOrderExpression({
    plan,
    ftsTable: 'page_search_fts',
    ftsAlias: 'search_fts',
  });
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        ${cte.sql}
        SELECT
          COUNT(*) AS all_count,
          COALESCE(SUM(pages.status = 'draft'), 0) AS draft_count,
          COALESCE(SUM(pages.status = 'published'), 0) AS published_count,
          COALESCE(SUM(pages.status = 'trash'), 0) AS trash_count
        FROM pages
        INNER JOIN page_search_fts AS search_fts
          ON search_fts.rowid = pages.public_id
         AND search_fts.revision = pages.revision
        WHERE ${commonWhere.join(' AND ')}
      `).bind(...cte.params, ...commonParams),
      input.db.prepare(`
        ${cte.sql}
        ${PAGE_SEARCH_SUMMARY_SELECT}
        INNER JOIN page_search_fts AS search_fts
          ON search_fts.rowid = pages.public_id
         AND search_fts.revision = pages.revision
        WHERE ${listWhere.join(' AND ')}
        ORDER BY ${order}, pages.created_at_iso DESC, pages.id
        LIMIT ? OFFSET ?
      `).bind(
        ...cte.params,
        ...listParams,
        input.query.per_page,
        offset,
      ),
    ]);
    const statusCounts = parseCounts(
      results[0]?.results?.[0] as CountsRow | undefined,
    );
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid Page search result.');
    }
    const pageRows = rows as PageRow[];
    const pageIds = pageRows.map((row) => pageIdSchema.parse(row.id));
    const paths = await readPagePaths(input.db, pageIds);
    const total = input.query.status === 'all'
      ? statusCounts.all
      : statusCounts[input.query.status];
    return {
      items: pageRows.map((row, index) => {
        const path = paths.get(pageIds[index]);
        if (!path) throw dataInvalid(undefined, 'validate_page_hierarchy');
        return parsePageListItem(row, path, plan);
      }),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
      status_counts: statusCounts,
    };
  } catch (error) {
    if (
      error instanceof StudioOperationalError
      || error instanceof ContentSearchIndexNotReadyError
      || error instanceof ContentSearchQueryInvalidError
    ) throw error;
    throw new StudioOperationalError('CONTENT_SEARCH_INDEX_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'search_pages',
      },
    });
  }
}

export async function listPageParentOptions(input: {
  db: D1Database;
  search: string;
  currentPageId?: string;
}): Promise<PageParentOption[]> {
  const search = input.search;
  const exclusion = input.currentPageId
    ? `
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM pages WHERE parent_id = ?
        UNION
        SELECT pages.id
        FROM pages
        INNER JOIN descendants ON pages.parent_id = descendants.id
      )
    `
    : '';
  const currentFilter = input.currentPageId
    ? 'AND pages.id != ? AND pages.id NOT IN (SELECT id FROM descendants)'
    : '';
  const params = input.currentPageId
    ? [input.currentPageId, search, search, input.currentPageId]
    : [search, search];
  try {
    const result = await input.db.prepare(`
      ${exclusion}
      SELECT pages.id, pages.title, pages.slug
      FROM pages
      WHERE pages.status != 'trash'
        AND (
          instr(lower(pages.title), lower(?)) > 0
          OR instr(lower(pages.slug), lower(?)) > 0
        )
        ${currentFilter}
      ORDER BY pages.title COLLATE NOCASE, pages.title, pages.id
      LIMIT ${PAGE_PARENT_OPTIONS_MAX_ITEMS}
    `).bind(...params).all<{ id: unknown; title: unknown; slug: unknown }>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Page parent options.');
    }
    const ids = result.results.map((row) => pageIdSchema.parse(row.id));
    const paths = await readPagePaths(input.db, ids);
    return result.results.map((row, index) => {
      const parsed = pageParentOptionSchema.safeParse({
        id: row.id,
        title: row.title,
        slug: row.slug,
        path: paths.get(ids[index]),
      });
      if (!parsed.success) throw dataInvalid(parsed.error);
      return parsed.data;
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_page_parent_options');
  }
}

async function inspectParentSelection(input: {
  db: D1Database;
  pageId?: string;
  parentId: string | null;
}): Promise<PageParentFailure | null> {
  if (input.parentId === null) return null;
  if (input.pageId === input.parentId) return 'parent_cycle';
  const result = await input.db.prepare(`
    WITH RECURSIVE ancestors(id, parent_id, status) AS (
      SELECT id, parent_id, status FROM pages WHERE id = ?
      UNION
      SELECT pages.id, pages.parent_id, pages.status
      FROM pages
      INNER JOIN ancestors ON pages.id = ancestors.parent_id
    )
    SELECT id, parent_id, status FROM ancestors
  `).bind(input.parentId).all<ParentChainRow>();
  if (!Array.isArray(result.results) || result.results.length === 0) {
    return 'parent_not_found';
  }
  const parents = new Map<string, string | null>();
  for (const row of result.results) {
    if (
      typeof row.id !== 'string'
      || (row.parent_id !== null && typeof row.parent_id !== 'string')
      || typeof row.status !== 'string'
    ) throw dataInvalid(undefined, 'validate_page_parent');
    if (row.id === input.parentId && row.status === 'trash') {
      return 'parent_not_found';
    }
    parents.set(row.id, row.parent_id);
  }
  const visited = new Set<string>();
  let currentId: string | null = input.parentId;
  while (currentId !== null) {
    if (currentId === input.pageId || visited.has(currentId)) {
      return 'parent_cycle';
    }
    visited.add(currentId);
    if (!parents.has(currentId)) {
      throw dataInvalid(undefined, 'validate_page_parent');
    }
    currentId = parents.get(currentId) ?? null;
  }
  return null;
}

async function inspectPageReferences(input: {
  db: D1Database;
  pageId?: string;
  parentId: string | null;
  mediaId: string | null;
}): Promise<PageReferenceFailure | null> {
  const parentFailure = await inspectParentSelection(input);
  if (parentFailure) return parentFailure;
  if (input.mediaId === null) return null;
  const media = await input.db.prepare(
    `SELECT id FROM media
     WHERE id = ? AND kind = 'image'
       AND width IS NOT NULL AND height IS NOT NULL
     LIMIT 1`,
  ).bind(input.mediaId).first<IdRow>();
  return media ? null : 'media_not_found';
}

async function readSiblingSlugOwner(input: {
  db: D1Database;
  parentId: string | null;
  slug: string;
  excludeId?: string;
}): Promise<IdRow | null> {
  const exclude = input.excludeId ? 'AND id != ?' : '';
  const params = input.parentId === null
    ? [input.slug, ...(input.excludeId ? [input.excludeId] : [])]
    : [input.parentId, input.slug, ...(input.excludeId ? [input.excludeId] : [])];
  return input.db.prepare(input.parentId === null
    ? `SELECT id FROM pages WHERE parent_id IS NULL AND slug = ? ${exclude} LIMIT 1`
    : `SELECT id FROM pages WHERE parent_id = ? AND slug = ? ${exclude} LIMIT 1`)
    .bind(...params).first<IdRow>();
}

async function hasDirectChildren(db: D1Database, pageId: string) {
  const child = await db.prepare(
    'SELECT id FROM pages WHERE parent_id = ? LIMIT 1',
  ).bind(pageId).first<IdRow>();
  return child !== null;
}

function insertPageStatement(input: {
  db: D1Database;
  id: string;
  publicId: number;
  authored: CreatePageRequest;
  revision: string;
  nowIso: string;
  autosaveGuard?: {
    userId: string;
    draftId: string;
    snapshotSha256: string;
  };
}): D1PreparedStatement {
  const values = [
    input.id,
    input.publicId,
    input.authored.parent_id,
    input.authored.title,
    input.authored.slug,
    input.authored.content,
    input.authored.document_type,
    input.authored.editor_mode,
    input.authored.editor_profile,
    input.authored.excerpt,
    input.authored.status,
    input.authored.discoverability,
    input.authored.allow_comments ? 1 : 0,
    input.authored.featured_image_id,
    input.revision,
    input.nowIso,
    input.nowIso,
  ];
  const guards: string[] = [];
  const guardValues: unknown[] = [];
  if (input.authored.parent_id !== null) {
    guards.push(`EXISTS (
      SELECT 1 FROM pages AS parent
      WHERE parent.id = ? AND parent.status != 'trash'
    )`);
    guardValues.push(input.authored.parent_id);
  }
  if (input.autosaveGuard) {
    guards.push(`EXISTS (
      SELECT 1 FROM page_autosaves
      WHERE user_id = ? AND draft_id = ? AND page_id IS NULL
        AND snapshot_sha256 = ?
    )`);
    guardValues.push(
      input.autosaveGuard.userId,
      input.autosaveGuard.draftId,
      input.autosaveGuard.snapshotSha256,
    );
  }
  if (guards.length === 0) {
    return input.db.prepare(`
      INSERT INTO pages (
        id, public_id, parent_id, title, slug, content, document_type,
        editor_mode, editor_profile, excerpt, status, discoverability,
        allow_comments, featured_image_id, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...values);
  }
  return input.db.prepare(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type,
      editor_mode, editor_profile, excerpt, status, discoverability,
      allow_comments, featured_image_id, revision,
      created_at_iso, updated_at_iso
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${guards.join(' AND ')}
  `).bind(...values, ...guardValues);
}

export async function createPage(input: {
  db: D1Database;
  authored: CreatePageRequest;
  autosaveUserId?: string;
  bindAutosaveSnapshotSha256?: string;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<CreatePageResult> {
  try {
    if (
      input.bindAutosaveSnapshotSha256 !== undefined
      && (!input.autosaveUserId || !input.authored.autosave_draft_id)
    ) {
      throw new TypeError(
        'Binding an autosave requires its user and draft identifiers.',
      );
    }
    const parentFailure = await inspectPageReferences({
      db: input.db,
      parentId: input.authored.parent_id,
      mediaId: input.authored.featured_image_id,
    });
    if (parentFailure) return { kind: parentFailure };
    if (await readSiblingSlugOwner({
      db: input.db,
      parentId: input.authored.parent_id,
      slug: input.authored.slug,
    })) return { kind: 'slug_conflict' };
    const id = pageIdSchema.parse((input.createId ?? createHexId)());
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const publicId = await allocateContentPublicId({
      db: input.db,
      contentType: 'page',
    });
    const nowIso = (input.now ?? new Date()).toISOString();
    const statements = [insertPageStatement({
      db: input.db,
      id,
      publicId,
      authored: input.authored,
      revision,
      nowIso,
      ...(input.bindAutosaveSnapshotSha256 === undefined
        ? {}
        : {
            autosaveGuard: {
              userId: input.autosaveUserId!,
              draftId: input.authored.autosave_draft_id!,
              snapshotSha256: input.bindAutosaveSnapshotSha256,
            },
          }),
    }), ...prepareContentSearchReplaceStatements({
      db: input.db,
      targetType: 'page',
      document: {
        publicId,
        revision,
        title: input.authored.title,
        slug: input.authored.slug,
        excerpt: input.authored.excerpt,
        content: input.authored.content,
        documentType: input.authored.document_type,
      },
    })];
    if (input.autosaveUserId && input.authored.autosave_draft_id) {
      statements.push(input.bindAutosaveSnapshotSha256 === undefined
        ? input.db.prepare(`
          DELETE FROM page_autosaves
          WHERE user_id = ? AND draft_id = ? AND page_id IS NULL
        `).bind(input.autosaveUserId, input.authored.autosave_draft_id)
        : input.db.prepare(`
          UPDATE page_autosaves
          SET page_id = ?, base_revision = ?, expires_at_iso = NULL
          WHERE user_id = ? AND draft_id = ? AND page_id IS NULL
            AND snapshot_sha256 = ?
            AND EXISTS (
              SELECT 1 FROM pages WHERE id = ? AND revision = ?
            )
        `).bind(
          id,
          revision,
          input.autosaveUserId,
          input.authored.autosave_draft_id,
          input.bindAutosaveSnapshotSha256,
          id,
          revision,
        ));
    }
    const results = await input.db.batch(statements);
    if (readChanges(results[0]) === 0) {
      if (input.bindAutosaveSnapshotSha256 !== undefined) {
        return { kind: 'autosave_conflict' };
      }
      const latestParentFailure = await inspectPageReferences({
        db: input.db,
        parentId: input.authored.parent_id,
        mediaId: input.authored.featured_image_id,
      });
      if (latestParentFailure) return { kind: latestParentFailure };
      throw new TypeError('D1 ignored a valid Page insert.');
    }
    const page = await getPage({ db: input.db, id });
    if (!page) throw new TypeError('D1 did not return the created Page.');
    return { kind: 'completed', page };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSlugConstraint(error)) return { kind: 'slug_conflict' };
    if (isForeignKeyConstraint(error)) {
      try {
        const parentFailure = await inspectPageReferences({
          db: input.db,
          parentId: input.authored.parent_id,
          mediaId: input.authored.featured_image_id,
        });
        if (parentFailure) return { kind: parentFailure };
      } catch {
        // Preserve the original failed write as the operator-facing cause.
      }
    }
    throw writeFailure(error, 'create_page');
  }
}

function authoredMatchesPage(page: Page, authored: UpdatePageRequest): boolean {
  return (page.parent?.id ?? null) === authored.parent_id
    && page.title === authored.title
    && page.slug === authored.slug
    && page.content === authored.content
    && page.document_type === authored.document_type
    && page.editor_mode === authored.editor_mode
    && page.editor_profile === authored.editor_profile
    && page.excerpt === authored.excerpt
    && page.status === authored.status
    && page.discoverability === authored.discoverability
    && page.allow_comments === authored.allow_comments
    && (page.featured_image?.id ?? null) === authored.featured_image_id;
}

function updatePageStatement(input: {
  db: D1Database;
  id: string;
  authored: UpdatePageRequest;
  revision: string;
  nowIso: string;
}): D1PreparedStatement {
  const baseSql = `
    UPDATE OR IGNORE pages
    SET parent_id = ?, title = ?, slug = ?, content = ?, document_type = ?,
        editor_mode = ?, editor_profile = ?, excerpt = ?, status = ?,
        discoverability = ?, allow_comments = ?,
        featured_image_id = ?,
        revision = ?, updated_at_iso = ?
    WHERE id = ? AND revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM page_revisions
        WHERE page_id = ? AND revision_id = ?
      )
      AND (
        ? != 'trash'
        OR NOT EXISTS (SELECT 1 FROM pages AS child WHERE child.parent_id = ?)
      )
      AND (
        ? = 'published'
        OR NOT EXISTS (
          SELECT 1
          FROM site_settings AS front_page_setting
          WHERE front_page_setting.key = 'site_front_page'
            AND front_page_setting.type = 'json'
            AND json_extract(front_page_setting.value, '$.type') = 'page'
            AND json_extract(front_page_setting.value, '$.page_id') = ?
        )
      )
  `;
  const params: unknown[] = [
    input.authored.parent_id,
    input.authored.title,
    input.authored.slug,
    input.authored.content,
    input.authored.document_type,
    input.authored.editor_mode,
    input.authored.editor_profile,
    input.authored.excerpt,
    input.authored.status,
    input.authored.discoverability,
    input.authored.allow_comments ? 1 : 0,
    input.authored.featured_image_id,
    input.revision,
    input.nowIso,
    input.id,
    input.authored.expected_revision,
    input.id,
    input.revision,
    input.authored.status,
    input.id,
    input.authored.status,
    input.id,
  ];
  if (input.authored.parent_id === null) {
    return input.db.prepare(baseSql).bind(...params);
  }
  return input.db.prepare(`${baseSql}
      AND EXISTS (
        SELECT 1 FROM pages AS selected_parent
        WHERE selected_parent.id = ? AND selected_parent.status != 'trash'
      )
      AND NOT EXISTS (
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT id, parent_id FROM pages WHERE id = ?
          UNION
          SELECT pages.id, pages.parent_id
          FROM pages
          INNER JOIN ancestors ON pages.id = ancestors.parent_id
        )
        SELECT 1 FROM ancestors WHERE id = ?
      )
  `).bind(
    ...params,
    input.authored.parent_id,
    input.authored.parent_id,
    input.id,
  );
}

export async function updatePage(input: {
  db: D1Database;
  id: string;
  authored: UpdatePageRequest;
  autosaveUserId?: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<UpdatePageResult> {
  try {
    const current = await getPage({ db: input.db, id: input.id });
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.authored.expected_revision) {
      return { kind: 'revision_conflict' };
    }
    if (
      current.document_type !== input.authored.document_type
      && (current.content !== '' || input.authored.content !== '')
    ) return { kind: 'document_type_change_forbidden' };
    if (
      input.authored.status !== 'published'
      && await isConfiguredFrontPage({ db: input.db, pageId: input.id })
    ) return { kind: 'front_page_protected' };
    const parentFailure = await inspectPageReferences({
      db: input.db,
      pageId: input.id,
      parentId: input.authored.parent_id,
      mediaId: input.authored.featured_image_id,
    });
    if (parentFailure) return { kind: parentFailure };
    if (
      input.authored.status === 'trash'
      && await hasDirectChildren(input.db, input.id)
    ) return { kind: 'has_children' };
    if (await readSiblingSlugOwner({
      db: input.db,
      parentId: input.authored.parent_id,
      slug: input.authored.slug,
      excludeId: input.id,
    })) return { kind: 'slug_conflict' };
    if (authoredMatchesPage(current, input.authored)) {
      if (input.autosaveUserId) {
        await input.db.prepare(`
          DELETE FROM page_autosaves WHERE user_id = ? AND page_id = ?
        `).bind(input.autosaveUserId, input.id).run();
      }
      return { kind: 'completed', page: current };
    }
    const archivedRevision = await preparePageRevision(current);
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Page revision must advance.');
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const statements = [
      updatePageStatement({
        db: input.db,
        id: input.id,
        authored: input.authored,
        revision,
        nowIso,
      }),
      ...archivePageRevisionStatements({
        db: input.db,
        pageId: input.id,
        guardRevision: revision,
        archivedAtIso: nowIso,
        prepared: archivedRevision,
      }),
      ...prepareContentSearchReplaceStatements({
        db: input.db,
        targetType: 'page',
        document: {
          publicId: current.public_id,
          revision,
          title: input.authored.title,
          slug: input.authored.slug,
          excerpt: input.authored.excerpt,
          content: input.authored.content,
          documentType: input.authored.document_type,
        },
      }),
    ];
    if (input.autosaveUserId) {
      statements.push(input.db.prepare(`
        DELETE FROM page_autosaves
        WHERE user_id = ? AND page_id = ?
          AND EXISTS (
            SELECT 1 FROM pages WHERE id = ? AND revision = ?
          )
      `).bind(input.autosaveUserId, input.id, input.id, revision));
    }
    const results = await input.db.batch(statements);
    if (readChanges(results[0]) === 0) {
      const latest = await getPage({ db: input.db, id: input.id });
      if (!latest) return { kind: 'not_found' };
      if (latest.revision !== input.authored.expected_revision) {
        return { kind: 'revision_conflict' };
      }
      if (
        input.authored.status !== 'published'
        && await isConfiguredFrontPage({ db: input.db, pageId: input.id })
      ) return { kind: 'front_page_protected' };
      const latestParentFailure = await inspectPageReferences({
        db: input.db,
        pageId: input.id,
        parentId: input.authored.parent_id,
        mediaId: input.authored.featured_image_id,
      });
      if (latestParentFailure) return { kind: latestParentFailure };
      if (
        input.authored.status === 'trash'
        && await hasDirectChildren(input.db, input.id)
      ) return { kind: 'has_children' };
      if (await readSiblingSlugOwner({
        db: input.db,
        parentId: input.authored.parent_id,
        slug: input.authored.slug,
        excludeId: input.id,
      })) return { kind: 'slug_conflict' };
      throw new TypeError('D1 ignored a valid Page update.');
    }
    const page = await getPage({ db: input.db, id: input.id });
    if (!page) throw new TypeError('D1 did not return the updated Page.');
    return { kind: 'completed', page };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSlugConstraint(error)) return { kind: 'slug_conflict' };
    if (isForeignKeyConstraint(error)) {
      try {
        const parentFailure = await inspectPageReferences({
          db: input.db,
          pageId: input.id,
          parentId: input.authored.parent_id,
          mediaId: input.authored.featured_image_id,
        });
        if (parentFailure) return { kind: parentFailure };
      } catch {
        // Preserve the original failed write as the operator-facing cause.
      }
    }
    throw writeFailure(error, 'update_page');
  }
}

function pageLifecycleAuthored(
  page: Page,
  targetStatus: PageBulkLifecycleRequest['target_status'],
  expectedRevision: string,
): UpdatePageRequest {
  return {
    parent_id: page.parent?.id ?? null,
    title: page.title,
    slug: page.slug,
    content: page.content,
    document_type: page.document_type,
    editor_mode: page.editor_mode,
    editor_profile: page.editor_profile,
    excerpt: page.excerpt,
    status: targetStatus,
    discoverability: page.discoverability,
    allow_comments: page.allow_comments,
    featured_image_id: page.featured_image?.id ?? null,
    expected_revision: expectedRevision,
  };
}

function summarizePageBulkLifecycle(
  results: PageBulkLifecycleData['results'],
): PageBulkLifecycleData['summary'] {
  const summary = {
    requested: results.length,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    skipped: 0,
  };
  for (const result of results) summary[result.outcome] += 1;
  return summary;
}

export async function updatePageBulkLifecycle(input: {
  db: D1Database;
  request: PageBulkLifecycleRequest;
  now?: Date;
  createRevision?: () => string;
}): Promise<PageBulkLifecycleData> {
  const results: PageBulkLifecycleData['results'] = [];
  for (const item of input.request.items) {
    const current = await getPage({ db: input.db, id: item.id });
    if (!current) {
      results.push({
        id: item.id,
        outcome: 'skipped',
        reason: 'not_found',
      });
      continue;
    }
    if (current.status === input.request.target_status) {
      results.push({
        id: item.id,
        outcome: 'unchanged',
        status: current.status,
        revision: current.revision,
      });
      continue;
    }
    if (current.revision !== item.expected_revision) {
      results.push({ id: item.id, outcome: 'conflict' });
      continue;
    }
    const updated = await updatePage({
      db: input.db,
      id: item.id,
      authored: pageLifecycleAuthored(
        current,
        input.request.target_status,
        item.expected_revision,
      ),
      now: input.now,
      createRevision: input.createRevision,
    });
    if (updated.kind === 'completed') {
      results.push({
        id: item.id,
        outcome: 'updated',
        status: updated.page.status,
        revision: updated.page.revision,
      });
      continue;
    }
    if (updated.kind === 'not_found') {
      results.push({
        id: item.id,
        outcome: 'skipped',
        reason: 'not_found',
      });
      continue;
    }
    if (updated.kind === 'front_page_protected') {
      results.push({
        id: item.id,
        outcome: 'skipped',
        reason: 'front_page_protected',
      });
      continue;
    }
    if (updated.kind === 'has_children') {
      results.push({
        id: item.id,
        outcome: 'skipped',
        reason: 'has_children',
      });
      continue;
    }
    if (updated.kind === 'revision_conflict') {
      const latest = await getPage({ db: input.db, id: item.id });
      if (latest?.status === input.request.target_status) {
        results.push({
          id: item.id,
          outcome: 'unchanged',
          status: latest.status,
          revision: latest.revision,
        });
      } else if (!latest) {
        results.push({
          id: item.id,
          outcome: 'skipped',
          reason: 'not_found',
        });
      } else {
        results.push({ id: item.id, outcome: 'conflict' });
      }
      continue;
    }
    throw new TypeError(
      `Page bulk lifecycle encountered unexpected result: ${updated.kind}`,
    );
  }
  return {
    target_status: input.request.target_status,
    results,
    summary: summarizePageBulkLifecycle(results),
  };
}

export async function deletePage(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
}): Promise<DeletePageResult> {
  try {
    const identity = await input.db.prepare(`
      SELECT public_id
      FROM pages
      WHERE id = ?
      LIMIT 1
    `).bind(input.id).first<{ public_id?: unknown }>();
    if (!identity) return { kind: 'not_found' };
    const publicId = Number(identity.public_id);
    if (!Number.isInteger(publicId) || publicId <= 0) {
      throw new StudioOperationalError('PAGE_MANAGEMENT_DATA_INVALID', {
        metadata: {
          resource: 'DB',
          action: 'delete_page',
        },
      });
    }
    if (await isConfiguredFrontPage({ db: input.db, pageId: input.id })) {
      return { kind: 'front_page_protected' };
    }
    const result = await input.db.prepare(`
      DELETE FROM pages
      WHERE id = ? AND revision = ? AND status = 'trash'
        AND NOT EXISTS (
          SELECT 1 FROM pages AS child WHERE child.parent_id = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM site_settings AS front_page_setting
          WHERE front_page_setting.key = 'site_front_page'
            AND front_page_setting.type = 'json'
            AND json_extract(front_page_setting.value, '$.type') = 'page'
            AND json_extract(front_page_setting.value, '$.page_id') = ?
        )
    `).bind(
      input.id,
      input.expectedRevision,
      input.id,
      input.id,
    ).run();
    if (readChanges(result) > 0) return { kind: 'completed', publicId };
    const current = await getPage({ db: input.db, id: input.id });
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (await isConfiguredFrontPage({ db: input.db, pageId: input.id })) {
      return { kind: 'front_page_protected' };
    }
    if (current.status !== 'trash') return { kind: 'not_in_trash' };
    if (await hasDirectChildren(input.db, input.id)) {
      return { kind: 'has_children' };
    }
    throw new TypeError('D1 ignored a valid Page deletion.');
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isForeignKeyConstraint(error)) {
      try {
        if (await hasDirectChildren(input.db, input.id)) {
          return { kind: 'has_children' };
        }
      } catch {
        // Preserve the original failed write as the operator-facing cause.
      }
    }
    throw writeFailure(error, 'delete_page');
  }
}

export async function listPreviewPages(input: {
  db: D1Database;
}): Promise<Page[]> {
  try {
    const result = await input.db.prepare(`
      ${PAGE_SELECT}
      WHERE pages.status = 'published'
      ORDER BY pages.public_id, pages.id
    `).all<PageRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Preview Page rows.');
    }
    const rows = result.results;
    const originIds = rows.map((row) => pageIdSchema.parse(row.id));
    // Draft ancestors are path metadata only. They are never returned in
    // Preview Data, but keeping their slug segments preserves the authored
    // public path of a published child Page.
    const paths = await readPagePaths(input.db, originIds);
    return rows.map((row, index) => {
      const path = paths.get(originIds[index]);
      if (!path) throw dataInvalid(undefined, 'validate_page_hierarchy');
      return parsePage(row, path);
    }).sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1
        : left.public_id - right.public_id
    ));
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_pages');
  }
}
