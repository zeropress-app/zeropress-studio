import {
  STUDIO_INTERFACE_SETTINGS_INITIAL_REVISION,
  studioInterfaceSettingsDocumentSchema,
  type StudioInterfaceSettings,
  type StudioInterfaceSettingsDocument,
} from '../../../contracts/studio-interface-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
} from './revisioned-settings-repository';

const INTERFACE_SETTINGS_REVISION_KEY = 'interface_settings_revision';
const INTERFACE_SETTINGS_STORAGE_KEYS = {
  default_locale: 'default_interface_locale',
  enabled_locales: 'enabled_interface_locales',
} as const satisfies Record<keyof StudioInterfaceSettings, string>;

export const STUDIO_INTERFACE_SETTINGS_READ_KEYS = [
  ...Object.values(INTERFACE_SETTINGS_STORAGE_KEYS),
  INTERFACE_SETTINGS_REVISION_KEY,
] as const;

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('STUDIO_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_interface_settings',
    },
  });
}

export function materializeStudioInterfaceSettingsDocument(
  rows: readonly StoredSettingRow[],
): StudioInterfaceSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(INTERFACE_SETTINGS_REVISION_KEY);
  const defaultLocaleRow = byKey.get(
    INTERFACE_SETTINGS_STORAGE_KEYS.default_locale,
  );
  const enabledLocalesRow = byKey.get(
    INTERFACE_SETTINGS_STORAGE_KEYS.enabled_locales,
  );
  if (
    !revisionRow
    || !defaultLocaleRow
    || !enabledLocalesRow
    || revisionRow.type !== 'string'
    || defaultLocaleRow.type !== 'string'
    || enabledLocalesRow.type !== 'json'
    || revisionRow.value === STUDIO_INTERFACE_SETTINGS_INITIAL_REVISION
    || defaultLocaleRow.updated_at_iso !== revisionRow.updated_at_iso
    || enabledLocalesRow.updated_at_iso !== revisionRow.updated_at_iso
  ) {
    throw dataInvalid();
  }

  let enabledLocales: unknown;
  try {
    enabledLocales = JSON.parse(enabledLocalesRow.value);
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsed = studioInterfaceSettingsDocumentSchema.safeParse({
    settings: {
      default_locale: defaultLocaleRow.value,
      enabled_locales: enabledLocales,
    },
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  if (
    enabledLocalesRow.value
    !== JSON.stringify(parsed.data.settings.enabled_locales)
  ) {
    throw dataInvalid();
  }
  return parsed.data;
}

export async function readStudioInterfaceSettings(input: {
  db: D1Database;
}): Promise<StudioInterfaceSettingsDocument> {
  let rows: StoredSettingRow[];
  try {
    rows = await readStoredSettings({
      db: input.db,
      table: 'studio_settings',
      keys: STUDIO_INTERFACE_SETTINGS_READ_KEYS,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'STUDIO_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_interface_settings',
        },
      },
    );
  }
  return materializeStudioInterfaceSettingsDocument(rows);
}

export async function updateStudioInterfaceSettings(input: {
  db: D1Database;
  settings: StudioInterfaceSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: StudioInterfaceSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      table: 'studio_settings',
      revisionKey: INTERFACE_SETTINGS_REVISION_KEY,
      settings: [
        {
          key: INTERFACE_SETTINGS_STORAGE_KEYS.default_locale,
          value: input.settings.default_locale,
          type: 'string',
        },
        {
          key: INTERFACE_SETTINGS_STORAGE_KEYS.enabled_locales,
          value: JSON.stringify(input.settings.enabled_locales),
          type: 'json',
        },
      ],
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') return result;
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
      'STUDIO_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'update_interface_settings',
        },
      },
    );
  }
}
