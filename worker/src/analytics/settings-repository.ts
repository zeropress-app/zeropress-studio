import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_INITIAL_REVISION,
  analyticsSettingsDocumentSchema,
  analyticsSettingsSchema,
  type AnalyticsSettingsDocument,
  type UpdateAnalyticsSettings,
} from '../../../contracts/analytics';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
} from '../settings/revisioned-settings-repository';
import {
  decryptAnalyticsCredential,
  encryptAnalyticsCredential,
  encryptedAnalyticsCredentialSchema,
} from './credential-crypto';

const SETTINGS_KEY = 'analytics_settings';
const TOKEN_KEY = 'analytics_api_token_encrypted';
const REVISION_KEY = 'analytics_settings_revision';
const KEYS = [SETTINGS_KEY, TOKEN_KEY, REVISION_KEY];

async function readInternal(db: D1Database) {
  let rows;
  try {
    rows = await readStoredSettings({ db, keys: KEYS });
  } catch (cause) {
    throw new StudioOperationalError(
      'ANALYTICS_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause,
        metadata: { resource: 'DB', action: 'read_analytics_settings' },
      },
    );
  }
  if (rows.length === 0)
    return {
      document: analyticsSettingsDocumentSchema.parse({
        settings: { ...ANALYTICS_DEFAULTS },
        token_configured: false,
        configured: false,
        revision: ANALYTICS_INITIAL_REVISION,
        updated_at_iso: null,
      }),
      encrypted: null,
    };
  try {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const revision = byKey.get(REVISION_KEY)!;
    if (
      rows.length !== 3 ||
      revision.type !== 'string' ||
      revision.value === ANALYTICS_INITIAL_REVISION ||
      !settingsRevisionSchema.safeParse(revision.value).success ||
      rows.some((row) => row.updated_at_iso !== revision.updated_at_iso) ||
      byKey.get(SETTINGS_KEY)?.type !== 'json' ||
      byKey.get(TOKEN_KEY)?.type !== 'json'
    ) {
      throw new TypeError('Invalid analytics settings document.');
    }
    const rawSettings = JSON.parse(byKey.get(SETTINGS_KEY)!.value) as unknown;
    const settings = analyticsSettingsSchema.parse(rawSettings);
    if (JSON.stringify(settings) !== JSON.stringify(rawSettings))
      throw new TypeError('Noncanonical settings.');
    const encrypted = encryptedAnalyticsCredentialSchema
      .nullable()
      .parse(JSON.parse(byKey.get(TOKEN_KEY)!.value));
    if (settings.enabled && !encrypted)
      throw new TypeError('Missing analytics credential.');
    return {
      document: analyticsSettingsDocumentSchema.parse({
        settings,
        token_configured: encrypted !== null,
        configured:
          settings.enabled &&
          Boolean(encrypted && settings.account_id && settings.site_tag),
        revision: revision.value,
        updated_at_iso: revision.updated_at_iso,
      }),
      encrypted,
    };
  } catch (cause) {
    throw new StudioOperationalError('ANALYTICS_SETTINGS_DATA_INVALID', {
      cause,
      metadata: { resource: 'DB', action: 'validate_analytics_settings' },
    });
  }
}

export async function readAnalyticsSettings(input: { db: D1Database }) {
  return (await readInternal(input.db)).document;
}

export async function readAnalyticsCredential(input: {
  db: D1Database;
  authSecret: string;
}) {
  const { encrypted } = await readInternal(input.db);
  return encrypted
    ? decryptAnalyticsCredential({
        authSecret: input.authSecret,
        kind: 'cloudflare_api_token',
        encrypted,
      })
    : null;
}

export async function readAnalyticsRuntimeSettings(input: {
  db: D1Database;
  authSecret: string;
}) {
  const { document, encrypted } = await readInternal(input.db);
  return {
    document,
    token:
      document.configured && encrypted
        ? await decryptAnalyticsCredential({
            authSecret: input.authSecret,
            kind: 'cloudflare_api_token',
            encrypted,
          })
        : null,
  };
}

export async function updateAnalyticsSettings(
  input: UpdateAnalyticsSettings & {
    db: D1Database;
    authSecret: string;
    updatedBy: string;
    now?: Date;
    createRevision?: () => string;
  },
): Promise<
  | { kind: 'completed'; document: AnalyticsSettingsDocument }
  | { kind: 'revision_conflict' }
  | { kind: 'credential_missing' }
> {
  const current = await readInternal(input.db);
  if (current.document.revision !== input.expected_revision)
    return { kind: 'revision_conflict' };
  const encrypted =
    input.credential.action === 'remove'
      ? null
      : input.credential.action === 'preserve'
        ? current.encrypted
        : await encryptAnalyticsCredential({
            authSecret: input.authSecret,
            kind: 'cloudflare_api_token',
            value: input.credential.value,
          });
  if (input.settings.enabled && !encrypted)
    return { kind: 'credential_missing' };
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: REVISION_KEY,
      settings: [
        {
          key: SETTINGS_KEY,
          value: JSON.stringify(input.settings),
          type: 'json',
        },
        { key: TOKEN_KEY, value: JSON.stringify(encrypted), type: 'json' },
      ],
      expectedRevision: input.expected_revision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') return result;
    return {
      kind: 'completed',
      document: analyticsSettingsDocumentSchema.parse({
        settings: input.settings,
        token_configured: encrypted !== null,
        configured: input.settings.enabled && encrypted !== null,
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      }),
    };
  } catch (cause) {
    throw new StudioOperationalError(
      'ANALYTICS_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause,
        metadata: { resource: 'DB', action: 'update_analytics_settings' },
      },
    );
  }
}
