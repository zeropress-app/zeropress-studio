import type {
  PreviewWidgetAreaData,
  PreviewWidgetItemData,
} from '@zeropress/preview-data-validator';
import {
  SIDEBAR_WIDGET_AREA_ID,
  WIDGET_AREA_MAX_COUNT,
  canonicalizeWidgetItems,
  widgetAreaSchema,
  widgetAuthorOptionSchema,
  widgetItemsSchema,
  type WidgetArea,
  type WidgetAuthorOption,
  type WidgetItem,
} from '../../../contracts/widgets';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';

type WidgetAreaRow = {
  widget_area_id: unknown;
  name: unknown;
  enabled: unknown;
  items: unknown;
  revision: unknown;
  created_at_iso: unknown;
  updated_at_iso: unknown;
};

type CountRow = { row_count?: unknown };
type AuthorRow = { id?: unknown; display_name?: unknown };

export type CreateWidgetAreaResult =
  | { kind: 'completed'; widgetArea: WidgetArea }
  | { kind: 'id_conflict' }
  | { kind: 'limit_reached' };

export type SaveWidgetAreaResult =
  | { kind: 'completed'; widgetArea: WidgetArea }
  | { kind: 'not_found' }
  | { kind: 'id_conflict' }
  | { kind: 'revision_conflict' }
  | { kind: 'author_not_found' }
  | { kind: 'limit_reached' };

export type DeleteWidgetAreaResult =
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
  return new StudioOperationalError('WIDGET_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('WIDGET_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('WIDGET_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_widget_data' },
  });
}

function parseEnabled(value: unknown): unknown {
  if (value === 0) return false;
  if (value === 1) return true;
  return value;
}

function parseStoredItems(value: unknown): WidgetItem[] {
  if (typeof value !== 'string') throw dataInvalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsed = widgetItemsSchema.safeParse(decoded);
  if (!parsed.success) throw dataInvalid(parsed.error);
  const canonical = canonicalizeWidgetItems(parsed.data);
  if (JSON.stringify(canonical) !== value) throw dataInvalid();
  return canonical;
}

