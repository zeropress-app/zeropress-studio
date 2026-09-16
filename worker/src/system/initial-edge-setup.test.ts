import { describe, expect, it, vi } from 'vitest';
import type { EdgeDatabaseStatus } from '../../../contracts/edge-database-lifecycle';
import {
  prepareInitialEdgeSetup,
} from './initial-edge-setup';

function edgeStatus(
  state: EdgeDatabaseStatus['state'],
): EdgeDatabaseStatus {
  return {
    state,
    current_schema_version: state === 'ready' ? 1 : null,
    target_schema_version: 1,
    operation_id: null,
    next_upgrade_steps: [],
    install_available: false,
    adopt_available: false,
    upgrade_available: false,
  };
}

const edgeDb = {} as D1Database;
const edgeKv = {} as KVNamespace;

describe('initial Edge setup', () => {
  it('installs an application-empty Edge database when both bindings exist', async () => {
    const inspect = vi.fn().mockResolvedValue(edgeStatus('uninstalled'));
    const install = vi.fn().mockResolvedValue(undefined);

    await expect(prepareInitialEdgeSetup({
      edgeDb,
      edgeKv,
      inspect,
      install,
    })).resolves.toEqual({ status: 'installed' });
    expect(install).toHaveBeenCalledWith({ edgeDb });
  });

  it.each([
    'ready',
    'adoption_required',
    'upgrade_required',
    'in_progress',
    'recovery_required',
    'unmanaged',
    'newer_than_code',
  ] as const)('preserves the non-empty %s state without writing', async (state) => {
    const install = vi.fn();
    await expect(prepareInitialEdgeSetup({
      edgeDb,
      inspect: vi.fn().mockResolvedValue(edgeStatus(state)),
      install,
    })).resolves.toEqual({
      status: 'skipped_nonempty',
      existingState: state,
    });
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'EDGE_DB is missing',
      input: { edgeKv },
      reason: 'edge_db_binding_missing',
    },
    {
      label: 'EDGE_KV is missing for an empty Edge database',
      input: {
        edgeDb,
        inspect: vi.fn().mockResolvedValue(edgeStatus('uninstalled')),
      },
      reason: 'edge_kv_binding_missing',
    },
    {
      label: 'the Edge database cannot be inspected',
      input: {
        edgeDb,
        edgeKv,
        inspect: vi.fn().mockResolvedValue(edgeStatus('unavailable')),
      },
      reason: 'database_unavailable',
    },
  ])('fails before Studio installation when $label', async ({ input, reason }) => {
    await expect(prepareInitialEdgeSetup(input))
      .rejects.toMatchObject({ reason });
  });

  it('accepts a canonical ready state after an install response is lost', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(edgeStatus('uninstalled'))
      .mockResolvedValueOnce(edgeStatus('ready'));

    await expect(prepareInitialEdgeSetup({
      edgeDb,
      edgeKv,
      inspect,
      install: vi.fn().mockRejectedValue(new Error('response lost')),
    })).resolves.toEqual({ status: 'installed' });
  });

  it('fails when an Edge install does not converge to ready', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(edgeStatus('uninstalled'))
      .mockResolvedValueOnce(edgeStatus('uninstalled'));

    await expect(prepareInitialEdgeSetup({
      edgeDb,
      edgeKv,
      inspect,
      install: vi.fn().mockRejectedValue(new Error('D1 write failed')),
    })).rejects.toMatchObject({
      reason: 'install_failed',
    });
  });
});
