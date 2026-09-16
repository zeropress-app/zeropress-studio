import { describe, expect, it, vi } from 'vitest';
import { inspectEdgeDatabaseRuntimeState } from './runtime-state';

function edgeDb(row: unknown, failure?: unknown): D1Database {
  return {
    prepare: vi.fn(() => ({
      first: failure === undefined
        ? vi.fn().mockResolvedValue(row)
        : vi.fn().mockRejectedValue(failure),
    })),
  } as unknown as D1Database;
}

describe('Edge database request-time lifecycle inspection', () => {
  it('accepts only the exact ready schema compiled into Studio', async () => {
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({
        schema_version: 1,
        lifecycle_state: 'ready',
        target_schema_version: null,
        active_operation_id: null,
      }),
    })).resolves.toEqual({
      state: 'ready', reason: 'ready', currentSchemaVersion: 1,
    });
  });

  it('classifies an active lifecycle operation as upgrade-required', async () => {
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({
        schema_version: 1,
        lifecycle_state: 'installing',
        target_schema_version: 1,
        active_operation_id: 'a'.repeat(32),
      }),
    })).resolves.toMatchObject({
      state: 'upgrade_required', reason: 'operation_in_progress',
    });
  });

  it('fails closed on newer, malformed, missing, and unreadable lifecycle state', async () => {
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({
        schema_version: 2,
        lifecycle_state: 'ready',
        target_schema_version: null,
        active_operation_id: null,
      }),
    })).resolves.toMatchObject({
      state: 'recovery_required', reason: 'schema_newer',
    });
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({
        schema_version: 1,
        lifecycle_state: 'failed',
        target_schema_version: 1,
        active_operation_id: 'a'.repeat(32),
      }),
    })).resolves.toMatchObject({
      state: 'recovery_required', reason: 'state_invalid',
    });
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({
        schema_version: 1,
        lifecycle_state: 'upgrading',
        target_schema_version: 1,
        active_operation_id: null,
      }),
    })).resolves.toMatchObject({
      state: 'recovery_required', reason: 'state_invalid',
    });
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb({ schema_version: '1' }),
    })).resolves.toMatchObject({
      state: 'recovery_required', reason: 'state_invalid',
    });
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb(null),
    })).resolves.toMatchObject({
      state: 'recovery_required', reason: 'state_missing',
    });
    await expect(inspectEdgeDatabaseRuntimeState({
      edgeDb: edgeDb(null, new Error('D1 unavailable')),
    })).resolves.toMatchObject({
      state: 'unavailable', reason: 'query_failed',
    });
    await expect(inspectEdgeDatabaseRuntimeState({})).resolves.toMatchObject({
      state: 'unavailable', reason: 'binding_missing',
    });
  });
});
