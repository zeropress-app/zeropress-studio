import { z } from 'zod';
import type { DatabaseStatus } from '../../../contracts/system';
import type { SystemIncident } from './system-incident';
import {
  MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
  STUDIO_SCHEMA_VERSION,
} from './schema-version';

const APPLICATION_SCHEMA_STATE_TABLE = 'zeropress_schema_state';
const IGNORED_INTERNAL_TABLES = new Set([
  '_cf_KV',
  '_cf_METADATA',
]);

const schemaStateRowSchema = z.object({
  id: z.literal(1),
  schema_version: z.number().int().nonnegative(),
  lifecycle_state: z.enum(['ready', 'installing', 'upgrading', 'failed']),
  target_schema_version: z.number().int().positive().nullable(),
  active_operation_id: z.string().trim().min(1).nullable(),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

const TABLE_LIST_SQL = `
  SELECT name
  FROM sqlite_schema
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`;

const SCHEMA_STATE_SQL = `
  SELECT
    id,
    schema_version,
    lifecycle_state,
    target_schema_version,
    active_operation_id,
    updated_at_iso
  FROM zeropress_schema_state
  WHERE id = ?
  LIMIT 1
`;

export type DatabaseInspection = {
  status: DatabaseStatus;
  incident: SystemIncident | null;
};

function targetVersion() {
  return { target_schema_version: STUDIO_SCHEMA_VERSION } as const;
}

function invalidSchemaState(reason: string): DatabaseInspection {
  return {
    status: {
      state: 'recovery_required',
      schema_version: null,
      ...targetVersion(),
    },
    incident: {
      code: 'DATABASE_SCHEMA_STATE_INVALID',
      fingerprint: reason,
      metadata: {
        resource: 'DB',
        action: 'inspect_database_status',
        reason,
      },
    },
  };
}

function classifyReadySchema(schemaVersion: number): DatabaseStatus {
  if (schemaVersion < MIN_SUPPORTED_STUDIO_SCHEMA_VERSION) {
    return {
      state: 'unsupported',
      schema_version: schemaVersion,
      ...targetVersion(),
    };
  }

  if (schemaVersion < STUDIO_SCHEMA_VERSION) {
    return {
      state: 'upgrade_required',
      schema_version: schemaVersion,
      ...targetVersion(),
    };
  }

  if (schemaVersion > STUDIO_SCHEMA_VERSION) {
    return {
      state: 'newer_than_code',
      schema_version: schemaVersion,
      ...targetVersion(),
    };
  }

  return {
    state: 'ready',
    schema_version: schemaVersion,
    ...targetVersion(),
  };
}

export async function inspectDatabaseStatus(
  db: D1Database,
): Promise<DatabaseInspection> {
  try {
    const tableResult = await db.prepare(TABLE_LIST_SQL).all<{ name: unknown }>();
    if (!Array.isArray(tableResult.results)) {
      throw new TypeError('D1 returned an invalid table-list result');
    }

    const tableNames: string[] = [];
    for (const row of tableResult.results) {
      if (typeof row.name !== 'string') {
        throw new TypeError('D1 returned an invalid table name');
      }
      if (!IGNORED_INTERNAL_TABLES.has(row.name)) {
        tableNames.push(row.name);
      }
    }

    if (tableNames.length === 0) {
      return {
        status: {
          state: 'uninstalled',
          ...targetVersion(),
        },
        incident: null,
      };
    }

    if (!tableNames.includes(APPLICATION_SCHEMA_STATE_TABLE)) {
      return {
        status: { state: 'unmanaged' },
        incident: {
          code: 'DATABASE_UNMANAGED',
          metadata: {
            resource: 'DB',
            action: 'inspect_database_status',
          },
        },
      };
    }

    const rawState = await db
      .prepare(SCHEMA_STATE_SQL)
      .bind(1)
      .first<unknown>();

    if (rawState === null) {
      return invalidSchemaState('singleton_missing');
    }

    const parsedState = schemaStateRowSchema.safeParse(rawState);
    if (!parsedState.success) {
      return invalidSchemaState('malformed_row');
    }

    const state = parsedState.data;
    if (
      (state.lifecycle_state === 'installing' || state.lifecycle_state === 'upgrading')
      && (state.target_schema_version === null || state.active_operation_id === null)
    ) {
      return invalidSchemaState('incomplete_operation_state');
    }

    if (state.lifecycle_state === 'ready') {
      if (state.target_schema_version !== null || state.active_operation_id !== null) {
        return invalidSchemaState('stale_operation_state');
      }
      const status = classifyReadySchema(state.schema_version);
      return {
        status,
        incident: status.state === 'upgrade_required'
          ? {
              code: 'DATABASE_UPGRADE_REQUIRED',
              fingerprint: `${state.schema_version}:${STUDIO_SCHEMA_VERSION}`,
              metadata: {
                resource: 'DB',
                action: 'inspect_database_status',
                schema_version: state.schema_version,
                target_schema_version: STUDIO_SCHEMA_VERSION,
              },
            }
          : null,
      };
    }

    if (state.lifecycle_state === 'failed') {
      return {
        status: {
          state: 'recovery_required',
          schema_version: state.schema_version,
          ...targetVersion(),
        },
        incident: {
          code: 'DATABASE_SCHEMA_STATE_INVALID',
          fingerprint: 'lifecycle_failed',
          metadata: {
            resource: 'DB',
            action: 'inspect_database_status',
            reason: 'lifecycle_failed',
          },
        },
      };
    }

    return {
      status: {
        state: 'update_in_progress',
        schema_version: state.schema_version,
        ...targetVersion(),
      },
      incident: null,
    };
  } catch (error) {
    return {
      status: { state: 'unavailable' },
      incident: {
        code: 'DATABASE_STATUS_QUERY_FAILED',
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'inspect_database_status',
        },
      },
    };
  }
}
