import {
  GENERAL_SETTINGS_DEFAULTS,
  GENERAL_SETTINGS_FIELDS,
  GENERAL_SETTINGS_INITIAL_REVISION,
  generalSettingsDocumentSchema,
  generalSettingsRevisionSchema,
  type GeneralSettings,
  type GeneralSettingsField,
  type GeneralSettingsRecoveryPlan,
  type GeneralSettingsSuccess,
} from '../../../contracts/general-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

export const GENERAL_SETTINGS_REVISION_KEY = 'site_general_revision';
export const GENERAL_SETTINGS_STORAGE_KEYS = {
  title: 'site_title',
  description: 'site_description',
  url: 'site_url',
  locale: 'site_locale',
  timezone: 'site_timezone',
} as const satisfies Record<keyof GeneralSettings, string>;

export const GENERAL_SETTINGS_READ_KEYS = [
  ...Object.values(GENERAL_SETTINGS_STORAGE_KEYS),
  GENERAL_SETTINGS_REVISION_KEY,
] as const;

export type GeneralSettingsDocument = GeneralSettingsSuccess['data'];

export class GeneralSettingsIncompleteError extends StudioOperationalError {
  constructor(public readonly recovery: GeneralSettingsRecoveryPlan) {
    super('SITE_SETTINGS_INCOMPLETE', {
      metadata: {
        resource: 'DB',
        action: 'inspect_general_settings_recovery',
        missing_fields: recovery.missing_fields,
      },
    });
    this.name = 'GeneralSettingsIncompleteError';
  }
}

export function serializeGeneralSettings(
  settings: GeneralSettings,
): StoredSettingWrite[] {
  return Object.entries(GENERAL_SETTINGS_STORAGE_KEYS).map(([field, key]) => ({
    key,
    value: settings[field as keyof GeneralSettings],
    type: 'string',
  }));
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_general_settings',
    },
  });
}

export async function readGeneralSettings(input: {
  db: D1Database;
}): Promise<GeneralSettingsDocument> {
  let rows: StoredSettingRow[];
  try {
    rows = await readStoredSettings({
      db: input.db,
      keys: GENERAL_SETTINGS_READ_KEYS,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'SITE_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_general_settings',
        },
      },
    );
  }

  return materializeGeneralSettingsDocument(rows);
}

export function materializeGeneralSettingsDocument(
  rows: readonly StoredSettingRow[],
): GeneralSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(GENERAL_SETTINGS_REVISION_KEY);
  const authoredRows = Object.values(GENERAL_SETTINGS_STORAGE_KEYS)
    .map((key) => byKey.get(key))
    .filter((row): row is StoredSettingRow => row !== undefined);

  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    return {
      settings: { ...GENERAL_SETTINGS_DEFAULTS },
      revision: GENERAL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  const revisionValid = (
    revisionRow.type !== 'string'
    ? false
    : generalSettingsRevisionSchema.safeParse(revisionRow.value).success
      && revisionRow.value !== GENERAL_SETTINGS_INITIAL_REVISION
  );
  if (
    !revisionValid
    || authoredRows.some((row) => row.type !== 'string')
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) {
    throw dataInvalid();
  }

  const missingFields = GENERAL_SETTINGS_FIELDS.filter((field) => (
    !byKey.has(GENERAL_SETTINGS_STORAGE_KEYS[field])
  ));
  const proposedSettings = Object.fromEntries(
    GENERAL_SETTINGS_FIELDS.map((field) => [
      field,
      byKey.get(GENERAL_SETTINGS_STORAGE_KEYS[field])?.value
        ?? GENERAL_SETTINGS_DEFAULTS[field],
    ]),
  );
  const parsedDocument = generalSettingsDocumentSchema.safeParse({
    settings: {
      ...proposedSettings,
    },
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsedDocument.success) throw dataInvalid(parsedDocument.error);
  if (missingFields.length > 0) {
    throw new GeneralSettingsIncompleteError({
      expected_revision: parsedDocument.data.revision,
      missing_fields: missingFields,
      proposed_settings: parsedDocument.data.settings,
    });
  }
  return parsedDocument.data;
}

function sameFields(
  left: readonly GeneralSettingsField[],
  right: readonly GeneralSettingsField[],
): boolean {
  return left.length === right.length
    && left.every((field, index) => field === right[index]);
}

function recoveryWriteGuard(
  missingFields: readonly GeneralSettingsField[],
): { sql: string; bindings: readonly unknown[] } {
  const missing = new Set(missingFields);
  return {
    sql: GENERAL_SETTINGS_FIELDS.map((field) => (
      `${missing.has(field) ? 'NOT ' : ''}EXISTS (
        SELECT 1 FROM site_settings WHERE key = ?
      )`
    )).join(' AND '),
    bindings: GENERAL_SETTINGS_FIELDS.map(
      (field) => GENERAL_SETTINGS_STORAGE_KEYS[field],
    ),
  };
}

export async function repairGeneralSettings(input: {
  db: D1Database;
  expectedRevision: string;
  missingFields: readonly GeneralSettingsField[];
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: GeneralSettingsDocument }
  | { kind: 'recovery_conflict' }
> {
  let recovery: GeneralSettingsRecoveryPlan;
  try {
    await readGeneralSettings({ db: input.db });
    return { kind: 'recovery_conflict' };
  } catch (error) {
    if (error instanceof GeneralSettingsIncompleteError) {
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

  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: GENERAL_SETTINGS_REVISION_KEY,
      settings: serializeGeneralSettings(recovery.proposed_settings),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
      writeGuard: recoveryWriteGuard(recovery.missing_fields),
    });
    if (result.kind === 'revision_conflict') {
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
    throw new StudioOperationalError('SITE_SETTINGS_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'repair_general_settings',
      },
    });
  }
}

export async function updateGeneralSettings(input: {
  db: D1Database;
  settings: GeneralSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: GeneralSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: GENERAL_SETTINGS_REVISION_KEY,
      settings: serializeGeneralSettings(input.settings),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') {
      return { kind: 'revision_conflict' };
    }
    return {
      kind: 'completed',
      document: {
        settings: { ...input.settings },
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'SITE_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'update_general_settings',
        },
      },
    );
  }
}
