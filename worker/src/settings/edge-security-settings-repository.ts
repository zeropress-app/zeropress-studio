import {
  edgeSecuritySettingsDocumentSchema,
  edgeSecuritySettingsSchema,
  type EdgeSecuritySettings,
  type EdgeSecuritySettingsDocument,
} from '../../../contracts/edge-security-settings';
import { StudioOperationalError } from '../lib/operational-error';

type EdgeSecuritySettingsRow = {
  comment_write_verification_mode?: unknown;
  newsletter_subscribe_verification_mode?: unknown;
  form_submit_verification_mode?: unknown;
  turnstile_sitekey?: unknown;
  ip_address_retention_days?: unknown;
  updated_at?: unknown;
};

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Edge security settings update time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = Number(result?.meta?.changes ?? 0);
  return Number.isInteger(changes) && changes >= 0 ? changes : 0;
}

function parseInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function settingsRevision(
  settings: EdgeSecuritySettings,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(settings)),
  );
  return toHex(new Uint8Array(digest).slice(0, 16));
}

function dataInvalid(input: {
  reason: 'missing_row' | 'invalid_row' | 'write_verification_failed';
  invalidFields?: string[];
}): StudioOperationalError {
  return new StudioOperationalError('EDGE_SECURITY_SETTINGS_DATA_INVALID', {
    metadata: {
      resource: 'EDGE_DB',
      action: 'validate_edge_security_settings',
      reason: input.reason,
      ...(input.invalidFields
        ? { invalidFields: input.invalidFields }
        : {}),
    },
  });
}

function invalidFieldsFromIssues(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
): string[] {
  return [...new Set(issues.map((issue) => issue.path[0])
    .filter((field): field is string => typeof field === 'string'))];
}

async function materializeDocument(
  row: EdgeSecuritySettingsRow | null,
): Promise<EdgeSecuritySettingsDocument> {
  if (!row) throw dataInvalid({ reason: 'missing_row' });

  const parsedSettings = edgeSecuritySettingsSchema.safeParse({
    comment_write_verification_mode:
      row.comment_write_verification_mode,
    newsletter_subscribe_verification_mode:
      row.newsletter_subscribe_verification_mode,
    form_submit_verification_mode: row.form_submit_verification_mode,
    turnstile_sitekey: row.turnstile_sitekey,
    ip_address_retention_days: parseInteger(
      row.ip_address_retention_days,
    ),
  });
  if (!parsedSettings.success || typeof row.updated_at !== 'string') {
    throw dataInvalid({
      reason: 'invalid_row',
      invalidFields: parsedSettings.success
        ? ['updated_at']
        : invalidFieldsFromIssues(parsedSettings.error.issues),
    });
  }

  const parsedDocument = edgeSecuritySettingsDocumentSchema.safeParse({
    settings: parsedSettings.data,
    revision: await settingsRevision(parsedSettings.data),
    updated_at_iso: row.updated_at,
  });
  if (!parsedDocument.success) {
    throw dataInvalid({
      reason: 'invalid_row',
      invalidFields: invalidFieldsFromIssues(parsedDocument.error.issues),
    });
  }
  return parsedDocument.data;
}

export async function readEdgeSecuritySettings(input: {
  edgeDb: D1Database;
}): Promise<EdgeSecuritySettingsDocument> {
  let row: EdgeSecuritySettingsRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT
        comment_write_verification_mode,
        newsletter_subscribe_verification_mode,
        form_submit_verification_mode,
        turnstile_sitekey,
        ip_address_retention_days,
        updated_at
      FROM edge_runtime_settings
      WHERE id = 1
      LIMIT 1
    `).first<EdgeSecuritySettingsRow>();
  } catch (error) {
    throw new StudioOperationalError(
      'EDGE_SECURITY_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'read_edge_security_settings',
        },
      },
    );
  }
  return materializeDocument(row);
}

function sameSettings(
  left: EdgeSecuritySettings,
  right: EdgeSecuritySettings,
): boolean {
  return left.comment_write_verification_mode
      === right.comment_write_verification_mode
    && left.newsletter_subscribe_verification_mode
      === right.newsletter_subscribe_verification_mode
    && left.form_submit_verification_mode
      === right.form_submit_verification_mode
    && left.turnstile_sitekey === right.turnstile_sitekey
    && left.ip_address_retention_days
      === right.ip_address_retention_days;
}

export async function updateEdgeSecuritySettings(input: {
  edgeDb: D1Database;
  settings: EdgeSecuritySettings;
  expectedRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; document: EdgeSecuritySettingsDocument }
  | { kind: 'revision_conflict' }
> {
  const current = await readEdgeSecuritySettings({ edgeDb: input.edgeDb });
  if (current.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict' };
  }
  if (sameSettings(current.settings, input.settings)) {
    return { kind: 'completed', document: current };
  }

  const nowIso = formatIsoUtcSeconds(input.now ?? new Date());
  let result: D1Result<unknown>;
  try {
    result = await input.edgeDb.prepare(`
      UPDATE edge_runtime_settings
      SET
        comment_write_verification_mode = ?,
        newsletter_subscribe_verification_mode = ?,
        form_submit_verification_mode = ?,
        turnstile_sitekey = ?,
        ip_address_retention_days = ?,
        updated_at = ?
      WHERE id = 1
        AND comment_write_verification_mode = ?
        AND newsletter_subscribe_verification_mode = ?
        AND form_submit_verification_mode = ?
        AND turnstile_sitekey IS ?
        AND ip_address_retention_days = ?
    `).bind(
      input.settings.comment_write_verification_mode,
      input.settings.newsletter_subscribe_verification_mode,
      input.settings.form_submit_verification_mode,
      input.settings.turnstile_sitekey,
      input.settings.ip_address_retention_days,
      nowIso,
      current.settings.comment_write_verification_mode,
      current.settings.newsletter_subscribe_verification_mode,
      current.settings.form_submit_verification_mode,
      current.settings.turnstile_sitekey,
      current.settings.ip_address_retention_days,
    ).run();
  } catch (error) {
    throw new StudioOperationalError(
      'EDGE_SECURITY_SETTINGS_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'update_edge_security_settings',
        },
      },
    );
  }
  if (readChanges(result) !== 1) return { kind: 'revision_conflict' };

  const next = await readEdgeSecuritySettings({ edgeDb: input.edgeDb });
  if (!sameSettings(next.settings, input.settings)) {
    throw dataInvalid({ reason: 'write_verification_failed' });
  }
  return { kind: 'completed', document: next };
}
