import {
  materializeNewsletterSettingsDefaults,
  NEWSLETTER_SETTINGS_INITIAL_REVISION,
  newsletterSettingsDocumentSchema,
  type NewsletterSettings,
  type NewsletterSettingsDocument,
} from '../../../contracts/newsletter-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

const NEWSLETTER_SETTINGS_KEY = 'site_newsletter';
const NEWSLETTER_SETTINGS_REVISION_KEY = 'site_newsletter_revision';

export const NEWSLETTER_SETTINGS_READ_KEYS = [
  NEWSLETTER_SETTINGS_KEY,
  NEWSLETTER_SETTINGS_REVISION_KEY,
] as const;

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_NEWSLETTER_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_newsletter_settings',
    },
  });
}

function serializeNewsletterSettings(
  settings: NewsletterSettings,
): StoredSettingWrite {
  return {
    key: NEWSLETTER_SETTINGS_KEY,
    value: JSON.stringify(settings),
    type: 'json',
  };
}

export function materializeNewsletterSettingsDocument(
  rows: readonly StoredSettingRow[],
): NewsletterSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const settingsRow = byKey.get(NEWSLETTER_SETTINGS_KEY);
  const revisionRow = byKey.get(NEWSLETTER_SETTINGS_REVISION_KEY);
  if (!settingsRow && !revisionRow) {
    return {
      settings: materializeNewsletterSettingsDefaults(),
      revision: NEWSLETTER_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  if (
    !settingsRow
    || !revisionRow
    || settingsRow.type !== 'json'
    || revisionRow.type !== 'string'
    || settingsRow.updated_at_iso !== revisionRow.updated_at_iso
    || revisionRow.value === NEWSLETTER_SETTINGS_INITIAL_REVISION
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
  ) {
    throw dataInvalid();
  }

  let settings: unknown;
  try {
    settings = JSON.parse(settingsRow.value) as unknown;
  } catch (error) {
    throw dataInvalid(error);
  }
  const parsed = newsletterSettingsDocumentSchema.safeParse({
    settings,
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (
    !parsed.success
    || JSON.stringify(parsed.data.settings) !== settingsRow.value
  ) {
    throw dataInvalid(parsed.success ? undefined : parsed.error);
  }
  return parsed.data;
}

export async function readNewsletterSettings(input: {
  db: D1Database;
}): Promise<NewsletterSettingsDocument> {
  try {
    const rows = await readStoredSettings({
      db: input.db,
      keys: NEWSLETTER_SETTINGS_READ_KEYS,
    });
    return materializeNewsletterSettingsDocument(rows);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'SITE_NEWSLETTER_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_newsletter_settings',
        },
      },
    );
  }
}

export async function updateNewsletterSettings(input: {
  db: D1Database;
  settings: NewsletterSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: NewsletterSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: NEWSLETTER_SETTINGS_REVISION_KEY,
      settings: [serializeNewsletterSettings(input.settings)],
      expectedRevision: input.expectedRevision,
      updatedBy: input.updatedBy,
      now: input.now,
      createRevision: input.createRevision,
    });
    if (result.kind === 'revision_conflict') return result;
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
      'SITE_NEWSLETTER_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'update_newsletter_settings',
        },
      },
    );
  }
}
