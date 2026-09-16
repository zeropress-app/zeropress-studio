import {
  cloudflareAccessRequirementSchema,
  type CloudflareAccessRequirement,
} from '../../../contracts/cloudflare-access';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createSettingsRevision,
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
} from '../settings/revisioned-settings-repository';

export const CLOUDFLARE_ACCESS_REQUIREMENT_KEY =
  'cloudflare_access_requirement';
export const CLOUDFLARE_ACCESS_REVISION_KEY = 'cloudflare_access_revision';
export const CLOUDFLARE_ACCESS_READ_KEYS = [
  CLOUDFLARE_ACCESS_REQUIREMENT_KEY,
  CLOUDFLARE_ACCESS_REVISION_KEY,
] as const;

export const DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT = {
  mode: 'disabled',
  issuer: null,
  audience: null,
  bound_origin: null,
  verified_at_iso: null,
} as const satisfies CloudflareAccessRequirement;

export type StoredCloudflareAccessDocument = {
  settings: CloudflareAccessRequirement;
  revision: string;
  updated_at_iso: string | null;
};

function dataInvalid(cause?: unknown) {
  return new StudioOperationalError('CLOUDFLARE_ACCESS_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_cloudflare_access_settings',
    },
  });
}

export function materializeCloudflareAccessDocument(
  rows: readonly StoredSettingRow[],
): StoredCloudflareAccessDocument {
  if (rows.length === 0) {
    return {
      settings: DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT,
      revision: SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const requirement = byKey.get(CLOUDFLARE_ACCESS_REQUIREMENT_KEY);
  const revision = byKey.get(CLOUDFLARE_ACCESS_REVISION_KEY);
  if (
    rows.length !== CLOUDFLARE_ACCESS_READ_KEYS.length
    || !requirement
    || !revision
    || requirement.type !== 'json'
    || revision.type !== 'string'
    || requirement.updated_at_iso !== revision.updated_at_iso
  ) {
    throw dataInvalid();
  }

  let rawRequirement: unknown;
  try {
    rawRequirement = JSON.parse(requirement.value);
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsedRequirement = cloudflareAccessRequirementSchema.safeParse(
    rawRequirement,
  );
  const parsedRevision = settingsRevisionSchema.safeParse(revision.value);
  if (!parsedRequirement.success || !parsedRevision.success) {
    throw dataInvalid(parsedRequirement.error ?? parsedRevision.error);
  }

  return {
    settings: parsedRequirement.data,
    revision: parsedRevision.data,
    updated_at_iso: revision.updated_at_iso,
  };
}

export async function readCloudflareAccessSettings(input: {
  db: D1Database;
}): Promise<StoredCloudflareAccessDocument> {
  let rows: StoredSettingRow[];
  try {
    rows = await readStoredSettings({
      db: input.db,
      table: 'studio_settings',
      keys: CLOUDFLARE_ACCESS_READ_KEYS,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'CLOUDFLARE_ACCESS_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_cloudflare_access_settings',
        },
      },
    );
  }
  return materializeCloudflareAccessDocument(rows);
}

export async function updateCloudflareAccessSettings(input: {
  db: D1Database;
  settings: CloudflareAccessRequirement;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: StoredCloudflareAccessDocument }
  | { kind: 'revision_conflict' }
> {
  const settings = cloudflareAccessRequirementSchema.parse(input.settings);
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      table: 'studio_settings',
      revisionKey: CLOUDFLARE_ACCESS_REVISION_KEY,
      settings: [{
        key: CLOUDFLARE_ACCESS_REQUIREMENT_KEY,
        value: JSON.stringify(settings),
        type: 'json',
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
        settings,
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'CLOUDFLARE_ACCESS_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'update_cloudflare_access_settings',
        },
      },
    );
  }
}

/**
 * Recovery-mode repair intentionally does not depend on the current document
 * or its revision. A partial or malformed document is exactly the state this
 * operation must be able to replace. The Operations route owns the recovery
 * mode and out-of-band authorization boundary.
 */
export async function recoverCloudflareAccessDisabled(input: {
  db: D1Database;
  now?: Date;
  createRevision?: () => string;
}): Promise<StoredCloudflareAccessDocument> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const revision = settingsRevisionSchema.parse(
    (input.createRevision ?? createSettingsRevision)(),
  );
  if (revision === SETTINGS_INITIAL_REVISION) {
    throw new TypeError('Recovery revision must not be the initial revision.');
  }

  try {
    await input.db.batch([
      input.db.prepare(`
        INSERT INTO studio_settings (
          key, value, type, updated_by, updated_at_iso
        ) VALUES (?, ?, 'json', NULL, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          type = excluded.type,
          updated_by = NULL,
          updated_at_iso = excluded.updated_at_iso
      `).bind(
        CLOUDFLARE_ACCESS_REQUIREMENT_KEY,
        JSON.stringify(DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT),
        nowIso,
      ),
      input.db.prepare(`
        INSERT INTO studio_settings (
          key, value, type, updated_by, updated_at_iso
        ) VALUES (?, ?, 'string', NULL, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          type = excluded.type,
          updated_by = NULL,
          updated_at_iso = excluded.updated_at_iso
      `).bind(
        CLOUDFLARE_ACCESS_REVISION_KEY,
        revision,
        nowIso,
      ),
    ]);
  } catch (error) {
    throw new StudioOperationalError(
      'CLOUDFLARE_ACCESS_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'recover_cloudflare_access_settings',
        },
      },
    );
  }

  return {
    settings: DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT,
    revision,
    updated_at_iso: nowIso,
  };
}
