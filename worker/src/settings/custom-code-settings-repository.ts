import {
  CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  customCodeSettingsDocumentSchema,
  materializeCustomCodeSettingsDefaults,
  type CustomCodeSettings,
  type CustomCodeSettingsDocument,
} from '../../../contracts/custom-code-settings';
import { settingsRevisionSchema } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import { createSettingsRevision } from './revisioned-settings-repository';

type CustomCodeRow = {
  id: unknown;
  custom_css_enabled: unknown;
  custom_css_content: unknown;
  head_end_enabled: unknown;
  head_end_content: unknown;
  body_end_enabled: unknown;
  body_end_content: unknown;
  revision: unknown;
  updated_at_iso: unknown;
};

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('CUSTOM_CODE_SETTINGS_DATA_INVALID', {
    cause,
    metadata: {
      resource: 'DB',
      action: 'validate_custom_code_settings',
    },
  });
}

function storedBoolean(value: unknown): boolean | null {
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

export function materializeCustomCodeSettingsDocument(
  row: CustomCodeRow | null,
): CustomCodeSettingsDocument {
  if (row === null) {
    return {
      settings: materializeCustomCodeSettingsDefaults(),
      revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
  }
  const parsed = customCodeSettingsDocumentSchema.safeParse({
    settings: {
      custom_css: {
        enabled: storedBoolean(row.custom_css_enabled),
        content: row.custom_css_content,
      },
      custom_html: {
        head_end: {
          enabled: storedBoolean(row.head_end_enabled),
          content: row.head_end_content,
        },
        body_end: {
          enabled: storedBoolean(row.body_end_enabled),
          content: row.body_end_content,
        },
      },
    },
    revision: row.revision,
    updated_at_iso: row.updated_at_iso,
  });
  if (
    row.id !== 1
    || !parsed.success
    || parsed.data.revision === CUSTOM_CODE_SETTINGS_INITIAL_REVISION
  ) {
    throw dataInvalid(parsed.success ? undefined : parsed.error);
  }
  return parsed.data;
}

export async function readCustomCodeSettings(input: {
  db: D1Database;
}): Promise<CustomCodeSettingsDocument> {
  let row: CustomCodeRow | null;
  try {
    row = await input.db.prepare(`
      SELECT
        id,
        custom_css_enabled,
        custom_css_content,
        head_end_enabled,
        head_end_content,
        body_end_enabled,
        body_end_content,
        revision,
        updated_at_iso
      FROM site_custom_code
      WHERE id = 1
    `).first<CustomCodeRow>();
  } catch (error) {
    throw new StudioOperationalError('CUSTOM_CODE_SETTINGS_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'read_custom_code_settings',
      },
    });
  }
  return materializeCustomCodeSettingsDocument(row);
}

function readChanges(result: D1Result<unknown>): number {
  const changes = result.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export async function updateCustomCodeSettings(input: {
  db: D1Database;
  settings: CustomCodeSettings;
  expectedRevision: string;
  updatedBy: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; document: CustomCodeSettingsDocument }
  | { kind: 'revision_conflict' }
> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextRevision = settingsRevisionSchema.parse(
    (input.createRevision ?? createSettingsRevision)(),
  );
  if (
    nextRevision === CUSTOM_CODE_SETTINGS_INITIAL_REVISION
    || nextRevision === input.expectedRevision
  ) {
    throw new TypeError('Custom Code settings revision must advance.');
  }

  try {
    const result = await input.db.prepare(`
      INSERT INTO site_custom_code (
        id,
        custom_css_enabled,
        custom_css_content,
        head_end_enabled,
        head_end_content,
        body_end_enabled,
        body_end_content,
        revision,
        updated_by,
        updated_at_iso
      )
      SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        (
          ? = ?
          AND NOT EXISTS (SELECT 1 FROM site_custom_code)
        )
        OR EXISTS (
          SELECT 1
          FROM site_custom_code
          WHERE id = 1 AND revision = ?
        )
      )
      ON CONFLICT(id) DO UPDATE SET
        custom_css_enabled = excluded.custom_css_enabled,
        custom_css_content = excluded.custom_css_content,
        head_end_enabled = excluded.head_end_enabled,
        head_end_content = excluded.head_end_content,
        body_end_enabled = excluded.body_end_enabled,
        body_end_content = excluded.body_end_content,
        revision = excluded.revision,
        updated_by = excluded.updated_by,
        updated_at_iso = excluded.updated_at_iso
      WHERE site_custom_code.revision = ?
    `).bind(
      input.settings.custom_css.enabled ? 1 : 0,
      input.settings.custom_css.content,
      input.settings.custom_html.head_end.enabled ? 1 : 0,
      input.settings.custom_html.head_end.content,
      input.settings.custom_html.body_end.enabled ? 1 : 0,
      input.settings.custom_html.body_end.content,
      nextRevision,
      input.updatedBy,
      nowIso,
      input.expectedRevision,
      CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
      input.expectedRevision,
      input.expectedRevision,
    ).run();
    if (readChanges(result) !== 1) return { kind: 'revision_conflict' };
    return {
      kind: 'completed',
      document: {
        settings: structuredClone(input.settings),
        revision: nextRevision,
        updated_at_iso: nowIso,
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('CUSTOM_CODE_SETTINGS_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'update_custom_code_settings',
      },
    });
  }
}
