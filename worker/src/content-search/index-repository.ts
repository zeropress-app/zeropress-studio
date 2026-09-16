import {
  CONTENT_SEARCH_CONTEXT_MAX_LENGTH,
  CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS,
  contentSearchMatchSchema,
  type ContentSearchMatch,
  type ContentSearchPlan,
} from '../../../contracts/content-search';
import {
  computeDocumentSearchText,
  type PreviewDocumentType,
} from '../../../contracts/document-excerpt';
import { StudioOperationalError } from '../lib/operational-error';

export const CONTENT_SEARCH_REBUILD_BATCH_SIZE = 5;

export type ContentSearchTargetType = 'post' | 'page';

export type SearchIndexDocument = {
  publicId: number;
  revision: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  documentType: PreviewDocumentType;
};

export type ContentSearchIndexState = {
  state: 'ready' | 'rebuild_required' | 'in_progress' | 'recovery_required';
  reason: 'schema_upgrade' | 'database_restore' | 'manual_rebuild'
    | 'integrity_failure' | null;
  phase: 'posts' | 'pages' | 'verify' | null;
  operationId: string | null;
  postPublicIdCursor: number;
  pagePublicIdCursor: number;
  processedPosts: number;
  processedPages: number;
  totalPosts: number;
  totalPages: number;
  startedAtIso: string | null;
  updatedAtIso: string;
};

type IndexStateRow = {
  state?: unknown;
  reason?: unknown;
  phase?: unknown;
  operation_id?: unknown;
  post_public_id_cursor?: unknown;
  page_public_id_cursor?: unknown;
  processed_posts?: unknown;
  processed_pages?: unknown;
  total_posts?: unknown;
  total_pages?: unknown;
  started_at_iso?: unknown;
  updated_at_iso?: unknown;
};

export class ContentSearchIndexNotReadyError extends Error {
  readonly state: ContentSearchIndexState['state'];

  constructor(state: ContentSearchIndexState['state']) {
    super('Content search index is not ready.');
    this.name = 'ContentSearchIndexNotReadyError';
    this.state = state;
  }
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned invalid content-search index progress.');
  }
  return value as number;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError('D1 returned invalid content-search index state.');
  }
  return value;
}

function parseIndexState(row: IndexStateRow | null): ContentSearchIndexState {
  if (!row) throw new TypeError('Content-search index state is missing.');
  if (
    row.state !== 'ready'
    && row.state !== 'rebuild_required'
    && row.state !== 'in_progress'
    && row.state !== 'recovery_required'
  ) throw new TypeError('Content-search index state is invalid.');
  const reason = nullableString(row.reason);
  if (
    reason !== null
    && reason !== 'schema_upgrade'
    && reason !== 'database_restore'
    && reason !== 'manual_rebuild'
    && reason !== 'integrity_failure'
  ) throw new TypeError('Content-search index reason is invalid.');
  const phase = nullableString(row.phase);
  if (
    phase !== null
    && phase !== 'posts'
    && phase !== 'pages'
    && phase !== 'verify'
  ) throw new TypeError('Content-search index phase is invalid.');
  return {
    state: row.state,
    reason,
    phase,
    operationId: nullableString(row.operation_id),
    postPublicIdCursor: integer(row.post_public_id_cursor),
    pagePublicIdCursor: integer(row.page_public_id_cursor),
    processedPosts: integer(row.processed_posts),
    processedPages: integer(row.processed_pages),
    totalPosts: integer(row.total_posts),
    totalPages: integer(row.total_pages),
    startedAtIso: nullableString(row.started_at_iso),
    updatedAtIso: nullableString(row.updated_at_iso) ?? (() => {
      throw new TypeError('Content-search index update time is missing.');
    })(),
  };
}

export async function readContentSearchIndexState(
  db: D1Database,
): Promise<ContentSearchIndexState> {
  try {
    const row = await db.prepare(`
      SELECT state, reason, phase, operation_id,
             post_public_id_cursor, page_public_id_cursor,
             processed_posts, processed_pages, total_posts, total_pages,
             started_at_iso, updated_at_iso
      FROM content_search_index_state
      WHERE id = 1
      LIMIT 1
    `).first<IndexStateRow>();
    return parseIndexState(row);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_content_search_index_state',
        },
      },
    );
  }
}

export async function assertContentSearchIndexReady(
  db: D1Database,
): Promise<void> {
  const state = await readContentSearchIndexState(db);
  if (state.state !== 'ready') {
    throw new ContentSearchIndexNotReadyError(state.state);
  }
}

function tableNames(targetType: ContentSearchTargetType) {
  return targetType === 'post'
    ? { canonical: 'posts', fts: 'post_search_fts' }
    : { canonical: 'pages', fts: 'page_search_fts' };
}

export function prepareContentSearchReplaceStatements(input: {
  db: D1Database;
  targetType: ContentSearchTargetType;
  document: SearchIndexDocument;
}): D1PreparedStatement[] {
  const names = tableNames(input.targetType);
  const body = computeDocumentSearchText({
    content: input.document.content,
    documentType: input.document.documentType,
  });
  return [
    input.db.prepare(`
      DELETE FROM ${names.fts}
      WHERE rowid = ?
        AND EXISTS (
          SELECT 1 FROM ${names.canonical}
          WHERE public_id = ? AND revision = ?
        )
    `).bind(
      input.document.publicId,
      input.document.publicId,
      input.document.revision,
    ),
    input.db.prepare(`
      INSERT INTO ${names.fts} (
        rowid, revision, title, slug, excerpt, body
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ${names.canonical}
        WHERE public_id = ? AND revision = ?
      )
    `).bind(
      input.document.publicId,
      input.document.revision,
      input.document.title,
      input.document.slug,
      input.document.excerpt,
      body,
      input.document.publicId,
      input.document.revision,
    ),
  ];
}

