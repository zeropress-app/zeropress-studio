import {
  POST_EDITOR_OPTIONS_MAX_ITEMS,
  postEditorOptionSchema,
  postIdSchema,
  postSchema,
  postListRecordSchema,
  postTaxonomyTermSchema,
  type CreatePostRequest,
  type Post,
  type PostListRecord,
  type PostEditorOption,
  type PostEditorOptionKind,
  type PostBulkLifecycleData,
  type PostBulkLifecycleRequest,
  type PostListQuery,
  type UpdatePostRequest,
} from '../../../contracts/posts';
import {
  ContentSearchQueryInvalidError,
  parseContentSearchQuery,
  type ContentSearchPlan,
} from '../../../contracts/content-search';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { allocateContentPublicId } from '../content/public-id-counter';
import { StudioOperationalError } from '../lib/operational-error';
import {
  archivePostRevisionStatements,
  preparePostRevision,
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

type PostRow = {
  id: unknown;
  public_id: unknown;
  title: unknown;
  slug: unknown;
  content?: unknown;
  document_type: unknown;
  editor_mode?: unknown;
  editor_profile?: unknown;
  excerpt: unknown;
  status: unknown;
  author_id: unknown;
  author_display_name: unknown;
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
  published_at_iso: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
  search_excerpt?: unknown;
  search_body?: unknown;
};

type RelationRow = {
  post_id: unknown;
  id: unknown;
  name: unknown;
  slug: unknown;
};

type CountsRow = {
  all_count?: unknown;
  draft_count?: unknown;
  published_count?: unknown;
  trash_count?: unknown;
};

type OptionRow = {
  id: unknown;
  label: unknown;
  slug: unknown;
};

type IdRow = { id?: unknown };

export type PostListResult = {
  items: PostListRecord[];
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

export type PostAuthorScope = {
  authorId: string;
  userId: string;
};

export type PostReferenceFailure =
  | 'author_not_found'
  | 'category_not_found'
  | 'tag_not_found'
  | 'media_not_found';

export type CreatePostResult =
  | { kind: 'completed'; post: Post }
  | { kind: 'slug_conflict' }
  | { kind: 'autosave_conflict' }
  | { kind: 'author_scope_changed' }
  | { kind: PostReferenceFailure };

export type UpdatePostResult =
  | { kind: 'completed'; post: Post; previousStatus?: Post['status'] }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'slug_conflict' }
  | { kind: 'author_scope_changed' }
  | { kind: 'document_type_change_forbidden' }
  | { kind: PostReferenceFailure };

export type DeletePostResult =
  | { kind: 'completed'; publicId: number; title?: string }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'not_in_trash' };

function postSelect(includeContent: boolean, includeSearch = false): string {
  return `
  SELECT
    posts.id,
    posts.public_id,
    posts.title,
    posts.slug,
    ${includeContent ? 'posts.content,' : ''}
    posts.document_type,
    ${includeContent ? 'posts.editor_mode, posts.editor_profile,' : ''}
    posts.excerpt,
    posts.status,
    authors.id AS author_id,
    authors.display_name AS author_display_name,
    posts.discoverability,
    posts.allow_comments,
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
    posts.published_at_iso,
    posts.revision,
    posts.created_at_iso,
    posts.updated_at_iso
    ${includeSearch ? ', search_fts.excerpt AS search_excerpt, search_fts.body AS search_body' : ''}
  FROM posts
  INNER JOIN authors ON authors.id = posts.author_id
  ${includeContent
    ? 'LEFT JOIN media AS featured_media ON featured_media.id = posts.featured_image_id'
    : ''}
`;
}

const POST_SELECT = postSelect(true);
const POST_SUMMARY_SELECT = postSelect(false);
const POST_SEARCH_SUMMARY_SELECT = postSelect(false, true);

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  // Projection triggers can make a successful Post mutation report > 1.
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('POST_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('POST_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('POST_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_post_data' },
  });
}

function parseAllowComments(value: unknown): unknown {
  if (value === 0) return false;
  if (value === 1) return true;
  return value;
}

function postValue(row: PostRow, includeContent: boolean) {
  return {
    id: row.id,
    public_id: row.public_id,
    title: row.title,
    slug: row.slug,
    ...(includeContent ? { content: row.content } : {}),
    document_type: row.document_type,
    ...(includeContent ? {
      editor_mode: row.editor_mode,
      editor_profile: row.editor_profile,
    } : {}),
    excerpt: row.excerpt,
    status: row.status,
    author: {
      id: row.author_id,
      display_name: row.author_display_name,
    },
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
    published_at_iso: row.published_at_iso,
    revision: row.revision,
    created_at_iso: row.created_at_iso,
    updated_at_iso: row.updated_at_iso,
  };
}

