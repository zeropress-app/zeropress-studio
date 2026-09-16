import {
  materializeRoutingSettingsDefaults,
  ROUTING_PAGE_OPTIONS_MAX_ITEMS,
  ROUTING_SETTINGS_FIELDS,
  ROUTING_SETTINGS_INITIAL_REVISION,
  routingPageOptionSchema,
  routingSettingsDocumentSchema,
  type RoutingPageOption,
  type RoutingSettings,
  type RoutingSettingsDocument,
  type RoutingSettingsField,
  type RoutingSettingsRecoveryPlan,
} from '../../../contracts/routing-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

export const ROUTING_SETTINGS_REVISION_KEY = 'site_routing_revision';
export const ROUTING_SETTINGS_STORAGE_KEYS = {
  permalinks: 'site_permalinks',
  front_page: 'site_front_page',
  post_index: 'site_post_index',
} as const satisfies Record<keyof RoutingSettings, string>;

export const ROUTING_SETTINGS_READ_KEYS = [
  ...Object.values(ROUTING_SETTINGS_STORAGE_KEYS),
  ROUTING_SETTINGS_REVISION_KEY,
] as const;

type PageOptionRow = {
  id: unknown;
  title: unknown;
  path: unknown;
};

export class RoutingSettingsIncompleteError extends StudioOperationalError {
  constructor(public readonly recovery: RoutingSettingsRecoveryPlan) {
    super('SITE_ROUTING_SETTINGS_INCOMPLETE', {
      metadata: {
        resource: 'DB',
        action: 'inspect_routing_settings_recovery',
        missing_fields: recovery.missing_fields,
      },
    });
    this.name = 'RoutingSettingsIncompleteError';
  }
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'SITE_ROUTING_SETTINGS_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError(
    'SITE_ROUTING_SETTINGS_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_ROUTING_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_routing_settings' },
  });
}

