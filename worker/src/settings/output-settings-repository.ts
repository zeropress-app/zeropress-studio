import {
  materializeOutputSettingsDefaults,
  OUTPUT_SETTINGS_INITIAL_REVISION,
  outputSettingsDocumentSchema,
  type OutputSettings,
  type OutputSettingsSuccess,
} from '../../../contracts/output-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStoredSettings,
  updateRevisionedSettings,
  type StoredSettingRow,
  type StoredSettingWrite,
} from './revisioned-settings-repository';

const OUTPUT_SETTINGS_REVISION_KEY = 'site_output_revision';
const OUTPUT_SETTINGS_STORAGE_KEYS = {
  expose_generator: 'site_expose_generator',
  search: 'site_search',
  feed: 'site_feed',
  archive: 'site_archive',
  posts_per_page: 'posts_per_page',
  date_style: 'date_style',
  time_style: 'time_style',
  footer: 'site_footer',
  robots: 'site_robots',
} as const satisfies Record<keyof OutputSettings, string>;

export const OUTPUT_SETTINGS_READ_KEYS = [
  ...Object.values(OUTPUT_SETTINGS_STORAGE_KEYS),
  OUTPUT_SETTINGS_REVISION_KEY,
] as const;

export type OutputSettingsDocument = OutputSettingsSuccess['data'];

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('SITE_OUTPUT_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_output_settings',
    },
  });
}

function serializeOutputSettings(
  settings: OutputSettings,
): StoredSettingWrite[] {
  return [
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.expose_generator,
      value: String(settings.expose_generator),
      type: 'boolean',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.search,
      value: JSON.stringify(settings.search),
      type: 'json',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.feed,
      value: JSON.stringify(settings.feed),
      type: 'json',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.archive,
      value: JSON.stringify(settings.archive),
      type: 'json',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.posts_per_page,
      value: String(settings.posts_per_page),
      type: 'number',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.date_style,
      value: settings.date_style,
      type: 'string',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.time_style,
      value: settings.time_style,
      type: 'string',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.footer,
      value: JSON.stringify(settings.footer),
      type: 'json',
    },
    {
      key: OUTPUT_SETTINGS_STORAGE_KEYS.robots,
      value: JSON.stringify(settings.robots),
      type: 'json',
    },
  ];
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export async function readOutputSettings(input: {
  db: D1Database;
}): Promise<OutputSettingsDocument> {
  let rows: StoredSettingRow[];
  try {
    rows = await readStoredSettings({
      db: input.db,
      keys: OUTPUT_SETTINGS_READ_KEYS,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'SITE_OUTPUT_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_output_settings',
        },
      },
    );
  }

  return materializeOutputSettingsDocument(rows);
}

export function materializeOutputSettingsDocument(
  rows: readonly StoredSettingRow[],
): OutputSettingsDocument {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const revisionRow = byKey.get(OUTPUT_SETTINGS_REVISION_KEY);
  const expectedRows = serializeOutputSettings(
    materializeOutputSettingsDefaults(),
  );
  const authoredRows = expectedRows
    .map((setting) => byKey.get(setting.key))
    .filter((row): row is StoredSettingRow => row !== undefined);

  if (!revisionRow) {
    if (authoredRows.length > 0) throw dataInvalid();
    return {
      settings: materializeOutputSettingsDefaults(),
      revision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  if (
    revisionRow.type !== 'string'
    || !settingsRevisionSchema.safeParse(revisionRow.value).success
    || revisionRow.value === OUTPUT_SETTINGS_INITIAL_REVISION
    || authoredRows.length !== expectedRows.length
    || expectedRows.some((setting) => (
      byKey.get(setting.key)?.type !== setting.type
    ))
    || authoredRows.some(
      (row) => row.updated_at_iso !== revisionRow.updated_at_iso,
    )
  ) {
    throw dataInvalid();
  }

  let rawSettings: unknown;
  try {
    rawSettings = {
      expose_generator: parseBoolean(byKey.get(
        OUTPUT_SETTINGS_STORAGE_KEYS.expose_generator,
      )?.value),
      search: parseJson(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.search)?.value ?? '',
      ),
      feed: parseJson(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.feed)?.value ?? '',
      ),
      archive: parseJson(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.archive)?.value ?? '',
      ),
      posts_per_page: Number(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.posts_per_page)?.value,
      ),
      date_style: byKey.get(
        OUTPUT_SETTINGS_STORAGE_KEYS.date_style,
      )?.value,
      time_style: byKey.get(
        OUTPUT_SETTINGS_STORAGE_KEYS.time_style,
      )?.value,
      footer: parseJson(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.footer)?.value ?? '',
      ),
      robots: parseJson(
        byKey.get(OUTPUT_SETTINGS_STORAGE_KEYS.robots)?.value ?? '',
      ),
    };
  } catch (error) {
    throw dataInvalid(error);
  }

  const parsedDocument = outputSettingsDocumentSchema.safeParse({
    settings: rawSettings,
    revision: revisionRow.value,
    updated_at_iso: revisionRow.updated_at_iso,
  });
  if (!parsedDocument.success) throw dataInvalid(parsedDocument.error);

  const canonicalRows = serializeOutputSettings(parsedDocument.data.settings);
  if (canonicalRows.some((setting) => (
    byKey.get(setting.key)?.value !== setting.value
  ))) {
    throw dataInvalid();
  }
  return parsedDocument.data;
}

export async function updateOutputSettings(input: {
  db: D1Database;
  settings: OutputSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: OutputSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  try {
    const result = await updateRevisionedSettings({
      db: input.db,
      revisionKey: OUTPUT_SETTINGS_REVISION_KEY,
      settings: serializeOutputSettings(input.settings),
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
      'SITE_OUTPUT_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'update_output_settings',
        },
      },
    );
  }
}
