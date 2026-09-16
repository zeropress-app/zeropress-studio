import {
  materializeMediaSettingsDefaults,
  MEDIA_SETTINGS_INITIAL_REVISION,
  mediaSettingsDocumentSchema,
  type MediaSettings,
  type MediaSettingsSuccess,
} from '../../../contracts/media-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

const MEDIA_SETTINGS_REVISION_KEY = 'site_media_revision';
const MEDIA_SETTINGS_STORAGE_KEYS = {
  media_origin: 'site_media_origin',
  media_delivery_mode: 'site_media_delivery_mode',
} as const satisfies Record<keyof MediaSettings, string>;

export const MEDIA_SETTINGS_READ_KEYS = [
  ...Object.values(MEDIA_SETTINGS_STORAGE_KEYS),
  MEDIA_SETTINGS_REVISION_KEY,
] as const;

export type MediaSettingsDocument = MediaSettingsSuccess['data'];

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_MEDIA_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_media_settings' },
  });
}

function serializeMediaSettings(settings: MediaSettings): StoredSettingWrite[] {
  return [
    {
      key: MEDIA_SETTINGS_STORAGE_KEYS.media_origin,
      value: settings.media_origin,
      type: 'string',
    },
    {
      key: MEDIA_SETTINGS_STORAGE_KEYS.media_delivery_mode,
      value: settings.media_delivery_mode,
      type: 'string',
    },
  ];
}

export function materializeMediaSettingsDocument(
  rows: readonly StoredSettingRow[],
): MediaSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(MEDIA_SETTINGS_REVISION_KEY);
  const expectedRows = serializeMediaSettings(materializeMediaSettingsDefaults());
  const authoredRows = expectedRows
    .map((setting) => byKey.get(setting.key))
    .filter((row): row is StoredSettingRow => row !== undefined);

  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    return {
      settings: materializeMediaSettingsDefaults(),
      revision: MEDIA_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  if (
    revisionRow.type !== 'string'
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
    || revisionRow.value === MEDIA_SETTINGS_INITIAL_REVISION
    || authoredRows.length !== expectedRows.length
    || expectedRows.some((setting) => (
      byKey.get(setting.key)?.type !== setting.type
    ))
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) throw dataInvalid();

  const parsed = mediaSettingsDocumentSchema.safeParse({
    settings: {
      media_origin: byKey.get(MEDIA_SETTINGS_STORAGE_KEYS.media_origin)?.value,
      media_delivery_mode: byKey.get(
        MEDIA_SETTINGS_STORAGE_KEYS.media_delivery_mode,
      )?.value,
    },
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  if (serializeMediaSettings(parsed.data.settings).some((setting) => (
    byKey.get(setting.key)?.value !== setting.value
  ))) throw dataInvalid();
  return parsed.data;
}

export async function readMediaSettings(input: {
  db: D1Database;
}): Promise<MediaSettingsDocument> {
  try {
    const rows = await readStoredSettings({
      db: input.db,
      keys: MEDIA_SETTINGS_READ_KEYS,
    });
    return materializeMediaSettingsDocument(rows);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'SITE_MEDIA_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'read_media_settings' },
      },
    );
  }
}

export async function updateMediaSettings(input: {
  db: D1Database;
  settings: MediaSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: MediaSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: MEDIA_SETTINGS_REVISION_KEY,
      settings: serializeMediaSettings(input.settings),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') {
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
    throw new StudioOperationalError(
      'SITE_MEDIA_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'update_media_settings' },
      },
    );
  }
}
