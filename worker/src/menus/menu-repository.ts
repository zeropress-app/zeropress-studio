import type {
  PreviewMenuData,
  PreviewMenuItemData,
} from '@zeropress/preview-data-validator';
import {
  DEFAULT_MENU_IDS,
  MENU_MAX_COUNT,
  canonicalizeMenuItems,
  createDefaultMenuDraft,
  isDefaultMenuId,
  menuIdSchema,
  menuItemsSchema,
  menuReferenceKey,
  menuReferenceResolutionSchema,
  menuSchema,
  type Menu,
  type MenuItem,
  type MenuReferenceKind,
  type MenuReference,
  type MenuReferenceResolution,
} from '../../../contracts/menus';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import type { Page } from '../../../contracts/pages';
import type { Post } from '../../../contracts/posts';
import type { RoutingSettings } from '../../../contracts/routing-settings';
import type { PreviewTaxonomies } from '../taxonomies/taxonomy-repository';
import { readPagePaths } from '../pages/page-repository';
import { StudioOperationalError } from '../lib/operational-error';
import {
  resolveCategoryPublicRoute,
  resolvePageNavigationUrl,
  resolvePostPublicRoute,
  resolveTagPublicRoute,
} from '../routing/public-url-resolver';

type MenuRow = {
  menu_id: unknown;
  name: unknown;
  enabled: unknown;
  items: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
};

type CountRow = { row_count?: unknown };
type IdRow = { id?: unknown };

export type CreateMenuResult =
  | { kind: 'completed'; menu: Menu }
  | { kind: 'id_conflict' }
  | { kind: 'reference_not_found' }
  | { kind: 'limit_reached' };

export type SaveMenuResult =
  | { kind: 'completed'; menus: Menu[] }
  | { kind: 'id_conflict' }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'reference_not_found' }
  | { kind: 'limit_reached' };

export type DeleteMenuResult =
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'protected' };

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('MENU_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('MENU_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('MENU_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_menu_data' },
  });
}

function parseEnabled(value: unknown): unknown {
  if (value === 0) return false;
  if (value === 1) return true;
  return value;
}

function parseStoredItems(value: unknown): MenuItem[] {
  if (typeof value !== 'string') throw dataInvalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsed = menuItemsSchema.safeParse(decoded);
  if (!parsed.success) throw dataInvalid(parsed.error);
  const canonical = canonicalizeMenuItems(parsed.data);
  if (JSON.stringify(canonical) !== value) throw dataInvalid();
  return canonical;
}

