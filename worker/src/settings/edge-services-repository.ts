import {
  edgeIntegrationModeSchema,
  type EdgeIntegrationMode,
} from '../../../contracts/session';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError, logStudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
} from './revisioned-settings-repository';

export const EDGE_INTEGRATION_MODE_KEY = 'edge_integration_mode';
export const EDGE_INTEGRATION_REVISION_KEY = 'edge_integration_revision';
export const EDGE_INTEGRATION_READ_KEYS = [
  EDGE_INTEGRATION_MODE_KEY,
  EDGE_INTEGRATION_REVISION_KEY,
] as const;

export type StoredEdgeIntegrationDocument = {
  settings: { mode: EdgeIntegrationMode };
  revision: string;
  updated_at_iso: string;
};

function dataInvalid(cause?: unknown) {
  return new StudioOperationalError('EDGE_INTEGRATION_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_edge_integration_settings' },
  });
}

export function materializeEdgeIntegrationDocument(
  rows: readonly StoredSettingRow[],
): StoredEdgeIntegrationDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const mode = byKey.get(EDGE_INTEGRATION_MODE_KEY);
  const revision = byKey.get(EDGE_INTEGRATION_REVISION_KEY);
  if (
    !mode
    || !revision
    || mode.type !== 'string'
    || revision.type !== 'string'
    || mode.updated_at_iso !== revision.updated_at_iso
  ) throw dataInvalid();
  const parsedMode = edgeIntegrationModeSchema.safeParse(mode.value);
  const parsedRevision = settingsRevisionSchema.safeParse(revision.value);
  if (!parsedMode.success || !parsedRevision.success) {
    throw dataInvalid(parsedMode.error ?? parsedRevision.error);
  }
  return {
    settings: { mode: parsedMode.data },
    revision: parsedRevision.data,
    updated_at_iso: revision.updated_at_iso,
  };
}

export async function readEdgeIntegrationSettings(input: {
  db: D1Database;
}): Promise<StoredEdgeIntegrationDocument> {
  let rows: StoredSettingRow[];
  try {
    rows = await readStoredSettings({
      db: input.db,
      table: 'studio_settings',
      keys: EDGE_INTEGRATION_READ_KEYS,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'EDGE_INTEGRATION_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'read_edge_integration_settings' },
      },
    );
  }
  return materializeEdgeIntegrationDocument(rows);
}

/**
 * Edge integration is optional and must never invalidate an otherwise valid
 * Studio session. Missing or damaged control-plane state therefore resolves
 * to disabled while the operator receives one structured failure per read.
 */
export async function readEdgeIntegrationModeFailClosed(input: {
  db: D1Database;
}): Promise<EdgeIntegrationMode> {
  try {
    return (await readEdgeIntegrationSettings(input)).settings.mode;
  } catch (error) {
    const failure = error instanceof StudioOperationalError
      ? error
      : dataInvalid(error);
    logStudioOperationalError(failure);
    return 'disabled';
  }
}

export async function updateEdgeIntegrationSettings(input: {
  db: D1Database;
  mode: EdgeIntegrationMode;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: StoredEdgeIntegrationDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      table: 'studio_settings',
      revisionKey: EDGE_INTEGRATION_REVISION_KEY,
      settings: [{
        key: EDGE_INTEGRATION_MODE_KEY,
        value: input.mode,
        type: 'string',
      }],
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') return result;
    return {
      kind: 'completed',
      document: {
        settings: { mode: input.mode },
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'EDGE_INTEGRATION_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: { resource: 'DB', action: 'update_edge_integration_settings' },
      },
    );
  }
}
