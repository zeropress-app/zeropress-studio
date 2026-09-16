import {
  MAIL_SETTINGS_INITIAL_REVISION,
  mailSettingsDocumentSchema,
  materializeMailSettingsDefaults,
  type MailSettings,
  type MailSettingsDocument,
  type UpdateMailSettingsRequest,
} from '../../../contracts/mail-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from '../settings/revisioned-settings-repository';
import {
  decryptMailCredential,
  encryptedMailCredentialSchema,
  encryptMailCredential,
  type EncryptedMailCredential,
  type MailCredentialKind,
} from './credential-crypto';

const MAIL_SETTINGS_REVISION_KEY = 'mail_settings_revision';
const MAIL_SETTINGS_STORAGE_KEYS = {
  provider: 'mail_provider',
  from_email: 'mail_from_email',
  from_name: 'mail_from_name',
  cloudflare_account_id: 'mail_cloudflare_account_id',
  resend_api_key: 'mail_resend_api_key_encrypted',
  cloudflare_api_token: 'mail_cloudflare_api_token_encrypted',
} as const;

export const MAIL_SETTINGS_READ_KEYS = [
  ...Object.values(MAIL_SETTINGS_STORAGE_KEYS),
  MAIL_SETTINGS_REVISION_KEY,
] as const;

type CredentialState = {
  resend_api_key: EncryptedMailCredential | null;
  cloudflare_api_token: EncryptedMailCredential | null;
};

type InternalMailSettingsDocument = {
  publicDocument: MailSettingsDocument;
  credentials: CredentialState;
};

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('MAIL_SETTINGS_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_mail_settings' },
  });
}

function credentialJson(value: EncryptedMailCredential | null): string {
  return JSON.stringify(value);
}

function serializeMailSettings(input: {
  settings: MailSettings;
  credentials: CredentialState;
}): StoredSettingWrite[] {
  return [
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.provider,
      value: input.settings.provider,
      type: 'string',
    },
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.from_email,
      value: input.settings.from_email,
      type: 'string',
    },
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.from_name,
      value: input.settings.from_name,
      type: 'string',
    },
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.cloudflare_account_id,
      value: input.settings.cloudflare_account_id,
      type: 'string',
    },
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.resend_api_key,
      value: credentialJson(input.credentials.resend_api_key),
      type: 'json',
    },
    {
      key: MAIL_SETTINGS_STORAGE_KEYS.cloudflare_api_token,
      value: credentialJson(input.credentials.cloudflare_api_token),
      type: 'json',
    },
  ];
}

function parseCredential(value: string): EncryptedMailCredential | null {
  const parsedJson = JSON.parse(value) as unknown;
  if (parsedJson === null) return null;
  return encryptedMailCredentialSchema.parse(parsedJson);
}

function configured(input: {
  settings: MailSettings;
  credentials: CredentialState;
}): boolean {
  if (input.settings.provider === 'resend') {
    return Boolean(input.settings.from_email && input.credentials.resend_api_key);
  }
  if (input.settings.provider === 'cloudflare') {
    return Boolean(
      input.settings.from_email
      && input.settings.cloudflare_account_id
      && input.credentials.cloudflare_api_token,
    );
  }
  return false;
}

function publicDocument(input: {
  settings: MailSettings;
  credentials: CredentialState;
  revision: string;
  updatedAtIso: string | null;
}): MailSettingsDocument {
  return mailSettingsDocumentSchema.parse({
    settings: input.settings,
    credentials: {
      resend_api_key_configured: input.credentials.resend_api_key !== null,
      cloudflare_api_token_configured:
        input.credentials.cloudflare_api_token !== null,
    },
    configured: configured(input),
    revision: input.revision,
    updated_at_iso: input.updatedAtIso,
  });
}

function materializeInternalMailSettingsDocument(
  rows: readonly StoredSettingRow[],
): InternalMailSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(MAIL_SETTINGS_REVISION_KEY);
  const authoredRows = Object.values(MAIL_SETTINGS_STORAGE_KEYS)
    .map((key) => byKey.get(key))
    .filter((row): row is StoredSettingRow => row !== undefined);
  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    const credentials: CredentialState = {
      resend_api_key: null,
      cloudflare_api_token: null,
    };
    return {
      publicDocument: publicDocument({
        settings: materializeMailSettingsDefaults(),
        credentials,
        revision: MAIL_SETTINGS_INITIAL_REVISION,
        updatedAtIso: null,
      }),
      credentials,
    };
  }

  const expectedTypes = new Map<string, string>([
    [MAIL_SETTINGS_STORAGE_KEYS.provider, 'string'],
    [MAIL_SETTINGS_STORAGE_KEYS.from_email, 'string'],
    [MAIL_SETTINGS_STORAGE_KEYS.from_name, 'string'],
    [MAIL_SETTINGS_STORAGE_KEYS.cloudflare_account_id, 'string'],
    [MAIL_SETTINGS_STORAGE_KEYS.resend_api_key, 'json'],
    [MAIL_SETTINGS_STORAGE_KEYS.cloudflare_api_token, 'json'],
  ]);
  if (
    revisionRow.type !== 'string'
    || revisionRow.value === MAIL_SETTINGS_INITIAL_REVISION
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
    || authoredRows.length !== expectedTypes.size
    || [...expectedTypes].some(([key, type]) => byKey.get(key)?.type !== type)
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) {
    throw dataInvalid();
  }

  try {
    const settings = mailSettingsDocumentSchema.shape.settings.parse({
      provider: byKey.get(MAIL_SETTINGS_STORAGE_KEYS.provider)?.value,
      from_email: byKey.get(MAIL_SETTINGS_STORAGE_KEYS.from_email)?.value,
      from_name: byKey.get(MAIL_SETTINGS_STORAGE_KEYS.from_name)?.value,
      cloudflare_account_id: byKey.get(
        MAIL_SETTINGS_STORAGE_KEYS.cloudflare_account_id,
      )?.value,
    });
    const credentials: CredentialState = {
      resend_api_key: parseCredential(
        byKey.get(MAIL_SETTINGS_STORAGE_KEYS.resend_api_key)?.value ?? '',
      ),
      cloudflare_api_token: parseCredential(
        byKey.get(MAIL_SETTINGS_STORAGE_KEYS.cloudflare_api_token)?.value ?? '',
      ),
    };
    const canonicalRows = serializeMailSettings({ settings, credentials });
    if (canonicalRows.some(
      (row) => byKey.get(row.key)?.value !== row.value,
    )) {
      throw new TypeError('Stored mail settings are not canonical.');
    }
    return {
      publicDocument: publicDocument({
        settings,
        credentials,
        revision: revisionRow.value,
        updatedAtIso: revisionRow.updated_at_iso,
      }),
      credentials,
    };
  } catch (error) {
    throw dataInvalid(error);
  }
}