function parseWidgetArea(row: WidgetAreaRow): WidgetArea {
  const parsed = widgetAreaSchema.safeParse({
    ...row,
    enabled: parseEnabled(row.enabled),
    items: parseStoredItems(row.items),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

async function readWidgetArea(
  db: D1Database,
  widgetAreaId: string,
): Promise<WidgetArea | null> {
  const row = await db.prepare(`
    SELECT widget_area_id, name, enabled, items, revision,
           created_at_iso, updated_at_iso
    FROM widget_areas
    WHERE widget_area_id = ?
    LIMIT 1
  `).bind(widgetAreaId).first<WidgetAreaRow>();
  return row ? parseWidgetArea(row) : null;
}

function collectProfileAuthorIds(items: WidgetItem[]): string[] {
  return [...new Set(items
    .filter((item) => item.type === 'profile')
    .map((item) => item.settings.author_id))];
}

const AUTHOR_QUERY_CHUNK_SIZE = 90;

async function readProfileAuthors(
  db: D1Database,
  authorIds: string[],
): Promise<Map<string, WidgetAuthorOption>> {
  if (authorIds.length === 0) return new Map();
  const chunks: string[][] = [];
  for (let offset = 0; offset < authorIds.length; offset += AUTHOR_QUERY_CHUNK_SIZE) {
    chunks.push(authorIds.slice(offset, offset + AUTHOR_QUERY_CHUNK_SIZE));
  }
  const results = await db.batch(chunks.map((chunk) => db.prepare(`
    SELECT id, display_name
    FROM authors
    WHERE id IN (${chunk.map(() => '?').join(', ')})
  `).bind(...chunk)));
  const authors = new Map<string, WidgetAuthorOption>();
  for (const result of results) {
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Widget author rows.');
    }
    for (const row of result.results as AuthorRow[]) {
      const parsed = widgetAuthorOptionSchema.safeParse(row);
      if (!parsed.success) throw dataInvalid(parsed.error);
      authors.set(parsed.data.id, parsed.data);
    }
  }
  return authors;
}

async function profileAuthorsExist(
  db: D1Database,
  items: WidgetItem[],
): Promise<boolean> {
  const ids = collectProfileAuthorIds(items);
  const authors = await readProfileAuthors(db, ids);
  return ids.every((id) => authors.has(id));
}

export async function listWidgetAreas(input: {
  db: D1Database;
}): Promise<WidgetArea[]> {
  try {
    const result = await input.db.prepare(`
      SELECT widget_area_id, name, enabled, items, revision,
             created_at_iso, updated_at_iso
      FROM widget_areas
      ORDER BY widget_area_id
      LIMIT ${WIDGET_AREA_MAX_COUNT + 1}
    `).all<WidgetAreaRow>();
    if (
      !Array.isArray(result.results)
      || result.results.length > WIDGET_AREA_MAX_COUNT
    ) {
      throw new TypeError('D1 returned an invalid Widget area list.');
    }
    return result.results.map(parseWidgetArea);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_widget_areas');
  }
}

export async function createWidgetArea(input: {
  db: D1Database;
  widgetAreaId: string;
  name: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<CreateWidgetAreaResult> {
  try {
    if (await readWidgetArea(input.db, input.widgetAreaId)) {
      return { kind: 'id_conflict' };
    }
    const countRow = await input.db.prepare(
      'SELECT COUNT(*) AS row_count FROM widget_areas',
    ).first<CountRow>();
    if (
      !Number.isInteger(countRow?.row_count)
      || (countRow?.row_count as number) < 0
    ) throw new TypeError('D1 returned an invalid Widget area count.');
    if ((countRow?.row_count as number) >= WIDGET_AREA_MAX_COUNT) {
      return { kind: 'limit_reached' };
    }
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const result = await input.db.prepare(`
      INSERT OR IGNORE INTO widget_areas (
        widget_area_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, ?, 1, '[]', ?, ?, ?)
    `).bind(
      input.widgetAreaId,
      input.name,
      revision,
      nowIso,
      nowIso,
    ).run();
    if (readChanges(result) === 0) {
      if (await readWidgetArea(input.db, input.widgetAreaId)) {
        return { kind: 'id_conflict' };
      }
      throw new TypeError('D1 ignored a valid Widget area insert.');
    }
    const widgetArea = await readWidgetArea(input.db, input.widgetAreaId);
    if (!widgetArea) {
      throw new TypeError('D1 did not return the created Widget area.');
    }
    return { kind: 'completed', widgetArea };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'create_widget_area');
  }
}

export async function saveWidgetArea(input: {
  db: D1Database;
  widgetAreaId: string;
  name: string;
  enabled: boolean;
  items: WidgetItem[];
  expectedRevision: string | null;
  now?: Date;
  createRevision?: () => string;
}): Promise<SaveWidgetAreaResult> {
  try {
    const current = await readWidgetArea(input.db, input.widgetAreaId);
    if (input.expectedRevision === null) {
      if (input.widgetAreaId !== SIDEBAR_WIDGET_AREA_ID) {
        return { kind: 'not_found' };
      }
      if (current) return { kind: 'id_conflict' };
    } else if (!current) {
      return { kind: 'not_found' };
    } else if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const items = canonicalizeWidgetItems(input.items);
    if (!await profileAuthorsExist(input.db, items)) {
      return { kind: 'author_not_found' };
    }
    const itemsJson = JSON.stringify(items);
    const nowIso = (input.now ?? new Date()).toISOString();
    if (input.expectedRevision === null) {
      const revision = settingsRevisionSchema.parse(
        (input.createRevision ?? createHexId)(),
      );
      const result = await input.db.prepare(`
        INSERT OR IGNORE INTO widget_areas (
          widget_area_id, name, enabled, items, revision,
          created_at_iso, updated_at_iso
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM widget_areas) < ?
      `).bind(
        input.widgetAreaId,
        input.name,
        input.enabled ? 1 : 0,
        itemsJson,
        revision,
        nowIso,
        nowIso,
        WIDGET_AREA_MAX_COUNT,
      ).run();
      if (readChanges(result) === 0) {
        if (await readWidgetArea(input.db, input.widgetAreaId)) {
          return { kind: 'id_conflict' };
        }
        const countRow = await input.db.prepare(
          'SELECT COUNT(*) AS row_count FROM widget_areas',
        ).first<CountRow>();
        if (
          !Number.isInteger(countRow?.row_count)
          || (countRow?.row_count as number) < 0
        ) throw new TypeError('D1 returned an invalid Widget area count.');
        if ((countRow?.row_count as number) >= WIDGET_AREA_MAX_COUNT) {
          return { kind: 'limit_reached' };
        }
        throw new TypeError('D1 ignored a valid default Widget area insert.');
      }
      const widgetArea = await readWidgetArea(input.db, input.widgetAreaId);
      if (!widgetArea) {
        throw new TypeError('D1 did not return the saved Widget area.');
      }
      return { kind: 'completed', widgetArea };
    }
    if (!current) return { kind: 'not_found' };
    if (
      current.name === input.name
      && current.enabled === input.enabled
      && JSON.stringify(current.items) === itemsJson
    ) return { kind: 'completed', widgetArea: current };
    const revision = settingsRevisionSchema.parse(
      (input.createRevision ?? createHexId)(),
    );
    if (revision === current.revision) {
      throw new TypeError('Widget area revision must advance.');
    }
    const result = await input.db.prepare(`
      UPDATE widget_areas
      SET name = ?, enabled = ?, items = ?, revision = ?, updated_at_iso = ?
      WHERE widget_area_id = ? AND revision = ?
    `).bind(
      input.name,
      input.enabled ? 1 : 0,
      itemsJson,
      revision,
      nowIso,
      input.widgetAreaId,
      input.expectedRevision,
    ).run();
    if (readChanges(result) === 0) {
      return await readWidgetArea(input.db, input.widgetAreaId)
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    const widgetArea = await readWidgetArea(input.db, input.widgetAreaId);
    if (!widgetArea) {
      throw new TypeError('D1 did not return the updated Widget area.');
    }
    return { kind: 'completed', widgetArea };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'save_widget_area');
  }
}

export async function deleteWidgetArea(input: {
  db: D1Database;
  widgetAreaId: string;
  expectedRevision: string;
}): Promise<DeleteWidgetAreaResult> {
  try {
    const current = await readWidgetArea(input.db, input.widgetAreaId);
    if (!current) return { kind: 'not_found' };
    if (current.widget_area_id === SIDEBAR_WIDGET_AREA_ID) {
      return { kind: 'protected' };
    }
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    const result = await input.db.prepare(`
      DELETE FROM widget_areas
      WHERE widget_area_id = ? AND revision = ?
    `).bind(input.widgetAreaId, input.expectedRevision).run();
    if (readChanges(result) === 0) {
      return await readWidgetArea(input.db, input.widgetAreaId)
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    return { kind: 'completed' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_widget_area');
  }
}

export async function listWidgetAuthorOptions(input: {
  db: D1Database;
  search: string;
}): Promise<WidgetAuthorOption[]> {
  const search = input.search;
  try {
    const result = await input.db.prepare(`
      SELECT id, display_name
      FROM authors
      WHERE instr(lower(id), lower(?)) > 0
         OR instr(lower(display_name), lower(?)) > 0
      ORDER BY display_name COLLATE NOCASE, display_name, id
      LIMIT 100
    `).bind(search, search).all<AuthorRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid Widget author options.');
    }
    return result.results.map((row) => {
      const parsed = widgetAuthorOptionSchema.safeParse(row);
      if (!parsed.success) throw dataInvalid(parsed.error);
      return parsed.data;
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_widget_author_options');
  }
}

function resolvePreviewWidgetItem(
  item: WidgetItem,
  authors: Map<string, WidgetAuthorOption>,
): PreviewWidgetItemData | null {
  if (!item.enabled) return null;
  if (item.type === 'profile') {
    const author = authors.get(item.settings.author_id);
    if (!author) return null;
    return {
      type: item.type,
      title: item.title,
      settings: { display_name: author.display_name },
    };
  }
  return {
    type: item.type,
    title: item.title,
    settings: item.settings,
  };
}

export function resolvePreviewWidgets(input: {
  widgetAreas: WidgetArea[];
  authors: Map<string, WidgetAuthorOption>;
}): Record<string, PreviewWidgetAreaData> {
  return Object.fromEntries(input.widgetAreas
    .filter((area) => area.enabled)
    .sort((left, right) => (
      left.widget_area_id < right.widget_area_id
        ? -1
        : left.widget_area_id > right.widget_area_id ? 1 : 0
    ))
    .map((area) => [
      area.widget_area_id,
      {
        name: area.name,
        items: area.items
          .map((item) => resolvePreviewWidgetItem(item, input.authors))
          .filter((item): item is PreviewWidgetItemData => item !== null),
      },
    ]));
}

export async function listPreviewWidgets(input: {
  db: D1Database;
}): Promise<Record<string, PreviewWidgetAreaData>> {
  try {
    const result = await input.db.prepare(`
      SELECT widget_area_id, name, enabled, items, revision,
             created_at_iso, updated_at_iso
      FROM widget_areas
      WHERE enabled = 1
      ORDER BY widget_area_id
      LIMIT ${WIDGET_AREA_MAX_COUNT + 1}
    `).all<WidgetAreaRow>();
    if (
      !Array.isArray(result.results)
      || result.results.length > WIDGET_AREA_MAX_COUNT
    ) {
      throw new TypeError('D1 returned an invalid Preview Widget area list.');
    }
    const widgetAreas = result.results.map(parseWidgetArea);
    const authorIds = [...new Set(widgetAreas.flatMap((area) => (
      collectProfileAuthorIds(area.items.filter((item) => item.enabled))
    )))];
    const authors = await readProfileAuthors(input.db, authorIds);
    return resolvePreviewWidgets({ widgetAreas, authors });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_preview_widgets');
  }
}