function parseMenu(row: MenuRow): Menu {
  const parsed = menuSchema.safeParse({
    ...row,
    enabled: parseEnabled(row.enabled),
    items: parseStoredItems(row.items),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

async function readMenu(db: D1Database, menuId: string): Promise<Menu | null> {
  const row = await db.prepare(`
    SELECT menu_id, name, enabled, items, revision,
           created_at_iso, updated_at_iso
    FROM menus
    WHERE menu_id = ?
    LIMIT 1
  `).bind(menuId).first<MenuRow>();
  return row ? parseMenu(row) : null;
}

function collectReferences(items: MenuItem[]): Map<MenuReferenceKind, Set<string>> {
  const references = new Map<MenuReferenceKind, Set<string>>([
    ['post', new Set()],
    ['page', new Set()],
    ['category', new Set()],
    ['tag', new Set()],
  ]);
  const pending = [...items];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    if (item.link.kind !== 'custom') {
      references.get(item.link.kind)?.add(item.link.reference_id);
    }
    pending.push(...item.children);
  }
  return references;
}

const REFERENCE_QUERY_CHUNK_SIZE = 90;

async function referencesExist(
  db: D1Database,
  items: MenuItem[],
): Promise<boolean> {
  const references = collectReferences(items);
  const statements: Array<{
    expected: string[];
    statement: D1PreparedStatement;
  }> = [];
  const definitions = {
    post: { table: 'posts', filter: "status != 'trash'" },
    page: { table: 'pages', filter: "status != 'trash'" },
    category: { table: 'categories', filter: '1 = 1' },
    tag: { table: 'tags', filter: '1 = 1' },
  } as const;
  for (const [kind, ids] of references) {
    const values = [...ids];
    for (let offset = 0; offset < values.length; offset += REFERENCE_QUERY_CHUNK_SIZE) {
      const chunk = values.slice(offset, offset + REFERENCE_QUERY_CHUNK_SIZE);
      const definition = definitions[kind];
      statements.push({
        expected: chunk,
        statement: db.prepare(`
          SELECT id
          FROM ${definition.table}
          WHERE id IN (${chunk.map(() => '?').join(', ')})
            AND ${definition.filter}
        `).bind(...chunk),
      });
    }
  }
  if (statements.length === 0) return true;
  const results = await db.batch(statements.map(({ statement }) => statement));
  return results.every((result, index) => {
    const rows = result.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned invalid Menu reference rows.');
    }
    const found = new Set(rows.map((row) => (row as IdRow).id));
    return statements[index].expected.every((id) => found.has(id));
  });
}

export async function listMenus(input: { db: D1Database }): Promise<Menu[]> {
  try {
    const result = await input.db.prepare(`
      SELECT menu_id, name, enabled, items, revision,
             created_at_iso, updated_at_iso
      FROM menus
      ORDER BY menu_id
      LIMIT ${MENU_MAX_COUNT + 1}
    `).all<MenuRow>();
    if (!Array.isArray(result.results) || result.results.length > MENU_MAX_COUNT) {
      throw new TypeError('D1 returned an invalid Menu list.');
    }
    return result.results.map(parseMenu);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_menus');
  }
}

export async function createMenu(input: {
  db: D1Database;
  menuId: string;
  name: string;
  enabled: boolean;
  items: MenuItem[];
  now?: Date;
  createRevision?: () => string;
}): Promise<CreateMenuResult> {
  try {
    if (await readMenu(input.db, input.menuId)) return { kind: 'id_conflict' };
    const countRow = await input.db.prepare(
      'SELECT COUNT(*) AS row_count FROM menus',
    ).first<CountRow>();
    if (!Number.isInteger(countRow?.row_count) || (countRow?.row_count as number) < 0) {
      throw new TypeError('D1 returned an invalid Menu count.');
    }
    if ((countRow?.row_count as number) >= MENU_MAX_COUNT) {
      return { kind: 'limit_reached' };
    }
    const items = canonicalizeMenuItems(input.items);
    if (!await referencesExist(input.db, items)) {
      return { kind: 'reference_not_found' };
    }
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO menus (
        menu_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.menuId,
      input.name,
      input.enabled ? 1 : 0,
      JSON.stringify(items),
      revision,
      nowIso,
      nowIso,
    ).run();
    if (readChanges(result) === 0) {
      if (await readMenu(input.db, input.menuId)) return { kind: 'id_conflict' };
      throw new TypeError('D1 ignored a valid Menu insert.');
    }
    const menu = await readMenu(input.db, input.menuId);
    if (!menu) throw new TypeError('D1 did not return the created Menu.');
    return { kind: 'completed', menu };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'create_menu');
  }
}