async function readInternal(input: {
  db: D1Database;
}): Promise<InternalMailSettingsDocument> {
  const rows = await readStoredSettings({
    db: input.db,
    keys: MAIL_SETTINGS_READ_KEYS,
  });
  return materializeInternalMailSettingsDocument(rows);
}

export async function readMailSettings(input: {
  db: D1Database;
}): Promise<MailSettingsDocument> {
  try {
    return (await readInternal(input)).publicDocument;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('MAIL_SETTINGS_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'read_mail_settings' },
    });
  }
}

type CredentialAction = UpdateMailSettingsRequest['credentials'][
  'resend_api_key'
];

async function applyCredentialAction(input: {
  current: EncryptedMailCredential | null;
  action: CredentialAction;
  authSecret: string;
  kind: MailCredentialKind;
}): Promise<EncryptedMailCredential | null> {
  if (input.action.action === 'preserve') return input.current;
  if (input.action.action === 'remove') return null;
  return encryptMailCredential({
    authSecret: input.authSecret,
    kind: input.kind,
    value: input.action.value,
  });
}

export async function updateMailSettings(input: {
  db: D1Database;
  settings: MailSettings;
  credentialActions: UpdateMailSettingsRequest['credentials'];
  expectedRevision: string;
  updatedBy: string;
  authSecret: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: MailSettingsDocument }
  | { kind: 'revision_conflict' }
  | { kind: 'credential_missing' }
> {
  let current: InternalMailSettingsDocument;
  try {
    current = await readInternal({ db: input.db });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('MAIL_SETTINGS_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'read_mail_settings_for_update' },
    });
  }
  const credentials = {
    resend_api_key: await applyCredentialAction({
      current: current.credentials.resend_api_key,
      action: input.credentialActions.resend_api_key,
      authSecret: input.authSecret,
      kind: 'resend_api_key',
    }),
    cloudflare_api_token: await applyCredentialAction({
      current: current.credentials.cloudflare_api_token,
      action: input.credentialActions.cloudflare_api_token,
      authSecret: input.authSecret,
      kind: 'cloudflare_api_token',
    }),
  };
  if (!configured({ settings: input.settings, credentials })
    && input.settings.provider !== 'disabled') {
    return { kind: 'credential_missing' };
  }

  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: MAIL_SETTINGS_REVISION_KEY,
      settings: serializeMailSettings({
        settings: input.settings,
        credentials,
      }),
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') return result;
    return {
      kind: 'completed',
      document: publicDocument({
        settings: input.settings,
        credentials,
        revision: result.revision,
        updatedAtIso: result.updatedAtIso,
      }),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('MAIL_SETTINGS_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'update_mail_settings' },
    });
  }
}

export async function readMailRuntimeConfiguration(input: {
  db: D1Database;
  authSecret: string;
}): Promise<
  | { kind: 'not_configured' }
  | {
      kind: 'configured';
      settings: MailSettings & { provider: 'resend' | 'cloudflare' };
      credential: string;
    }
> {
  let current: InternalMailSettingsDocument;
  try {
    current = await readInternal({ db: input.db });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('MAIL_SETTINGS_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'read_mail_runtime_configuration' },
    });
  }
  const { settings } = current.publicDocument;
  if (settings.provider === 'disabled') return { kind: 'not_configured' };
  const kind: MailCredentialKind = settings.provider === 'resend'
    ? 'resend_api_key'
    : 'cloudflare_api_token';
  const encrypted = current.credentials[kind];
  if (!encrypted || !current.publicDocument.configured) {
    return { kind: 'not_configured' };
  }
  return {
    kind: 'configured',
    settings: { ...settings, provider: settings.provider },
    credential: await decryptMailCredential({
      authSecret: input.authSecret,
      kind,
      encrypted,
    }),
  };
}

export async function readStoredMailCredential(input: {
  db: D1Database;
  authSecret: string;
  kind: MailCredentialKind;
}): Promise<string | null> {
  let current: InternalMailSettingsDocument;
  try {
    current = await readInternal({ db: input.db });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('MAIL_SETTINGS_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: { resource: 'DB', action: 'read_mail_credential' },
    });
  }
  const encrypted = current.credentials[input.kind];
  return encrypted
    ? decryptMailCredential({
        authSecret: input.authSecret,
        kind: input.kind,
        encrypted,
      })
    : null;
}
