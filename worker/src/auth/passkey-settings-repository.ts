import { DEFAULT_PASSKEY_SETTINGS, passkeySettingsSchema, type PasskeySettings } from '../../../contracts/passkey-settings';
import { SETTINGS_INITIAL_REVISION, settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import { updateRevisionedSettings, type StoredSettingRow } from '../settings/revisioned-settings-repository';

export const PASSKEY_POLICY_KEY = 'passkey_registration_policy';
export const PASSKEY_POLICY_REVISION_KEY = 'passkey_registration_policy_revision';
export const PASSKEY_POLICY_KEYS = [PASSKEY_POLICY_KEY, PASSKEY_POLICY_REVISION_KEY] as const;
export type StoredPasskeySettings = { settings: PasskeySettings; revision: string; updated_at_iso: string | null };
export function materializePasskeySettings(rows: readonly StoredSettingRow[]): StoredPasskeySettings {
  if (!rows.length) return { settings: { ...DEFAULT_PASSKEY_SETTINGS }, revision: SETTINGS_INITIAL_REVISION, updated_at_iso: null };
  try {
    const setting = rows.find((row) => row.key === PASSKEY_POLICY_KEY);
    const revision = rows.find((row) => row.key === PASSKEY_POLICY_REVISION_KEY);
    if (rows.length !== 2 || !setting || !revision || setting.type !== 'json' || revision.type !== 'string'
      || setting.updated_at_iso !== revision.updated_at_iso || !Number.isFinite(Date.parse(setting.updated_at_iso))) throw new Error('Invalid settings document');
    return { settings: passkeySettingsSchema.parse(JSON.parse(setting.value)), revision: settingsRevisionSchema.parse(revision.value), updated_at_iso: revision.updated_at_iso };
  } catch (cause) {
    throw new StudioOperationalError('PASSKEY_SETTINGS_DATA_INVALID', { cause, metadata: { resource: 'DB', action: 'read_passkey_policy' } });
  }
}
export async function readPasskeySettings({ db }: { db: D1Database }): Promise<StoredPasskeySettings> {
  try {
    const result = await db.prepare(`
      SELECT key, value, type, updated_at_iso FROM studio_settings
      WHERE key IN (?, ?)
    `).bind(...PASSKEY_POLICY_KEYS).all<StoredSettingRow>();
    // Only a successful empty result means an older installation's OFF default.
    // Never convert a failed or incomplete D1 response into a permissive policy.
    if (!result.success || !Array.isArray(result.results)) throw new Error('Invalid D1 policy response');
    return materializePasskeySettings(result.results);
  }
  catch (cause) {
    if (cause instanceof StudioOperationalError) throw cause;
    throw new StudioOperationalError('PASSKEY_SETTINGS_QUERY_FAILED', { cause, metadata: { resource: 'DB', action: 'read_passkey_policy' } });
  }
}
export async function updatePasskeySettings(input: { db: D1Database; settings: PasskeySettings; expectedRevision: string; updatedBy: string; now?: Date; createRevision?: () => string }): Promise<{ kind: 'completed'; document: StoredPasskeySettings } | { kind: 'revision_conflict' }> {
  const settings = passkeySettingsSchema.parse(input.settings);
  try {
    const result = await updateRevisionedSettings({ ...input, table: 'studio_settings', revisionKey: PASSKEY_POLICY_REVISION_KEY,
      settings: [{ key: PASSKEY_POLICY_KEY, value: JSON.stringify(settings), type: 'json' }] });
    if (result.kind === 'revision_conflict') return result;
    return { kind: 'completed', document: { settings, revision: result.revision, updated_at_iso: result.updatedAtIso } };
  } catch (cause) {
    throw new StudioOperationalError('PASSKEY_SETTINGS_WRITE_FAILED', { cause, metadata: { resource: 'DB', action: 'update_passkey_policy' } });
  }
}