export async function saveMenu(input: {
  db: D1Database;
  menuId: string;
  name: string;
  enabled: boolean;
  items: MenuItem[];
  expectedRevision: string | null;
  now?: Date;
  createRevision?: () => string;
}): Promise<SaveMenuResult> {
  try {
    const current = await readMenu(input.db, input.menuId);
    if (input.expectedRevision === null) {
      if (!isDefaultMenuId(input.menuId)) return { kind: 'not_found' };
      if (current) return { kind: 'id_conflict' };
    } else if (!current) {
      return { kind: 'not_found' };
    } else if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const items = canonicalizeMenuItems(input.items);
    if (!await referencesExist(input.db, items)) {
      return { kind: 'reference_not_found' };
    }
    const itemsJson = JSON.stringify(items);
    const unchanged = current !== null
      && current.name === input.name
      && current.enabled === input.enabled
      && JSON.stringify(current.items) === itemsJson;
    const nextRevision = () => settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const revision = unchanged ? current.revision : nextRevision();
    if (!unchanged && revision === current?.revision) {
      throw new TypeError('Menu revision must advance.');
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const candidates = [{
      menu_id: input.menuId,
      name: input.name,
      enabled: input.enabled,
      items,
      revision,
      created_at_iso: current?.created_at_iso ?? nowIso,
      updated_at_iso: unchanged ? current.updated_at_iso : nowIso,
    }, ...DEFAULT_MENU_IDS.filter((id) => id !== input.menuId).map((id) => ({
      ...createDefaultMenuDraft(id),
      revision: nextRevision(),
      created_at_iso: nowIso,
      updated_at_iso: nowIso,
    }))];

    // One statement commits the edited menu and every missing default together.
    // Materialize the CAS/count gate before writing any row: re-evaluating an
    // "absent" expectation after the first insert could leave only half the pair.
    // Existing counterpart defaults never enter the UPSERT, preserving their
    // authored content, enabled state, revision, and timestamps.
    const expectation = input.expectedRevision === null
      ? 'NOT EXISTS (SELECT 1 FROM menus WHERE menu_id = ?)'
      : 'EXISTS (SELECT 1 FROM menus WHERE menu_id = ? AND revision = ?)';
    const result = await input.db.prepare(`
      WITH candidates (
        menu_id, name, enabled, items, revision, created_at_iso, updated_at_iso
      ) AS (VALUES ${candidates.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}),
      write_guard AS MATERIALIZED (
        SELECT 1
        WHERE ${expectation}
          AND (SELECT COUNT(*) FROM menus) + (
            SELECT COUNT(*) FROM candidates AS candidate
            WHERE NOT EXISTS (
              SELECT 1 FROM menus WHERE menu_id = candidate.menu_id
            )
          ) <= ${MENU_MAX_COUNT}
      )
      INSERT INTO menus (
        menu_id, name, enabled, items, revision, created_at_iso, updated_at_iso
      )
      SELECT candidate.* FROM candidates AS candidate CROSS JOIN write_guard
      WHERE candidate.menu_id = ? OR NOT EXISTS (
        SELECT 1 FROM menus WHERE menu_id = candidate.menu_id
      )
      ON CONFLICT(menu_id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        items = excluded.items,
        revision = excluded.revision,
        updated_at_iso = excluded.updated_at_iso
    `).bind(
      ...candidates.flatMap((menu) => [
        menu.menu_id, menu.name, menu.enabled ? 1 : 0,
        JSON.stringify(menu.items), menu.revision,
        menu.created_at_iso, menu.updated_at_iso,
      ]),
      input.menuId,
      ...(input.expectedRevision === null ? [] : [input.expectedRevision]),
      input.menuId,
    ).run();
    if (readChanges(result) === 0) {
      const latest = await readMenu(input.db, input.menuId);
      if (input.expectedRevision === null && latest) return { kind: 'id_conflict' };
      if (input.expectedRevision !== null) {
        if (!latest) return { kind: 'not_found' };
        if (latest.revision !== input.expectedRevision) return { kind: 'revision_conflict' };
      }
      return { kind: 'limit_reached' };
    }
    const saved = await input.db.prepare(`
      SELECT menu_id, name, enabled, items, revision,
             created_at_iso, updated_at_iso
      FROM menus WHERE menu_id IN (${candidates.map(() => '?').join(', ')})
      ORDER BY menu_id
    `).bind(...candidates.map((menu) => menu.menu_id)).all<MenuRow>();
    if (!Array.isArray(saved.results) || saved.results.length !== candidates.length) {
      throw new TypeError('D1 did not return the saved Menu and both defaults.');
    }
    return { kind: 'completed', menus: saved.results.map(parseMenu) };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'save_menu');
  }
}