function parsePostListItem(
  row: PostRow,
  plan?: ContentSearchPlan,
): PostListRecord {
  const searchMatch = plan === undefined
    ? null
    : buildContentSearchMatch({
        excerpt: typeof row.search_excerpt === 'string'
          ? row.search_excerpt
          : '',
        body: typeof row.search_body === 'string' ? row.search_body : '',
        plan,
      });
  const parsed = postListRecordSchema.safeParse({
    ...postValue(row, false),
    search_match: searchMatch,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseRelation(row: RelationRow) {
  const parsed = postTaxonomyTermSchema.safeParse({
    id: row.id,
    name: row.name,
    slug: row.slug,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parsePost(
  row: PostRow,
  categories: RelationRow[],
  tags: RelationRow[],
): Post {
  const parsed = postSchema.safeParse({
    ...postValue(row, true),
    categories: categories.map(parseRelation),
    tags: tags.map(parseRelation),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned an invalid Post count.');
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
  return /(?:unique constraint failed:\s*posts\.slug|posts\.slug.*unique)/iu
    .test(message);
}

function isForeignKeyConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /foreign key constraint failed/iu.test(message);
}

async function readPostRow(
  db: D1Database,
  postId: string,
): Promise<PostRow | null> {
  return db.prepare(`
    ${POST_SELECT}
    WHERE posts.id = ?
    LIMIT 1
  `).bind(postId).first<PostRow>();
}

async function readPostRelations(
  db: D1Database,
  postId: string,
): Promise<{ categories: RelationRow[]; tags: RelationRow[] }> {
  const results = await db.batch([
    db.prepare(`
      SELECT post_categories.post_id, categories.id, categories.name,
             categories.slug
      FROM post_categories
      INNER JOIN categories ON categories.id = post_categories.category_id
      WHERE post_categories.post_id = ?
      ORDER BY categories.name COLLATE NOCASE, categories.name,
               categories.slug, categories.id
    `).bind(postId),
    db.prepare(`
      SELECT post_tags.post_id, tags.id, tags.name, tags.slug
      FROM post_tags
      INNER JOIN tags ON tags.id = post_tags.tag_id
      WHERE post_tags.post_id = ?
      ORDER BY post_tags.sort_order, tags.slug, tags.id
    `).bind(postId),
  ]);
  const categories = results[0]?.results;
  const tags = results[1]?.results;
  if (!Array.isArray(categories) || !Array.isArray(tags)) {
    throw new TypeError('D1 returned invalid Post relations.');
  }
  return {
    categories: categories as RelationRow[],
    tags: tags as RelationRow[],
  };
}

export async function getPost(input: {
  db: D1Database;
  id: string;
  authorId?: string;
}): Promise<Post | null> {
  try {
    const row = input.authorId === undefined
      ? await readPostRow(input.db, input.id)
      : await input.db.prepare(`
          ${POST_SELECT}
          WHERE posts.id = ? AND posts.author_id = ?
          LIMIT 1
        `).bind(input.id, input.authorId).first<PostRow>();
    if (!row) return null;
    const relations = await readPostRelations(input.db, input.id);
    return parsePost(row, relations.categories, relations.tags);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_post');
  }
}

export async function listPosts(input: {
  db: D1Database;
  query: PostListQuery;
  authorId?: string | null;
}): Promise<PostListResult> {
  if (input.query.search) return listSearchedPosts(input);
  const commonWhere: string[] = [];
  const commonParams: unknown[] = [];
  if (input.authorId === null) {
    commonWhere.push('0 = 1');
  } else if (input.authorId !== undefined) {
    commonWhere.push('posts.author_id = ?');
    commonParams.push(input.authorId);
  }
  const listWhere = [...commonWhere];
  const listParams = [...commonParams];
  if (input.query.status !== 'all') {
    listWhere.push('posts.status = ?');
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
          COALESCE(SUM(posts.status = 'draft'), 0) AS draft_count,
          COALESCE(SUM(posts.status = 'published'), 0) AS published_count,
          COALESCE(SUM(posts.status = 'trash'), 0) AS trash_count
        FROM posts
        ${commonFilter}
      `).bind(...commonParams),
      input.db.prepare(`
        ${POST_SUMMARY_SELECT}
        ${listFilter}
        ORDER BY posts.created_at_iso DESC, posts.id
        LIMIT ? OFFSET ?
      `).bind(...listParams, input.query.per_page, offset),
    ]);
    const statusCounts = parseCounts(
      results[0]?.results?.[0] as CountsRow | undefined,
    );
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid Post list.');
    }
    const total = input.query.status === 'all'
      ? statusCounts.all
      : statusCounts[input.query.status];
    return {
      items: (rows as PostRow[]).map((row) => parsePostListItem(row)),
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
    throw queryFailure(error, 'list_posts');
  }
}

async function listSearchedPosts(input: {
  db: D1Database;
  query: PostListQuery;
  authorId?: string | null;
}): Promise<PostListResult> {
  const plan = parseContentSearchQuery(input.query.search);
  await assertContentSearchIndexReady(input.db);
  const cte = contentSearchCte(plan);
  const predicate = contentSearchPredicate({
    plan,
    ftsTable: 'post_search_fts',
    ftsAlias: 'search_fts',
  });
  const commonWhere = [predicate.sql];
  const commonParams: unknown[] = [...predicate.params];
  if (input.authorId === null) {
    commonWhere.push('0 = 1');
  } else if (input.authorId !== undefined) {
    commonWhere.push('posts.author_id = ?');
    commonParams.push(input.authorId);
  }
  const listWhere = [...commonWhere];
  const listParams = [...commonParams];
  if (input.query.status !== 'all') {
    listWhere.push('posts.status = ?');
    listParams.push(input.query.status);
  }
  const commonFilter = `WHERE ${commonWhere.join(' AND ')}`;
  const listFilter = `WHERE ${listWhere.join(' AND ')}`;
  const offset = (input.query.page - 1) * input.query.per_page;
  const order = contentSearchOrderExpression({
    plan,
    ftsTable: 'post_search_fts',
    ftsAlias: 'search_fts',
  });
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        ${cte.sql}
        SELECT
          COUNT(*) AS all_count,
          COALESCE(SUM(posts.status = 'draft'), 0) AS draft_count,
          COALESCE(SUM(posts.status = 'published'), 0) AS published_count,
          COALESCE(SUM(posts.status = 'trash'), 0) AS trash_count
        FROM posts
        INNER JOIN post_search_fts AS search_fts
          ON search_fts.rowid = posts.public_id
         AND search_fts.revision = posts.revision
        ${commonFilter}
      `).bind(...cte.params, ...commonParams),
      input.db.prepare(`
        ${cte.sql}
        ${POST_SEARCH_SUMMARY_SELECT}
        INNER JOIN post_search_fts AS search_fts
          ON search_fts.rowid = posts.public_id
         AND search_fts.revision = posts.revision
        ${listFilter}
        ORDER BY ${order}, posts.created_at_iso DESC, posts.id
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
      throw new TypeError('D1 returned an invalid Post search result.');
    }
    const total = input.query.status === 'all'
      ? statusCounts.all
      : statusCounts[input.query.status];
    return {
      items: (rows as PostRow[]).map((row) => parsePostListItem(row, plan)),
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
        action: 'search_posts',
      },
    });
  }
}

export async function listPostEditorOptions(input: {
  db: D1Database;
  kind: PostEditorOptionKind;
  search: string;
  authorId?: string | null;
}): Promise<PostEditorOption[]> {
  if (input.kind === 'author' && input.authorId === null) return [];
  const search = input.search;
  let sql: string;
  let params: unknown[] = [search, search];
  if (input.kind === 'author') {
    if (input.authorId === undefined) {
      sql = `
        SELECT id, display_name AS label, NULL AS slug
        FROM authors
        WHERE instr(lower(id), lower(?)) > 0
           OR instr(lower(display_name), lower(?)) > 0
        ORDER BY display_name COLLATE NOCASE, display_name, id
        LIMIT ${POST_EDITOR_OPTIONS_MAX_ITEMS}
      `;
    } else {
      sql = `
        SELECT id, display_name AS label, NULL AS slug
        FROM authors
        WHERE id = ?
          AND (instr(lower(id), lower(?)) > 0
            OR instr(lower(display_name), lower(?)) > 0)
        LIMIT 1
      `;
      params = [input.authorId, search, search];
    }
  } else {
    const table = input.kind === 'category' ? 'categories' : 'tags';
    sql = `
      SELECT id, name AS label, slug
      FROM ${table}
      WHERE instr(lower(name), lower(?)) > 0
         OR instr(lower(slug), lower(?)) > 0
      ORDER BY name COLLATE NOCASE, name, slug, id
      LIMIT ${POST_EDITOR_OPTIONS_MAX_ITEMS}
    `;
  }
  try {
    const result = await input.db.prepare(sql).bind(...params)
      .all<OptionRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Post editor options.');
    }
    return result.results.map((row) => {
      const parsed = postEditorOptionSchema.safeParse({
        kind: input.kind,
        id: row.id,
        label: row.label,
        slug: row.slug,
      });
      if (!parsed.success) throw dataInvalid(parsed.error);
      return parsed.data;
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, `list_post_${input.kind}_options`);
  }
}

async function inspectReferences(input: {
  db: D1Database;
  authorId: string;
  authorUserId?: string;
  categoryIds: string[];
  tagIds: string[];
  mediaId: string | null;
}): Promise<PostReferenceFailure | null> {
  const statements: D1PreparedStatement[] = [
    input.authorUserId === undefined
      ? input.db.prepare('SELECT id FROM authors WHERE id = ? LIMIT 1')
          .bind(input.authorId)
      : input.db.prepare(`
          SELECT id FROM authors
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `).bind(input.authorId, input.authorUserId),
  ];
  const categoryIndex = input.categoryIds.length > 0 ? statements.length : -1;
  if (categoryIndex >= 0) {
    statements.push(input.db.prepare(`
      SELECT id FROM categories
      WHERE id IN (${input.categoryIds.map(() => '?').join(', ')})
    `).bind(...input.categoryIds));
  }
  const tagIndex = input.tagIds.length > 0 ? statements.length : -1;
  if (tagIndex >= 0) {
    statements.push(input.db.prepare(`
      SELECT id FROM tags
      WHERE id IN (${input.tagIds.map(() => '?').join(', ')})
    `).bind(...input.tagIds));
  }
  const mediaIndex = input.mediaId ? statements.length : -1;
  if (mediaIndex >= 0) {
    statements.push(input.db.prepare(
      `SELECT id FROM media
       WHERE id = ? AND kind = 'image'
         AND width IS NOT NULL AND height IS NOT NULL
       LIMIT 1`,
    ).bind(input.mediaId));
  }
  const results = await input.db.batch(statements);
  if ((results[0]?.results?.length ?? 0) !== 1) return 'author_not_found';
  if (
    categoryIndex >= 0
    && results[categoryIndex]?.results?.length !== input.categoryIds.length
  ) return 'category_not_found';
  if (
    tagIndex >= 0
    && results[tagIndex]?.results?.length !== input.tagIds.length
  ) return 'tag_not_found';
  if (mediaIndex >= 0 && results[mediaIndex]?.results?.length !== 1) {
    return 'media_not_found';
  }
  return null;
}

async function readPostBySlug(
  db: D1Database,
  slug: string,
): Promise<IdRow | null> {
  return db.prepare('SELECT id FROM posts WHERE slug = ? LIMIT 1')
    .bind(slug).first<IdRow>();
}

function categoryInsertStatements(
  db: D1Database,
  postId: string,
  categoryIds: string[],
  guardRevision?: string,
): D1PreparedStatement[] {
  if (categoryIds.length === 0) return [];
  return [guardRevision
    ? db.prepare(`
        INSERT INTO post_categories (post_id, category_id)
        SELECT ?, CAST(value AS TEXT)
        FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM posts WHERE id = ? AND revision = ?
        )
      `).bind(postId, JSON.stringify(categoryIds), postId, guardRevision)
    : db.prepare(`
        INSERT INTO post_categories (post_id, category_id)
        SELECT ?, CAST(value AS TEXT) FROM json_each(?)
      `).bind(postId, JSON.stringify(categoryIds))];
}

function tagInsertStatements(
  db: D1Database,
  postId: string,
  tagIds: string[],
  guardRevision?: string,
): D1PreparedStatement[] {
  if (tagIds.length === 0) return [];
  return [guardRevision
    ? db.prepare(`
        INSERT INTO post_tags (post_id, tag_id, sort_order)
        SELECT ?, CAST(value AS TEXT), CAST(key AS INTEGER)
        FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM posts WHERE id = ? AND revision = ?
        )
      `).bind(postId, JSON.stringify(tagIds), postId, guardRevision)
    : db.prepare(`
        INSERT INTO post_tags (post_id, tag_id, sort_order)
        SELECT ?, CAST(value AS TEXT), CAST(key AS INTEGER)
        FROM json_each(?)
      `).bind(postId, JSON.stringify(tagIds))];
}

export async function createPost(input: {
  db: D1Database;
  authored: CreatePostRequest;
  authorScope?: PostAuthorScope;
  autosaveUserId?: string;
  bindAutosaveSnapshotSha256?: string;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<CreatePostResult> {
  try {
    if (
      input.bindAutosaveSnapshotSha256 !== undefined
      && (!input.autosaveUserId || !input.authored.autosave_draft_id)
    ) {
      throw new TypeError(
        'Binding an autosave requires its user and draft identifiers.',
      );
    }
    if (
      input.authorScope
      && input.authored.author_id !== input.authorScope.authorId
    ) return { kind: 'author_scope_changed' };
    const referenceFailure = await inspectReferences({
      db: input.db,
      authorId: input.authored.author_id,
      authorUserId: input.authorScope?.userId,
      categoryIds: input.authored.category_ids,
      tagIds: input.authored.tag_ids,
      mediaId: input.authored.featured_image_id,
    });
    if (referenceFailure) {
      return input.authorScope && referenceFailure === 'author_not_found'
        ? { kind: 'author_scope_changed' }
        : { kind: referenceFailure };
    }
    if (await readPostBySlug(input.db, input.authored.slug)) {
      return { kind: 'slug_conflict' };
    }
    const id = postIdSchema.parse((input.createId ?? createHexId)());
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const publicId = await allocateContentPublicId({
      db: input.db,
      contentType: 'post',
    });
    const nowIso = (input.now ?? new Date()).toISOString();
    const insertGuards: string[] = [];
    const insertGuardValues: unknown[] = [];
    if (input.authorScope) {
      insertGuards.push(`EXISTS (
        SELECT 1 FROM authors WHERE id = ? AND user_id = ?
      )`);
      insertGuardValues.push(
        input.authorScope.authorId,
        input.authorScope.userId,
      );
    }
    if (input.bindAutosaveSnapshotSha256 !== undefined) {
      insertGuards.push(`EXISTS (
        SELECT 1 FROM post_autosaves
        WHERE user_id = ? AND draft_id = ? AND post_id IS NULL
          AND snapshot_sha256 = ?
      )`);
      insertGuardValues.push(
        input.autosaveUserId!,
        input.authored.autosave_draft_id!,
        input.bindAutosaveSnapshotSha256,
      );
    }
    const insert = insertGuards.length > 0
      ? input.db.prepare(`
        INSERT INTO posts (
          id, public_id, title, slug, content, document_type,
          editor_mode, editor_profile, excerpt,
          status, author_id, discoverability, allow_comments,
          featured_image_id, published_at_iso, revision, created_at_iso,
          updated_at_iso
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${insertGuards.join(' AND ')}
      `)
      : input.db.prepare(`
        INSERT INTO posts (
          id, public_id, title, slug, content, document_type,
          editor_mode, editor_profile, excerpt,
          status, author_id, discoverability, allow_comments,
          featured_image_id, published_at_iso, revision, created_at_iso,
          updated_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const insertValues: unknown[] = [
        id,
        publicId,
        input.authored.title,
        input.authored.slug,
        input.authored.content,
        input.authored.document_type,
        input.authored.editor_mode,
        input.authored.editor_profile,
        input.authored.excerpt,
        input.authored.status,
        input.authored.author_id,
        input.authored.discoverability,
        input.authored.allow_comments ? 1 : 0,
        input.authored.featured_image_id,
        input.authored.status === 'published' ? nowIso : null,
        revision,
        nowIso,
        nowIso,
    ];
    insertValues.push(...insertGuardValues);
    const guardRelatedWrites = input.authorScope !== undefined
      || input.bindAutosaveSnapshotSha256 !== undefined;
    const results = await input.db.batch([
      insert.bind(...insertValues),
      ...categoryInsertStatements(
        input.db,
        id,
        input.authored.category_ids,
        guardRelatedWrites ? revision : undefined,
      ),
      ...tagInsertStatements(
        input.db,
        id,
        input.authored.tag_ids,
        guardRelatedWrites ? revision : undefined,
      ),
      ...prepareContentSearchReplaceStatements({
        db: input.db,
        targetType: 'post',
        document: {
          publicId,
          revision,
          title: input.authored.title,
          slug: input.authored.slug,
          excerpt: input.authored.excerpt,
          content: input.authored.content,
          documentType: input.authored.document_type,
        },
      }),
      ...(input.autosaveUserId && input.authored.autosave_draft_id
        ? [input.bindAutosaveSnapshotSha256 === undefined
          ? input.db.prepare(`
            DELETE FROM post_autosaves
            WHERE user_id = ? AND draft_id = ? AND post_id IS NULL
              ${input.authorScope ? `AND EXISTS (
                SELECT 1 FROM posts WHERE id = ? AND revision = ?
              )` : ''}
          `).bind(
            input.autosaveUserId,
            input.authored.autosave_draft_id,
            ...(input.authorScope ? [id, revision] : []),
          )
          : input.db.prepare(`
            UPDATE post_autosaves
            SET post_id = ?, base_revision = ?, expires_at_iso = NULL
            WHERE user_id = ? AND draft_id = ? AND post_id IS NULL
              AND snapshot_sha256 = ?
              AND EXISTS (
                SELECT 1 FROM posts WHERE id = ? AND revision = ?
              )
          `).bind(
            id,
            revision,
            input.autosaveUserId,
            input.authored.autosave_draft_id,
            input.bindAutosaveSnapshotSha256,
            id,
            revision,
          )]
        : []),
    ]);
    if (readChanges(results[0]) === 0) {
      if (input.authorScope) {
        const author = await input.db.prepare(
          'SELECT id FROM authors WHERE id = ? AND user_id = ? LIMIT 1',
        ).bind(
          input.authorScope.authorId,
          input.authorScope.userId,
        ).first<IdRow>();
        if (!author) return { kind: 'author_scope_changed' };
      }
      if (input.bindAutosaveSnapshotSha256 !== undefined) {
        return { kind: 'autosave_conflict' };
      }
      throw new TypeError('D1 ignored a valid Post insert.');
    }
    const post = await getPost({ db: input.db, id });
    if (!post) throw new TypeError('D1 did not return the created Post.');
    return { kind: 'completed', post };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSlugConstraint(error)) return { kind: 'slug_conflict' };
    if (isForeignKeyConstraint(error)) {
      try {
        const referenceFailure = await inspectReferences({
          db: input.db,
          authorId: input.authored.author_id,
          authorUserId: input.authorScope?.userId,
          categoryIds: input.authored.category_ids,
          tagIds: input.authored.tag_ids,
          mediaId: input.authored.featured_image_id,
        });
        if (referenceFailure) {
          return input.authorScope && referenceFailure === 'author_not_found'
            ? { kind: 'author_scope_changed' }
            : { kind: referenceFailure };
        }
      } catch {
        // Preserve the original failed write as the operator-facing cause.
      }
    }
    throw writeFailure(error, 'create_post');
  }
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function authoredMatchesPost(post: Post, authored: UpdatePostRequest): boolean {
  const categoryIds = post.categories.map((item) => item.id).sort();
  const tagIds = post.tags.map((item) => item.id);
  return post.title === authored.title
    && post.slug === authored.slug
    && post.content === authored.content
    && post.document_type === authored.document_type
    && post.editor_mode === authored.editor_mode
    && post.editor_profile === authored.editor_profile
    && post.excerpt === authored.excerpt
    && post.status === authored.status
    && post.author.id === authored.author_id
    && sameIds(categoryIds, authored.category_ids)
    && sameIds(tagIds, authored.tag_ids)
    && post.discoverability === authored.discoverability
    && post.allow_comments === authored.allow_comments
    && (post.featured_image?.id ?? null) === authored.featured_image_id;
}

export async function updatePost(input: {
  db: D1Database;
  id: string;
  authored: UpdatePostRequest;
  authorScope?: PostAuthorScope;
  autosaveUserId?: string;
  now?: Date;
  createRevision?: () => string;
  beforeStatusChange?: (current: Post, status: Post['status']) => void;
}): Promise<UpdatePostResult> {
  try {
    if (
      input.authorScope
      && input.authored.author_id !== input.authorScope.authorId
    ) return { kind: 'author_scope_changed' };
    const current = await getPost({
      db: input.db,
      id: input.id,
      authorId: input.authorScope?.authorId,
    });
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.authored.expected_revision) {
      return { kind: 'revision_conflict' };
    }
    if (
      current.document_type !== input.authored.document_type
      && (current.content !== '' || input.authored.content !== '')
    ) return { kind: 'document_type_change_forbidden' };
    const referenceFailure = await inspectReferences({
      db: input.db,
      authorId: input.authored.author_id,
      authorUserId: input.authorScope?.userId,
      categoryIds: input.authored.category_ids,
      tagIds: input.authored.tag_ids,
      mediaId: input.authored.featured_image_id,
    });
    if (referenceFailure) {
      return input.authorScope && referenceFailure === 'author_not_found'
        ? { kind: 'author_scope_changed' }
        : { kind: referenceFailure };
    }
    const slugOwner = await readPostBySlug(input.db, input.authored.slug);
    if (slugOwner && slugOwner.id !== input.id) {
      return { kind: 'slug_conflict' };
    }
    if (authoredMatchesPost(current, input.authored)) {
      if (input.autosaveUserId) {
        await input.db.prepare(`
          DELETE FROM post_autosaves WHERE user_id = ? AND post_id = ?
        `).bind(input.autosaveUserId, input.id).run();
      }
      return { kind: 'completed', post: current, previousStatus: current.status };
    }
    const archivedRevision = await preparePostRevision(current);
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Post revision must advance.');
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const publishedAt = input.authored.status === 'published'
      ? current.published_at_iso ?? nowIso
      : current.published_at_iso;
    if (current.status !== input.authored.status) input.beforeStatusChange?.(current, input.authored.status);
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE OR IGNORE posts
        SET title = ?, slug = ?, content = ?, document_type = ?,
            editor_mode = ?, editor_profile = ?, excerpt = ?, status = ?,
            author_id = ?, discoverability = ?,
            allow_comments = ?, featured_image_id = ?, published_at_iso = ?, revision = ?,
            updated_at_iso = ?
        WHERE id = ? AND revision = ?
          ${input.authorScope ? `
          AND posts.author_id = ?
          AND EXISTS (
            SELECT 1 FROM authors
            WHERE authors.id = posts.author_id AND authors.user_id = ?
          )` : ''}
          AND NOT EXISTS (
            SELECT 1 FROM post_revisions
            WHERE post_id = ? AND revision_id = ?
          )
      `).bind(
        input.authored.title,
        input.authored.slug,
        input.authored.content,
        input.authored.document_type,
        input.authored.editor_mode,
        input.authored.editor_profile,
        input.authored.excerpt,
        input.authored.status,
        input.authored.author_id,
        input.authored.discoverability,
        input.authored.allow_comments ? 1 : 0,
        input.authored.featured_image_id,
        publishedAt,
        revision,
        nowIso,
        input.id,
        input.authored.expected_revision,
        ...(input.authorScope
          ? [input.authorScope.authorId, input.authorScope.userId]
          : []),
        input.id,
        revision,
      ),
      ...archivePostRevisionStatements({
        db: input.db,
        postId: input.id,
        guardRevision: revision,
        archivedAtIso: nowIso,
        prepared: archivedRevision,
      }),
      input.db.prepare(`
        DELETE FROM post_categories
        WHERE post_id = ?
          AND EXISTS (
            SELECT 1 FROM posts WHERE id = ? AND revision = ?
          )
      `).bind(input.id, input.id, revision),
      ...categoryInsertStatements(
        input.db,
        input.id,
        input.authored.category_ids,
        revision,
      ),
      input.db.prepare(`
        DELETE FROM post_tags
        WHERE post_id = ?
          AND EXISTS (
            SELECT 1 FROM posts WHERE id = ? AND revision = ?
          )
      `).bind(input.id, input.id, revision),
      ...tagInsertStatements(
        input.db,
        input.id,
        input.authored.tag_ids,
        revision,
      ),
      ...prepareContentSearchReplaceStatements({
        db: input.db,
        targetType: 'post',
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
      ...(input.autosaveUserId
        ? [input.db.prepare(`
            DELETE FROM post_autosaves
            WHERE user_id = ? AND post_id = ?
              AND EXISTS (
                SELECT 1 FROM posts WHERE id = ? AND revision = ?
              )
          `).bind(input.autosaveUserId, input.id, input.id, revision)]
        : []),
    ]);
    if (readChanges(results[0]) === 0) {
      const latest = await getPost({ db: input.db, id: input.id });
      if (!latest) return { kind: 'not_found' };
      if (input.authorScope) {
        const authorReference = await inspectReferences({
          db: input.db,
          authorId: input.authorScope.authorId,
          authorUserId: input.authorScope.userId,
          categoryIds: [],
          tagIds: [],
          mediaId: null,
        });
        if (
          latest.author.id !== input.authorScope.authorId
          || authorReference === 'author_not_found'
        ) return { kind: 'author_scope_changed' };
      }
      if (latest.revision !== input.authored.expected_revision) {
        return { kind: 'revision_conflict' };
      }
      const latestSlugOwner = await readPostBySlug(
        input.db,
        input.authored.slug,
      );
      if (latestSlugOwner && latestSlugOwner.id !== input.id) {
        return { kind: 'slug_conflict' };
      }
      throw new TypeError('D1 ignored a valid Post update.');
    }
    const post = await getPost({ db: input.db, id: input.id });
    if (!post) throw new TypeError('D1 did not return the updated Post.');
    return { kind: 'completed', post, previousStatus: current.status };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (isSlugConstraint(error)) return { kind: 'slug_conflict' };
    if (isForeignKeyConstraint(error)) {
      try {
        const referenceFailure = await inspectReferences({
          db: input.db,
          authorId: input.authored.author_id,
          authorUserId: input.authorScope?.userId,
          categoryIds: input.authored.category_ids,
          tagIds: input.authored.tag_ids,
          mediaId: input.authored.featured_image_id,
        });
        if (referenceFailure) {
          return input.authorScope && referenceFailure === 'author_not_found'
            ? { kind: 'author_scope_changed' }
            : { kind: referenceFailure };
        }
      } catch {
        // Preserve the original failed write as the operator-facing cause.
      }
    }
    throw writeFailure(error, 'update_post');
  }
}

function postLifecycleAuthored(
  post: Post,
  targetStatus: PostBulkLifecycleRequest['target_status'],
  expectedRevision: string,
): UpdatePostRequest {
  return {
    title: post.title,
    slug: post.slug,
    content: post.content,
    document_type: post.document_type,
    editor_mode: post.editor_mode,
    editor_profile: post.editor_profile,
    excerpt: post.excerpt,
    status: targetStatus,
    author_id: post.author.id,
    category_ids: post.categories.map((category) => category.id).sort(),
    tag_ids: post.tags.map((tag) => tag.id),
    discoverability: post.discoverability,
    allow_comments: post.allow_comments,
    featured_image_id: post.featured_image?.id ?? null,
    expected_revision: expectedRevision,
  };
}

function summarizePostBulkLifecycle(
  results: PostBulkLifecycleData['results'],
): PostBulkLifecycleData['summary'] {
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

export async function updatePostBulkLifecycle(input: {
  db: D1Database;
  request: PostBulkLifecycleRequest;
  authorScope?: PostAuthorScope;
  now?: Date;
  createRevision?: () => string;
}): Promise<PostBulkLifecycleData> {
  const results: PostBulkLifecycleData['results'] = [];
  for (const item of input.request.items) {
    const current = await getPost({
      db: input.db,
      id: item.id,
      authorId: input.authorScope?.authorId,
    });
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
    const updated = await updatePost({
      db: input.db,
      id: item.id,
      authored: postLifecycleAuthored(
        current,
        input.request.target_status,
        item.expected_revision,
      ),
      authorScope: input.authorScope,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (updated.kind === 'completed') {
      results.push({
        id: item.id,
        outcome: 'updated',
        status: updated.post.status,
        revision: updated.post.revision,
      });
      continue;
    }
    if (updated.kind === 'not_found' || updated.kind === 'author_scope_changed') {
      results.push({
        id: item.id,
        outcome: 'skipped',
        reason: 'not_found',
      });
      continue;
    }
    if (updated.kind === 'revision_conflict') {
      const latest = await getPost({
        db: input.db,
        id: item.id,
        authorId: input.authorScope?.authorId,
      });
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
      `Post bulk lifecycle encountered unexpected result: ${updated.kind}`,
    );
  }
  return {
    target_status: input.request.target_status,
    results,
    summary: summarizePostBulkLifecycle(results),
  };
}

export async function deletePost(input: {
  db: D1Database;
  id: string;
  expectedRevision: string;
  authorScope?: PostAuthorScope;
}): Promise<DeletePostResult> {
  try {
    const identity = await input.db.prepare(`
      SELECT public_id, title
      FROM posts
      WHERE id = ?
        ${input.authorScope ? `
        AND posts.author_id = ?
        AND EXISTS (
          SELECT 1 FROM authors
          WHERE authors.id = posts.author_id AND authors.user_id = ?
        )` : ''}
      LIMIT 1
    `).bind(
      input.id,
      ...(input.authorScope
        ? [input.authorScope.authorId, input.authorScope.userId]
        : []),
    ).first<{ public_id?: unknown; title?: unknown }>();
    if (!identity) return { kind: 'not_found' };
    const publicId = Number(identity.public_id);
    if (!Number.isInteger(publicId) || publicId <= 0) {
      throw new StudioOperationalError('POST_MANAGEMENT_DATA_INVALID', {
        metadata: {
          resource: 'DB',
          action: 'delete_post',
        },
      });
    }
    const result = await input.db.prepare(`
      DELETE FROM posts
      WHERE id = ? AND revision = ? AND status = 'trash'
        ${input.authorScope ? `
        AND posts.author_id = ?
        AND EXISTS (
          SELECT 1 FROM authors
          WHERE authors.id = posts.author_id AND authors.user_id = ?
        )` : ''}
    `).bind(
      input.id,
      input.expectedRevision,
      ...(input.authorScope
        ? [input.authorScope.authorId, input.authorScope.userId]
        : []),
    ).run();
    if (readChanges(result) > 0) return { kind: 'completed', publicId, title: typeof identity.title === 'string' ? identity.title : undefined };
    const current = await getPost({
      db: input.db,
      id: input.id,
      authorId: input.authorScope?.authorId,
    });
    if (!current) return { kind: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    return { kind: 'not_in_trash' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_post');
  }
}

export async function listPreviewPosts(input: {
  db: D1Database;
}): Promise<Post[]> {
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        ${POST_SELECT}
        WHERE posts.status = 'published'
        ORDER BY COALESCE(posts.published_at_iso, posts.created_at_iso) DESC,
                 posts.public_id DESC, posts.id
      `),
      input.db.prepare(`
        SELECT post_categories.post_id, categories.id, categories.name,
               categories.slug
        FROM post_categories
        INNER JOIN posts ON posts.id = post_categories.post_id
        INNER JOIN categories ON categories.id = post_categories.category_id
        WHERE posts.status = 'published'
        ORDER BY post_categories.post_id, categories.name COLLATE NOCASE,
                 categories.name, categories.slug, categories.id
      `),
      input.db.prepare(`
        SELECT post_tags.post_id, tags.id, tags.name, tags.slug
        FROM post_tags
        INNER JOIN posts ON posts.id = post_tags.post_id
        INNER JOIN tags ON tags.id = post_tags.tag_id
        WHERE posts.status = 'published'
        ORDER BY post_tags.post_id, post_tags.sort_order, tags.slug, tags.id
      `),
    ]);
    const rows = results[0]?.results;
    const categoryRows = results[1]?.results;
    const tagRows = results[2]?.results;
    if (
      !Array.isArray(rows)
      || !Array.isArray(categoryRows)
      || !Array.isArray(tagRows)
    ) throw new TypeError('D1 returned invalid Preview Post rows.');

    const categoriesByPost = new Map<string, RelationRow[]>();
    const tagsByPost = new Map<string, RelationRow[]>();
    for (const row of categoryRows as RelationRow[]) {
      if (typeof row.post_id !== 'string') throw dataInvalid();
      const values = categoriesByPost.get(row.post_id) ?? [];
      values.push(row);
      categoriesByPost.set(row.post_id, values);
    }
    for (const row of tagRows as RelationRow[]) {
      if (typeof row.post_id !== 'string') throw dataInvalid();
      const values = tagsByPost.get(row.post_id) ?? [];
      values.push(row);
      tagsByPost.set(row.post_id, values);
    }
    const postIds = new Set((rows as PostRow[]).map((row) => row.id));
    for (const postId of [...categoriesByPost.keys(), ...tagsByPost.keys()]) {
      if (!postIds.has(postId)) throw dataInvalid();
    }
    return (rows as PostRow[]).map((row) => {
      if (typeof row.id !== 'string') throw dataInvalid();
      return parsePost(
        row,
        categoriesByPost.get(row.id) ?? [],
        tagsByPost.get(row.id) ?? [],
      );
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_posts');
  }
}