export function contentSearchCte(plan: ContentSearchPlan): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `WITH short_search_terms(value) AS (
      SELECT CAST(value AS TEXT)
      FROM json_each(?)
    )`,
    params: [JSON.stringify(plan.shortTokens)],
  };
}

export function contentSearchPredicate(input: {
  plan: ContentSearchPlan;
  ftsTable: 'post_search_fts' | 'page_search_fts';
  ftsAlias?: string;
}): { sql: string; params: unknown[] } {
  const alias = input.ftsAlias ?? input.ftsTable;
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (input.plan.matchExpression !== null) {
    predicates.push(`${input.ftsTable} MATCH ?`);
    params.push(input.plan.matchExpression);
  }
  predicates.push(`NOT EXISTS (
    SELECT 1
    FROM short_search_terms
    WHERE instr(lower(${alias}.title), lower(short_search_terms.value)) = 0
      AND instr(lower(${alias}.slug), lower(short_search_terms.value)) = 0
      AND instr(lower(${alias}.excerpt), lower(short_search_terms.value)) = 0
      AND instr(lower(${alias}.body), lower(short_search_terms.value)) = 0
  )`);
  return { sql: predicates.join(' AND '), params };
}

export function contentSearchOrderExpression(input: {
  plan: ContentSearchPlan;
  ftsTable: 'post_search_fts' | 'page_search_fts';
  ftsAlias?: string;
}): string {
  if (input.plan.matchExpression !== null) {
    return `bm25(${input.ftsTable}, 0.0, 8.0, 5.0, 3.0, 1.0) ASC`;
  }
  const alias = input.ftsAlias ?? input.ftsTable;
  return `(
    SELECT COALESCE(SUM(
      CASE WHEN instr(lower(${alias}.title), lower(value)) > 0 THEN 8 ELSE 0 END
      + CASE WHEN instr(lower(${alias}.slug), lower(value)) > 0 THEN 5 ELSE 0 END
      + CASE WHEN instr(lower(${alias}.excerpt), lower(value)) > 0 THEN 3 ELSE 0 END
      + CASE WHEN instr(lower(${alias}.body), lower(value)) > 0 THEN 1 ELSE 0 END
    ), 0)
    FROM short_search_terms
  ) DESC`;
}

function safeSliceStart(value: string, start: number): number {
  if (
    start > 0
    && value.charCodeAt(start) >= 0xdc00
    && value.charCodeAt(start) <= 0xdfff
  ) return start - 1;
  return start;
}

function safeSliceEnd(value: string, end: number): number {
  if (
    end < value.length
    && end > 0
    && value.charCodeAt(end - 1) >= 0xd800
    && value.charCodeAt(end - 1) <= 0xdbff
  ) return end - 1;
  return end;
}

function foldSearchValue(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
}

function foldTextWithOffsets(value: string): {
  folded: string;
  starts: number[];
  ends: number[];
} {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;
  for (const character of value) {
    const sourceEnd = sourceOffset + character.length;
    const next = foldSearchValue(character);
    folded += next;
    for (let index = 0; index < next.length; index += 1) {
      starts.push(sourceOffset);
      ends.push(sourceEnd);
    }
    sourceOffset = sourceEnd;
  }
  return { folded, starts, ends };
}

function matchingRanges(text: string, tokens: string[]) {
  const indexed = foldTextWithOffsets(text);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    const needle = foldSearchValue(token);
    if (!needle) continue;
    let cursor = 0;
    while (cursor <= indexed.folded.length - needle.length) {
      const foldedStart = indexed.folded.indexOf(needle, cursor);
      if (foldedStart < 0) break;
      const foldedEnd = foldedStart + needle.length;
      const start = indexed.starts[foldedStart];
      const end = indexed.ends[foldedEnd - 1];
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end });
      }
      if (ranges.length >= CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS * 4) break;
      cursor = foldedStart + Math.max(1, needle.length);
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
    if (merged.length >= CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS) break;
  }
  return merged;
}

function contextForText(
  field: ContentSearchMatch['field'],
  source: string,
  tokens: string[],
): ContentSearchMatch | null {
  const sourceRanges = matchingRanges(source, tokens);
  if (sourceRanges.length === 0) return null;
  const anchor = sourceRanges[0]!.start;
  let start = safeSliceStart(source, Math.max(0, anchor - 80));
  let end = safeSliceEnd(
    source,
    Math.min(source.length, start + CONTENT_SEARCH_CONTEXT_MAX_LENGTH),
  );
  if (end - start < CONTENT_SEARCH_CONTEXT_MAX_LENGTH && start > 0) {
    start = safeSliceStart(
      source,
      Math.max(0, end - CONTENT_SEARCH_CONTEXT_MAX_LENGTH),
    );
  }
  const text = source.slice(start, end);
  const highlights = sourceRanges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({
      start: Math.max(range.start, start) - start,
      end: Math.min(range.end, end) - start,
    }))
    .filter((range) => range.start < range.end)
    .slice(0, CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS);
  return contentSearchMatchSchema.parse({ field, text, highlights });
}

export function buildContentSearchMatch(input: {
  excerpt: string;
  body: string;
  plan: ContentSearchPlan;
}): ContentSearchMatch | null {
  const tokens = input.plan.tokens.map((token) => token.value);
  return contextForText('excerpt', input.excerpt, tokens)
    ?? contextForText('content', input.body, tokens);
}
