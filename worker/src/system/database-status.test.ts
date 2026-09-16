import { describe, expect, it } from 'vitest';
import { createFakeD1, READY_SCHEMA_STATE } from '../test-helpers/fake-d1';
import { inspectDatabaseStatus } from './database-status';
import {
  MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
  STUDIO_SCHEMA_VERSION,
} from './schema-version';

describe('Studio database status inspection', () => {
  it.each([
    { tables: [] },
    { tables: ['_cf_KV'] },
    { tables: ['_cf_METADATA'] },
    { tables: ['_cf_KV', '_cf_METADATA'] },
  ])('treats a database with no application tables as uninstalled', async ({ tables }) => {
    const result = await inspectDatabaseStatus(createFakeD1({ tables }).database);

    expect(result).toEqual({
      status: {
        state: 'uninstalled',
        target_schema_version: STUDIO_SCHEMA_VERSION,
      },
      incident: null,
    });
  });

  it.each([
    ['an application table', ['users']],
    ['an internal and unknown table mix', ['_cf_METADATA', 'unknown_table']],
  ])('treats %s without lifecycle state as unmanaged', async (_label, tables) => {
    const result = await inspectDatabaseStatus(
      createFakeD1({ tables }).database,
    );

    expect(result.status).toEqual({ state: 'unmanaged' });
    expect(result.incident).toMatchObject({
      code: 'DATABASE_UNMANAGED',
    });
  });

  it.each([
    ['missing singleton', null, 'singleton_missing'],
    ['malformed singleton', { id: 1 }, 'malformed_row'],
    [
      'incomplete operation',
      {
        ...READY_SCHEMA_STATE,
        lifecycle_state: 'upgrading',
        target_schema_version: null,
      },
      'incomplete_operation_state',
    ],
  ])('requires a valid lifecycle row for %s', async (_label, schemaState, reason) => {
    const result = await inspectDatabaseStatus(
      createFakeD1({ schemaState }).database,
    );

    expect(result.status).toEqual({
      state: 'recovery_required',
      schema_version: null,
      target_schema_version: STUDIO_SCHEMA_VERSION,
    });
    expect(result.incident).toMatchObject({
      code: 'DATABASE_SCHEMA_STATE_INVALID',
      fingerprint: reason,
    });
  });

  it('classifies current, newer, unsupported, in-progress, and failed states', async () => {
    const cases = [
      [READY_SCHEMA_STATE, 'ready'],
      [{
        ...READY_SCHEMA_STATE,
        schema_version: STUDIO_SCHEMA_VERSION + 1,
      }, 'newer_than_code'],
      [{
        ...READY_SCHEMA_STATE,
        schema_version: MIN_SUPPORTED_STUDIO_SCHEMA_VERSION - 1,
      }, 'unsupported'],
      [{
        ...READY_SCHEMA_STATE,
        lifecycle_state: 'installing',
        schema_version: 0,
        target_schema_version: STUDIO_SCHEMA_VERSION,
        active_operation_id: 'operation-1',
      }, 'update_in_progress'],
      [{
        ...READY_SCHEMA_STATE,
        lifecycle_state: 'failed',
        active_operation_id: 'operation-1',
      }, 'recovery_required'],
    ] as const;

    for (const [schemaState, expectedState] of cases) {
      const result = await inspectDatabaseStatus(
        createFakeD1({ schemaState }).database,
      );
      expect(result.status.state).toBe(expectedState);
    }
  });

  it('converts D1 query failures into an unavailable status without throwing', async () => {
    const result = await inspectDatabaseStatus(
      createFakeD1({
        tableQueryError: new Error('D1 unavailable'),
      }).database,
    );

    expect(result.status).toEqual({ state: 'unavailable' });
    expect(result.incident).toMatchObject({
      code: 'DATABASE_STATUS_QUERY_FAILED',
      cause: expect.any(Error),
    });
  });
});
