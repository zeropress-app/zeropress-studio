import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from '../../../contracts/settings-revision';

export type StoredSettingType = 'string' | 'number' | 'boolean' | 'json';

export type StoredSettingRow = {
  key: string;
  value: string;
  type: string;
  updated_at_iso: string;
};

export type StoredSettingWrite = {
  key: string;
  value: string;
  type: StoredSettingType;
};

export type SettingsTableName = 'site_settings' | 'studio_settings';

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export function createSettingsRevision(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function readStoredSettings(input: {
  db: D1Database;
  keys: readonly string[];
  table?: SettingsTableName;
}): Promise<StoredSettingRow[]> {
  if (input.keys.length === 0) return [];
  const table = input.table ?? 'site_settings';
  const placeholders = input.keys.map(() => '?').join(', ');
  const result = await input.db.prepare(`
    SELECT key, value, type, updated_at_iso
    FROM ${table}
    WHERE key IN (${placeholders})
  `).bind(...input.keys).all<StoredSettingRow>();
  return result.results ?? [];
}

function guardedSettingStatement(input: {
  db: D1Database;
  setting: StoredSettingWrite;
  revisionKey: string;
  nextRevision: string;
  updatedBy: string;
  nowIso: string;
  table: SettingsTableName;
}): D1PreparedStatement {
  return input.db.prepare(`
    INSERT INTO ${input.table} (
      key, value, type, updated_by, updated_at_iso
    )
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM ${input.table} revision
      WHERE revision.key = ?
        AND revision.type = 'string'
        AND revision.value = ?
    )
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      updated_by = excluded.updated_by,
      updated_at_iso = excluded.updated_at_iso
  `).bind(
    input.setting.key,
    input.setting.value,
    input.setting.type,
    input.updatedBy,
    input.nowIso,
    input.revisionKey,
    input.nextRevision,
  );
}

export type RevisionedSettingsUpdateInput = {
  db: D1Database;
  revisionKey: string;
  settings: readonly StoredSettingWrite[];
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
  writeGuard?: {
    sql: string;
    bindings: readonly unknown[];
  };
  table?: SettingsTableName;
};

export type PreparedRevisionedSettingsUpdate = {
  statements: D1PreparedStatement[];
  revision: string;
  updatedAtIso: string;
  settingCount: number;
};

export function revisionExpectationGuard(input: {
  table?: SettingsTableName;
  revisionKey: string;
  settingKeys: readonly string[];
  expectedRevision: string;
}): { sql: string; bindings: readonly unknown[] } {
  const table = input.table ?? 'site_settings';
  const allKeys = [...input.settingKeys, input.revisionKey];
  return {
    sql: `(
      (
        ? = ?
        AND NOT EXISTS (
          SELECT 1 FROM ${table}
          WHERE key IN (${allKeys.map(() => '?').join(', ')})
        )
      ) OR EXISTS (
        SELECT 1 FROM ${table} expected_revision
        WHERE expected_revision.key = ?
          AND expected_revision.type = 'string'
          AND expected_revision.value = ?
      )
    )`,
    bindings: [
      input.expectedRevision,
      SETTINGS_INITIAL_REVISION,
      ...allKeys,
      input.revisionKey,
      input.expectedRevision,
    ],
  };
}

export function prepareRevisionedSettingsUpdate(
  input: RevisionedSettingsUpdateInput,
): PreparedRevisionedSettingsUpdate {
  const nowIso = (input.now ?? new Date()).toISOString();
  const table = input.table ?? 'site_settings';
  const nextRevision = settingsRevisionSchema.parse(
    (input.createRevision ?? createSettingsRevision)(),
  );
  if (
    nextRevision === SETTINGS_INITIAL_REVISION
    || nextRevision === input.expectedRevision
  ) {
    throw new TypeError('Settings revision must advance to a new value.');
  }

  const allKeys = [
    ...input.settings.map((setting) => setting.key),
    input.revisionKey,
  ];
  const initialStatePlaceholders = allKeys.map(() => '?').join(', ');
  const writeGuardSql = input.writeGuard
    ? `AND (${input.writeGuard.sql})`
    : '';
  const revisionStatement = input.db.prepare(`
    INSERT INTO ${table} (
      key, value, type, updated_by, updated_at_iso
    )
    SELECT ?, ?, 'string', ?, ?
    WHERE (
      (
        (
          ? = ?
          AND NOT EXISTS (
            SELECT 1
            FROM ${table}
            WHERE key IN (${initialStatePlaceholders})
          )
        ) OR EXISTS (
          SELECT 1
          FROM ${table} current_revision
          WHERE current_revision.key = ?
            AND current_revision.type = 'string'
            AND current_revision.value = ?
        )
      )
      ${writeGuardSql}
    )
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      type = 'string',
      updated_by = excluded.updated_by,
      updated_at_iso = excluded.updated_at_iso
    WHERE ${table}.type = 'string'
      AND ${table}.value = ?
  `).bind(
    input.revisionKey,
    nextRevision,
    input.updatedBy,
    nowIso,
    input.expectedRevision,
    SETTINGS_INITIAL_REVISION,
    ...allKeys,
    input.revisionKey,
    input.expectedRevision,
    ...(input.writeGuard?.bindings ?? []),
    input.expectedRevision,
  );
  return {
    statements: [
      revisionStatement,
      ...input.settings.map((setting) => guardedSettingStatement({
        db: input.db,
        setting,
        revisionKey: input.revisionKey,
        nextRevision,
        updatedBy: input.updatedBy,
        nowIso,
        table,
      })),
    ],
    revision: nextRevision,
    updatedAtIso: nowIso,
    settingCount: input.settings.length,
  };
}

export function revisionedSettingsUpdateApplied(
  prepared: PreparedRevisionedSettingsUpdate,
  results: readonly D1Result<unknown>[],
): boolean {
  if (results.length !== prepared.statements.length) {
    throw new TypeError('D1 returned an incomplete revisioned-settings batch.');
  }
  if (readChanges(results[0]) !== 1) return false;
  if (results.slice(1).some((result) => readChanges(result) !== 1)) {
    throw new TypeError('D1 returned an incomplete revisioned-settings batch.');
  }
  return true;
}

export async function updateRevisionedSettings(
  input: RevisionedSettingsUpdateInput,
): Promise<
  | {
      kind: 'completed';
      revision: string;
      updatedAtIso: string;
    }
  | { kind: 'revision_conflict' }
> {
  const prepared = prepareRevisionedSettingsUpdate(input);
  const results = await input.db.batch(prepared.statements);
  if (!revisionedSettingsUpdateApplied(prepared, results)) {
    return { kind: 'revision_conflict' };
  }
  return {
    kind: 'completed',
    revision: prepared.revision,
    updatedAtIso: prepared.updatedAtIso,
  };
}
