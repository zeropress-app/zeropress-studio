import { z } from 'zod';
import { EDGE_DATABASE_SCHEMA_VERSION } from '../../../contracts/edge-database-lifecycle';
import type { EdgeDatabaseRuntimeState } from '../../../contracts/edge-runtime';

const lifecycleRowSchema = z.object({
  schema_version: z.number().int().positive(),
  lifecycle_state: z.enum(['ready', 'installing', 'upgrading', 'failed']),
  target_schema_version: z.number().int().positive().nullable(),
  active_operation_id: z.string().nullable(),
}).strict();

export type EdgeDatabaseRuntimeInspection = {
  state: EdgeDatabaseRuntimeState;
  reason:
    | 'ready'
    | 'binding_missing'
    | 'query_failed'
    | 'state_missing'
    | 'state_invalid'
    | 'schema_outdated'
    | 'schema_newer'
    | 'operation_in_progress';
  currentSchemaVersion: number | null;
};

function inspection(
  state: EdgeDatabaseRuntimeState,
  reason: EdgeDatabaseRuntimeInspection['reason'],
  currentSchemaVersion: number | null = null,
): EdgeDatabaseRuntimeInspection {
  return { state, reason, currentSchemaVersion };
}

/**
 * Lightweight request-time readiness check.
 *
 * Full catalog and seed validation is intentionally left to Edge Services and
 * Maintenance & Recovery. Ordinary Edge-backed requests still fail closed on
 * lifecycle/version drift without scanning sqlite_schema on every request.
 */
export async function inspectEdgeDatabaseRuntimeState(input: {
  edgeDb?: D1Database;
}): Promise<EdgeDatabaseRuntimeInspection> {
  if (!input.edgeDb) return inspection('unavailable', 'binding_missing');

  let raw: unknown;
  try {
    raw = await input.edgeDb.prepare(`
      SELECT schema_version, lifecycle_state, target_schema_version,
             active_operation_id
      FROM zeropress_edge_schema_state
      WHERE id = 1
      LIMIT 1
    `).first<unknown>();
  } catch {
    return inspection('unavailable', 'query_failed');
  }
  if (raw === null) return inspection('recovery_required', 'state_missing');

  const parsed = lifecycleRowSchema.safeParse(raw);
  if (!parsed.success) {
    return inspection('recovery_required', 'state_invalid');
  }
  const row = parsed.data;
  if (
    row.active_operation_id !== null
    && !/^[0-9a-f]{32}$/u.test(row.active_operation_id)
  ) {
    return inspection(
      'recovery_required',
      'state_invalid',
      row.schema_version,
    );
  }
  if (row.schema_version > EDGE_DATABASE_SCHEMA_VERSION) {
    return inspection(
      'recovery_required',
      'schema_newer',
      row.schema_version,
    );
  }
  if (row.lifecycle_state === 'failed') {
    return inspection(
      'recovery_required',
      'state_invalid',
      row.schema_version,
    );
  }
  if (row.lifecycle_state === 'ready') {
    if (
      row.target_schema_version !== null
      || row.active_operation_id !== null
    ) {
      return inspection(
        'recovery_required',
        'state_invalid',
        row.schema_version,
      );
    }
    return row.schema_version < EDGE_DATABASE_SCHEMA_VERSION
      ? inspection('upgrade_required', 'schema_outdated', row.schema_version)
      : inspection('ready', 'ready', row.schema_version);
  }
  if (
    row.target_schema_version !== EDGE_DATABASE_SCHEMA_VERSION
    || row.active_operation_id === null
  ) {
    return inspection(
      'recovery_required',
      'state_invalid',
      row.schema_version,
    );
  }
  return inspection(
    'upgrade_required',
    'operation_in_progress',
    row.schema_version,
  );
}