export function serializeRoutingSettings(
  settings: RoutingSettings,
): StoredSettingWrite[] {
  return [
    {
      key: ROUTING_SETTINGS_STORAGE_KEYS.permalinks,
      value: JSON.stringify(settings.permalinks),
      type: 'json',
    },
    {
      key: ROUTING_SETTINGS_STORAGE_KEYS.front_page,
      value: JSON.stringify(settings.front_page),
      type: 'json',
    },
    {
      key: ROUTING_SETTINGS_STORAGE_KEYS.post_index,
      value: JSON.stringify(settings.post_index),
      type: 'json',
    },
  ];
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export function materializeRoutingSettingsDocument(
  rows: readonly StoredSettingRow[],
): RoutingSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(ROUTING_SETTINGS_REVISION_KEY);
  const expectedRows = serializeRoutingSettings(
    materializeRoutingSettingsDefaults(),
  );
  const authoredRows = expectedRows
    .map((setting) => byKey.get(setting.key))
    .filter((row): row is StoredSettingRow => row !== undefined);

  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    return {
      settings: materializeRoutingSettingsDefaults(),
      revision: ROUTING_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  const revisionValid = (
    revisionRow.type !== 'string'
    ? false
    : settingsRevisionSchema.safeParse(revisionRow.value).success
      && revisionRow.value !== ROUTING_SETTINGS_INITIAL_REVISION
  );
  if (
    !revisionValid
    || expectedRows.some((setting) => {
      const row = byKey.get(setting.key);
      return row !== undefined && row.type !== setting.type;
    })
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) throw dataInvalid();

  const missingFields = ROUTING_SETTINGS_FIELDS.filter((field) => (
    !byKey.has(ROUTING_SETTINGS_STORAGE_KEYS[field])
  ));
  const defaults = materializeRoutingSettingsDefaults();
  let settings: unknown;
  try {
    settings = {
      permalinks: byKey.has(ROUTING_SETTINGS_STORAGE_KEYS.permalinks)
        ? parseJson(byKey.get(ROUTING_SETTINGS_STORAGE_KEYS.permalinks)!.value)
        : defaults.permalinks,
      front_page: byKey.has(ROUTING_SETTINGS_STORAGE_KEYS.front_page)
        ? parseJson(byKey.get(ROUTING_SETTINGS_STORAGE_KEYS.front_page)!.value)
        : defaults.front_page,
      post_index: byKey.has(ROUTING_SETTINGS_STORAGE_KEYS.post_index)
        ? parseJson(byKey.get(ROUTING_SETTINGS_STORAGE_KEYS.post_index)!.value)
        : defaults.post_index,
    };
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsed = routingSettingsDocumentSchema.safeParse({
    settings,
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  const canonicalRows = serializeRoutingSettings(parsed.data.settings);
  if (canonicalRows.some((setting) => (
    byKey.has(setting.key)
    && byKey.get(setting.key)?.value !== setting.value
  ))) throw dataInvalid();
  if (missingFields.length > 0) {
    throw new RoutingSettingsIncompleteError({
      expected_revision: parsed.data.revision,
      missing_fields: missingFields,
      proposed_settings: parsed.data.settings,
    });
  }
  return parsed.data;
}

function sameFields(
  left: readonly RoutingSettingsField[],
  right: readonly RoutingSettingsField[],
): boolean {
  return left.length === right.length
    && left.every((field, index) => field === right[index]);
}

function recoveryWriteGuard(
  missingFields: readonly RoutingSettingsField[],
): { sql: string; bindings: readonly unknown[] } {
  const missing = new Set(missingFields);
  return {
    sql: ROUTING_SETTINGS_FIELDS.map((field) => (
      `${missing.has(field) ? 'NOT ' : ''}EXISTS (
        SELECT 1 FROM site_settings WHERE key = ?
      )`
    )).join(' AND '),
    bindings: ROUTING_SETTINGS_FIELDS.map(
      (field) => ROUTING_SETTINGS_STORAGE_KEYS[field],
    ),
  };
}

export async function repairRoutingSettings(input: {
  db: D1Database;
  expectedRevision: string;
  missingFields: readonly RoutingSettingsField[];
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: RoutingSettingsDocument }
  | { kind: 'recovery_conflict' }
  | { kind: 'front_page_not_found' }
> {
  let recovery: RoutingSettingsRecoveryPlan;
  try {
    await readRoutingSettings({ db: input.db });
    return { kind: 'recovery_conflict' };
  } catch (error) {
    if (error instanceof RoutingSettingsIncompleteError) {
      recovery = error.recovery;
    } else if (error instanceof StudioOperationalError) {
      throw error;
    } else {
      throw dataInvalid(error);
    }
  }
  if (
    recovery.expected_revision !== input.expectedRevision
    || !sameFields(recovery.missing_fields, input.missingFields)
  ) return { kind: 'recovery_conflict' };
  if (
    recovery.proposed_settings.front_page.type === 'page'
    && !await publishedPageExists(
      input.db,
      recovery.proposed_settings.front_page.page_id,
    )
  ) return { kind: 'front_page_not_found' };
  const missingFieldsGuard = recoveryWriteGuard(recovery.missing_fields);
  const writeGuard = recovery.proposed_settings.front_page.type === 'page'
    ? {
        sql: `(${missingFieldsGuard.sql}) AND EXISTS (
          SELECT 1 FROM pages
          WHERE id = ? AND status = 'published'
        )`,
        bindings: [
          ...missingFieldsGuard.bindings,
          recovery.proposed_settings.front_page.page_id,
        ],
      }
    : missingFieldsGuard;

  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: ROUTING_SETTINGS_REVISION_KEY,
      settings: serializeRoutingSettings(recovery.proposed_settings),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
      writeGuard,
    });
    if (result.kind === 'revision_conflict') {
      if (
        recovery.proposed_settings.front_page.type === 'page'
        && !await publishedPageExists(
          input.db,
          recovery.proposed_settings.front_page.page_id,
        )
      ) return { kind: 'front_page_not_found' };
      return { kind: 'recovery_conflict' };
    }
    return {
      kind: 'completed',
      document: {
        settings: recovery.proposed_settings,
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'repair_routing_settings');
  }
}

export async function readRoutingSettings(input: {
  db: D1Database;
}): Promise<RoutingSettingsDocument> {
  try {
    const rows = await readStoredSettings({
      db: input.db,
      keys: ROUTING_SETTINGS_READ_KEYS,
    });
    return materializeRoutingSettingsDocument(rows);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_routing_settings');
  }
}

export async function publishedPageExists(
  db: D1Database,
  pageId: string,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT id
    FROM pages
    WHERE id = ? AND status = 'published'
    LIMIT 1
  `).bind(pageId).first<{ id?: unknown }>();
  return row?.id === pageId;
}

export async function updateRoutingSettings(input: {
  db: D1Database;
  settings: RoutingSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: RoutingSettingsDocument }
  | { kind: 'revision_conflict' }
  | { kind: 'front_page_not_found' }
> {
  try {
    const current = await readRoutingSettings({ db: input.db });
    if (current.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }
    if (
      input.settings.front_page.type === 'page'
      && !await publishedPageExists(
        input.db,
        input.settings.front_page.page_id,
      )
    ) return { kind: 'front_page_not_found' };
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: ROUTING_SETTINGS_REVISION_KEY,
      settings: serializeRoutingSettings(input.settings),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
      ...(input.settings.front_page.type === 'page'
        ? {
            writeGuard: {
              sql: `EXISTS (
                SELECT 1 FROM pages
                WHERE id = ? AND status = 'published'
              )`,
              bindings: [input.settings.front_page.page_id],
            },
          }
        : {}),
    });
    if (result.kind === 'revision_conflict') {
      if (
        input.settings.front_page.type === 'page'
        && !await publishedPageExists(
          input.db,
          input.settings.front_page.page_id,
        )
      ) return { kind: 'front_page_not_found' };
      return result;
    }
    return {
      kind: 'completed',
      document: {
        settings: input.settings,
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_routing_settings');
  }
}

export async function listRoutingPageOptions(input: {
  db: D1Database;
  search: string;
  selectedPageId?: string;
}): Promise<RoutingPageOption[]> {
  const search = input.search;
  const selectedPageId = input.selectedPageId ?? '';
  try {
    const result = await input.db.prepare(`
      WITH RECURSIVE page_paths(
        id, parent_id, title, slug, status, path, trail
      ) AS (
        SELECT id, parent_id, title, slug, status, slug, ',' || id || ','
        FROM pages
        WHERE parent_id IS NULL AND status != 'trash'
        UNION ALL
        SELECT child.id, child.parent_id, child.title, child.slug,
               child.status, page_paths.path || '/' || child.slug,
               page_paths.trail || child.id || ','
        FROM pages AS child
        INNER JOIN page_paths ON child.parent_id = page_paths.id
        WHERE child.status != 'trash'
          AND instr(page_paths.trail, ',' || child.id || ',') = 0
      )
      SELECT id, title, path
      FROM page_paths
      WHERE status = 'published'
        AND (
          id = ?
          OR instr(lower(title), lower(?)) > 0
          OR instr(lower(slug), lower(?)) > 0
          OR instr(lower(path), lower(?)) > 0
        )
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
               title COLLATE NOCASE, title, id
      LIMIT ${ROUTING_PAGE_OPTIONS_MAX_ITEMS}
    `).bind(
      selectedPageId,
      search,
      search,
      search,
      selectedPageId,
    ).all<PageOptionRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned invalid routing Page options.');
    }
    return result.results.map((row) => {
      const parsed = routingPageOptionSchema.safeParse(row);
      if (!parsed.success) throw dataInvalid(parsed.error);
      return parsed.data;
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_routing_page_options');
  }
}
