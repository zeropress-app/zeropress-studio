import {
  PUBLISHING_DEFAULTS,
  PUBLISHING_INITIAL_REVISION,
  publishingSettingsDocumentSchema,
  publishingSettingsSchema,
  type PublishingSettings,
  type PublishingSettingsDocument,
  type UpdatePublishingSettings,
} from '../../../contracts/publishing';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
} from '../settings/revisioned-settings-repository';
import {
  decryptPublishingCredential,
  encryptPublishingCredential,
  encryptedPublishingCredentialSchema,
} from './credential-crypto';

const SETTINGS_KEY = 'publishing_settings';
const TOKEN_KEY = 'publishing_api_token_encrypted';
const REVISION_KEY = 'publishing_settings_revision';
const KEYS = [SETTINGS_KEY, TOKEN_KEY, REVISION_KEY];

function isConfigured(settings: PublishingSettings, hasToken: boolean) {
  return Boolean(
    hasToken &&
    settings.owner &&
    settings.repo &&
    settings.branch &&
    settings.path,
  );
}

async function readInternal(db: D1Database) {
  let rows;
  try {
    rows = await readStoredSettings({ db, keys: KEYS });
  } catch (cause) {
    throw new StudioOperationalError(
      'PUBLISHING_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause,
        metadata: { resource: 'DB', action: 'read_publishing_settings' },
      },
    );
  }
  if (rows.length === 0)
    return {
      document: publishingSettingsDocumentSchema.parse({
        settings: { ...PUBLISHING_DEFAULTS },
        token_configured: false,
        configured: false,
        revision: PUBLISHING_INITIAL_REVISION,
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
      revision.value === PUBLISHING_INITIAL_REVISION ||
      !settingsRevisionSchema.safeParse(revision.value).success ||
      rows.some((row) => row.updated_at_iso !== revision.updated_at_iso) ||
      byKey.get(SETTINGS_KEY)?.type !== 'json' ||
      byKey.get(TOKEN_KEY)?.type !== 'json'
    ) {
      throw new TypeError('Invalid publishing settings document.');
    }
    const rawSettings = JSON.parse(byKey.get(SETTINGS_KEY)!.value) as unknown;
    const settings = publishingSettingsSchema.parse(rawSettings);
    if (JSON.stringify(settings) !== JSON.stringify(rawSettings))
      throw new TypeError('Noncanonical settings.');
    const encrypted = encryptedPublishingCredentialSchema
      .nullable()
      .parse(JSON.parse(byKey.get(TOKEN_KEY)!.value));
    if (settings.enabled && !encrypted)
      throw new TypeError('Missing publishing credential.');
    return {
      document: publishingSettingsDocumentSchema.parse({
        settings,
        token_configured: encrypted !== null,
        configured: isConfigured(settings, encrypted !== null),
        revision: revision.value,
        updated_at_iso: revision.updated_at_iso,
      }),
      encrypted,
    };
  } catch (cause) {
    throw new StudioOperationalError('PUBLISHING_SETTINGS_DATA_INVALID', {
      cause,
      metadata: { resource: 'DB', action: 'validate_publishing_settings' },
    });
  }
}

export async function readPublishingSettings(input: { db: D1Database }) {
  return (await readInternal(input.db)).document;
}

export async function readPublishingRuntimeSettings(input: {
  db: D1Database;
  authSecret: string;
}) {
  const { document, encrypted } = await readInternal(input.db);
  return {
    document,
    token: encrypted
      ? await decryptPublishingCredential({
          authSecret: input.authSecret,
          kind: 'github_token',
          encrypted,
        })
      : null,
  };
}

export async function updatePublishingSettings(
  input: UpdatePublishingSettings & {
    db: D1Database;
    authSecret: string;
    updatedBy: string;
    now?: Date;
    createRevision?: () => string;
  },
): Promise<
  | { kind: 'completed'; document: PublishingSettingsDocument }
  | { kind: 'revision_conflict' }
  | { kind: 'credential_missing' }
> {
  const settings = publishingSettingsSchema.parse(input.settings);
  const current = await readInternal(input.db);
  if (current.document.revision !== input.expected_revision)
    return { kind: 'revision_conflict' };
  const encrypted =
    input.credential.action === 'remove'
      ? null
      : input.credential.action === 'preserve'
        ? current.encrypted
        : await encryptPublishingCredential({
            authSecret: input.authSecret,
            kind: 'github_token',
            value: input.credential.value,
          });
  if (settings.enabled && !encrypted) return { kind: 'credential_missing' };
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: REVISION_KEY,
      settings: [
        {
          key: SETTINGS_KEY,
          value: JSON.stringify(settings),
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
      document: publishingSettingsDocumentSchema.parse({
        settings,
        token_configured: encrypted !== null,
        configured: isConfigured(settings, encrypted !== null),
        revision: result.revision,
        updated_at_iso: result.updatedAtIso,
      }),
    };
  } catch (cause) {
    throw new StudioOperationalError(
      'PUBLISHING_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause,
        metadata: { resource: 'DB', action: 'update_publishing_settings' },
      },
    );
  }
}
