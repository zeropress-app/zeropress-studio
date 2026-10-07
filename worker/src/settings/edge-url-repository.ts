import {
  materializeEdgeUrlSettingsDefaults,
  EDGE_URL_SETTINGS_INITIAL_REVISION,
  edgeUrlSettingsDocumentSchema,
  type EdgeUrlSettings,
  type EdgeUrlSettingsSuccess,
} from '../../../contracts/edge-url';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

const EDGE_URL_SETTINGS_REVISION_KEY = 'edge_url_revision';
const EDGE_URL_SETTINGS_STORAGE_KEYS = {
  edge_origin: 'edge_origin',
} as const satisfies Record<keyof EdgeUrlSettings, string>;

export const EDGE_URL_SETTINGS_READ_KEYS = [
  ...Object.values(EDGE_URL_SETTINGS_STORAGE_KEYS),
  EDGE_URL_SETTINGS_REVISION_KEY,
] as const;

export type EdgeUrlSettingsDocument = EdgeUrlSettingsSuccess['data'];

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('EDGE_URL_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_edge_url_settings' },
  });
}

function serializeEdgeUrlSettings(settings: EdgeUrlSettings): StoredSettingWrite[] {
  return [
    {
      key: EDGE_URL_SETTINGS_STORAGE_KEYS.edge_origin,
      value: settings.edge_origin,
      type: 'string',
    },
  ];
}

export function materializeEdgeUrlSettingsDocument(
  rows: readonly StoredSettingRow[],
): EdgeUrlSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(EDGE_URL_SETTINGS_REVISION_KEY);
  const expectedRows = serializeEdgeUrlSettings(materializeEdgeUrlSettingsDefaults());
  const authoredRows = expectedRows
    .map((setting) => byKey.get(setting.key))
    .filter((row): row is StoredSettingRow => row !== undefined);

  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    return {
      settings: materializeEdgeUrlSettingsDefaults(),
      revision: EDGE_URL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  if (
    revisionRow.type !== 'string'
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
    || revisionRow.value === EDGE_URL_SETTINGS_INITIAL_REVISION
    || authoredRows.length !== expectedRows.length
    || expectedRows.some((setting) => (
      byKey.get(setting.key)?.type !== setting.type
    ))
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) throw dataInvalid();

  const parsed = edgeUrlSettingsDocumentSchema.safeParse({
    settings: {
      edge_origin: byKey.get(EDGE_URL_SETTINGS_STORAGE_KEYS.edge_origin)?.value,
    },
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  if (serializeEdgeUrlSettings(parsed.data.settings).some((setting) => (
    byKey.get(setting.key)?.value !== setting.value
  ))) throw dataInvalid();
  return parsed.data;
}

export async function readEdgeUrlSettings(input: {
  db: D1Database;
}): Promise<EdgeUrlSettingsDocument> {
  try {
    const rows = await readStoredSettings({
      db: input.db,
      table: 'studio_settings',
      keys: EDGE_URL_SETTINGS_READ_KEYS,
    });
    return materializeEdgeUrlSettingsDocument(rows);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'EDGE_URL_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'read_edge_url_settings' },
      },
    );
  }
}

export async function updateEdgeUrlSettings(input: {
  db: D1Database;
  settings: EdgeUrlSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: EdgeUrlSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      table: 'studio_settings',
      revisionKey: EDGE_URL_SETTINGS_REVISION_KEY,
      settings: serializeEdgeUrlSettings(input.settings),
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
      'EDGE_URL_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'update_edge_url_settings' },
      },
    );
  }
}