export async function deleteMenu(input: {
  db: D1Database;
  menuId: string;
  expectedRevision: string;
}): Promise<DeleteMenuResult> {
  try {
    const current = await readMenu(input.db, input.menuId);
    if (!current) return { kind: 'not_found' };
    if (isDefaultMenuId(current.menu_id)) {
      return { kind: 'protected' };
    }
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const result = await input.db.prepare(
      'DELETE FROM menus WHERE menu_id = ? AND revision = ?',
    ).bind(input.menuId, input.expectedRevision).run();
    if (readChanges(result) === 0) {
      return await readMenu(input.db, input.menuId)
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    return { kind: 'completed' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_menu');
  }
}

// A search page cannot establish existence. Resolve the selected IDs
// separately; absence from a search result is never evidence of a missing row.
export async function resolveMenuReferences(input: {
  db: D1Database;
  references: MenuReference[];
}): Promise<MenuReferenceResolution[]> {
  const definitions = {
    post: { table: 'posts', title: 'title', status: 'status' },
    page: { table: 'pages', title: 'title', status: 'status' },
    category: { table: 'categories', title: 'name', status: "'available'" },
    tag: { table: 'tags', title: 'name', status: "'available'" },
  } as const;
  type ReferenceRow = { id: string; title: string; detail: string; status: string };
  try {
    const resolutions = new Map<string, MenuReferenceResolution>();
    for (const kind of Object.keys(definitions) as MenuReferenceKind[]) {
      const references = input.references.filter((reference) => reference.kind === kind);
      const definition = definitions[kind];
      for (let offset = 0; offset < references.length; offset += REFERENCE_QUERY_CHUNK_SIZE) {
        const chunk = references.slice(offset, offset + REFERENCE_QUERY_CHUNK_SIZE);
        const result = await input.db.prepare(`
          SELECT id, ${definition.title} AS title, slug AS detail,
                 ${definition.status} AS status
          FROM ${definition.table}
          WHERE id IN (${chunk.map(() => '?').join(', ')})
        `).bind(...chunk.map((reference) => reference.reference_id)).all<ReferenceRow>();
        if (!result.success || !Array.isArray(result.results)) {
          throw new TypeError('D1 returned invalid Menu reference results.');
        }
        const rows = new Map<string, ReferenceRow>();
        const requestedIds = new Set(chunk.map((reference) => reference.reference_id));
        for (const row of result.results) {
          if (!requestedIds.has(row.id) || rows.has(row.id)
            || ((kind === 'post' || kind === 'page')
              && !['draft', 'published', 'trash'].includes(row.status))) {
            throw dataInvalid();
          }
          rows.set(row.id, row);
        }
        const pagePaths = kind === 'page'
          ? await readPagePaths(input.db, result.results
            .filter((row) => row.status !== 'trash').map((row) => row.id))
          : new Map<string, string>();
        for (const reference of chunk) {
          const row = rows.get(reference.reference_id);
          if (kind === 'page' && row && row.status !== 'trash' && !pagePaths.has(row.id)) {
            throw dataInvalid();
          }
          const resolution = !row
            ? { ...reference, status: 'missing' }
            : row.status === 'trash'
              ? { ...reference, status: 'trash' }
              : {
                ...reference,
                status: 'available',
                title: row.title,
                detail: kind === 'page' ? `/${pagePaths.get(row.id)}/` : row.detail,
              };
          const parsed = menuReferenceResolutionSchema.safeParse(resolution);
          if (!parsed.success) throw dataInvalid(parsed.error);
          resolutions.set(menuReferenceKey(reference), parsed.data);
        }
      }
    }
    return input.references.map((reference) => {
      const resolution = resolutions.get(menuReferenceKey(reference));
      if (!resolution) throw dataInvalid();
      return resolution;
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'resolve_menu_references');
  }
}

export async function listPreviewMenus(input: {
  db: D1Database;
}): Promise<Menu[]> {
  try {
    const result = await input.db.prepare(`
      SELECT menu_id, name, enabled, items, revision,
             created_at_iso, updated_at_iso
      FROM menus
      WHERE enabled = 1
      ORDER BY menu_id
      LIMIT ${MENU_MAX_COUNT + 1}
    `).all<MenuRow>();
    if (!Array.isArray(result.results) || result.results.length > MENU_MAX_COUNT) {
      throw new TypeError('D1 returned an invalid Preview Menu list.');
    }
    return result.results.map(parseMenu);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_menus');
  }
}

type ResolvedMenuReference = { url: string };

export function resolvePreviewMenus(input: {
  menus: Menu[];
  posts: Post[];
  pages: Page[];
  taxonomies: PreviewTaxonomies;
  routing: RoutingSettings;
  timezone: string;
}): Record<string, PreviewMenuData> {
  const posts = new Map(input.posts
    .filter((post) => post.status !== 'trash')
    .map((post) => [post.id, {
      url: resolvePostPublicRoute({
        settings: input.routing,
        timezone: input.timezone,
        post,
      }).url,
    }]));
  const pages = new Map(input.pages
    .filter((page) => page.status !== 'trash')
    .map((page) => [page.id, {
      url: resolvePageNavigationUrl({
        settings: input.routing,
        page,
      }),
    }]));
  const categories = new Map(input.taxonomies.categories.map((term) => [
    term.id,
    { url: resolveCategoryPublicRoute({
      settings: input.routing,
      category: term,
    }).url },
  ]));
  const tags = new Map(input.taxonomies.tags.map((term) => [
    term.id,
    { url: resolveTagPublicRoute({
      settings: input.routing,
      tag: term,
    }).url },
  ]));

  function resolveReference(item: MenuItem): ResolvedMenuReference | null {
    if (item.link.kind === 'custom') return { url: item.link.url };
    const references = item.link.kind === 'post'
      ? posts
      : item.link.kind === 'page'
        ? pages
        : item.link.kind === 'category'
          ? categories
          : tags;
    return references.get(item.link.reference_id) ?? null;
  }

  function resolveItems(items: MenuItem[]): PreviewMenuItemData[] {
    const resolved: PreviewMenuItemData[] = [];
    for (const item of items) {
      const children = resolveItems(item.children);
      const reference = resolveReference(item);
      if (!reference) {
        resolved.push(...children);
        continue;
      }
      resolved.push({
        title: item.title,
        url: reference.url,
        target: item.target,
        ...(item.meta ? { meta: item.meta } : {}),
        children,
      });
    }
    return resolved;
  }

  return Object.fromEntries(
    input.menus
      .filter((menu) => menu.enabled)
      .sort((left, right) => (
        left.menu_id < right.menu_id ? -1 : left.menu_id > right.menu_id ? 1 : 0
      ))
      .map((menu) => [
        menuIdSchema.parse(menu.menu_id),
        { name: menu.name, items: resolveItems(menu.items) },
      ]),
  );
}
