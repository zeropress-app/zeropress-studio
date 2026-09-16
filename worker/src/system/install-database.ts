import baselineSql from '../../../database/install/001_baseline.sql?raw';
import type { InstallRequest } from '../../../contracts/install';
import { splitSqlStatements } from '../../../contracts/sql-statements';
import type { EncryptedTotpSecret } from '../auth/mfa-crypto';
import { DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT } from '../access/settings-repository';
import { STUDIO_SCHEMA_VERSION } from './schema-version';

export type InstallDatabaseInput = {
  db: D1Database;
  edgeIntegrationMode: 'enabled' | 'disabled';
  administrator: Pick<InstallRequest, 'admin_name' | 'admin_email'>;
  interfaceLocale: InstallRequest['interface_locale'];
  passwordHash: string;
  mfa: {
    encryptedTotpSecret: EncryptedTotpSecret;
    lastUsedStep: number;
  };
  now?: Date;
  createId?: () => string;
};

function createOpaqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function getInstallBaselineStatements(): string[] {
  const statements = splitSqlStatements(baselineSql);

  if (statements.length === 0) {
    throw new Error('Studio install baseline contains no SQL statements.');
  }

  return statements;
}

export async function installStudioDatabase(
  input: InstallDatabaseInput,
): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const createId = input.createId ?? createOpaqueId;
  const administratorId = createId();
  const factorId = createId();
  const interfaceSettingsRevision = createId();
  const edgeIntegrationRevision = createId();
  const cloudflareAccessRevision = createId();
  const baselineStatements = getInstallBaselineStatements()
    .map((statement) => input.db.prepare(statement));

  await input.db.batch([
    ...baselineStatements,
    input.db.prepare(`
      INSERT INTO roles (
        key,
        name,
        description,
        is_system,
        created_at_iso,
        updated_at_iso
      )
      VALUES
        (
          'admin',
          'Administrator',
          'Full Studio administration access.',
          1,
          ?,
          ?
        ),
        (
          'editor',
          'Editor',
          'Manage and publish site content.',
          1,
          ?,
          ?
        ),
        (
          'author',
          'Author',
          'Create and manage assigned site content.',
          1,
          ?,
          ?
        )
    `).bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso),
    input.db.prepare(`
      INSERT INTO users (
        id,
        email,
        password_hash,
        name,
        status,
        email_verified,
        failed_login_attempts,
        locked_until,
        created_at_iso,
        updated_at_iso
      )
      VALUES (?, ?, ?, ?, 'active', 1, 0, NULL, ?, ?)
    `).bind(
      administratorId,
      input.administrator.admin_email,
      input.passwordHash,
      input.administrator.admin_name,
      nowIso,
      nowIso,
    ),
    input.db.prepare(`
      INSERT INTO user_mfa_factors (
        id,
        user_id,
        factor_type,
        secret_ciphertext,
        secret_iv,
        last_used_step,
        created_at_iso,
        verified_at_iso
      )
      VALUES (?, ?, 'totp', ?, ?, ?, ?, ?)
    `).bind(
      factorId,
      administratorId,
      input.mfa.encryptedTotpSecret.ciphertext,
      input.mfa.encryptedTotpSecret.iv,
      input.mfa.lastUsedStep,
      nowIso,
      nowIso,
    ),
    input.db.prepare(`
      INSERT INTO user_roles (
        user_id,
        role_key,
        created_at_iso
      )
      VALUES (?, 'admin', ?)
    `).bind(administratorId, nowIso),
    input.db.prepare(`
      INSERT INTO studio_settings (
        key, value, type, updated_by, updated_at_iso
      )
      VALUES
        ('default_interface_locale', ?, 'string', ?, ?),
        ('enabled_interface_locales', ?, 'json', ?, ?),
        ('interface_settings_revision', ?, 'string', ?, ?),
        ('edge_integration_mode', ?, 'string', ?, ?),
        ('edge_integration_revision', ?, 'string', ?, ?),
        ('cloudflare_access_requirement', ?, 'json', ?, ?),
        ('cloudflare_access_revision', ?, 'string', ?, ?)
    `).bind(
      input.interfaceLocale,
      administratorId,
      nowIso,
      JSON.stringify([input.interfaceLocale]),
      administratorId,
      nowIso,
      interfaceSettingsRevision,
      administratorId,
      nowIso,
      input.edgeIntegrationMode,
      administratorId,
      nowIso,
      edgeIntegrationRevision,
      administratorId,
      nowIso,
      JSON.stringify(DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT),
      administratorId,
      nowIso,
      cloudflareAccessRevision,
      administratorId,
      nowIso,
    ),
    input.db.prepare(`
      INSERT INTO zeropress_schema_state (
        id,
        schema_version,
        lifecycle_state,
        target_schema_version,
        active_operation_id,
        updated_at_iso
      )
      VALUES (1, ?, 'ready', NULL, NULL, ?)
    `).bind(STUDIO_SCHEMA_VERSION, nowIso),
    input.db.prepare(`
      INSERT INTO content_search_index_state (
        id,
        state,
        reason,
        phase,
        operation_id,
        post_public_id_cursor,
        page_public_id_cursor,
        processed_posts,
        processed_pages,
        total_posts,
        total_pages,
        started_at_iso,
        updated_at_iso
      )
      VALUES (
        1, 'ready', NULL, NULL, NULL,
        0, 0, 0, 0, 0, 0, NULL, ?
      )
    `).bind(nowIso),
  ]);
}
