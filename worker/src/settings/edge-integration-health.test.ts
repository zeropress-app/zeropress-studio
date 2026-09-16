import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import type { EdgeDatabaseStatus } from '../../../contracts/edge-database-lifecycle';
import { inspectEdgeIntegration } from './edge-integration-health';

type Target = {
  target_type: 'post' | 'page';
  public_id: number;
  status: 'draft' | 'published' | 'trash';
  allow_comments: 0 | 1;
};

function studioDatabase(targets: Target[]): D1Database {
  return {
    prepare() {
      return {
        async all() {
          return { success: true, results: targets, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

function edgeDatabase(): D1Database {
  return {} as D1Database;
}

function lifecycle(
  state: EdgeDatabaseStatus['state'] = 'ready',
) {
  return vi.fn(async (): Promise<EdgeDatabaseStatus> => ({
    state,
    current_schema_version: state === 'uninstalled' ? null : 1,
    target_schema_version: 1,
    operation_id: null,
    next_upgrade_steps: [],
    install_available: false,
    adopt_available: false,
    upgrade_available: false,
  }));
}

function environment(input: {
  studioTargets?: Target[];
  edgeDb?: D1Database;
  edgeKv?: KVNamespace;
} = {}): Env {
  return {
    DB: studioDatabase(input.studioTargets ?? []),
    EDGE_DB: input.edgeDb,
    EDGE_KV: input.edgeKv,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

describe('Edge integration health inspection', () => {
  it('accepts the reviewed schema, singleton seeds, and exact targets', async () => {
    const targets: Target[] = [{
      target_type: 'post', public_id: 101, status: 'published',
      allow_comments: 1,
    }];
    await expect(inspectEdgeIntegration({
      env: environment({
        studioTargets: targets,
        edgeDb: edgeDatabase(),
        edgeKv: {} as KVNamespace,
      }),
      inspectLifecycle: lifecycle(),
      countPending: vi.fn().mockResolvedValue(0),
      compareTargets: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({ state: 'ready' });
  });

  it('classifies missing bindings, lifecycle actions, and KV independently', async () => {
    await expect(inspectEdgeIntegration({ env: environment() }))
      .resolves.toEqual({
        state: 'unavailable', reason: 'edge_db_binding_missing',
      });
    await expect(inspectEdgeIntegration({
      env: environment({
        edgeDb: edgeDatabase(),
      }),
      inspectLifecycle: lifecycle(),
      countPending: vi.fn().mockResolvedValue(0),
      compareTargets: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({
      state: 'unavailable', reason: 'edge_kv_binding_missing',
    });
    for (const [state, reason] of [
      ['uninstalled', 'database_uninstalled'],
      ['adoption_required', 'database_adoption_required'],
      ['upgrade_required', 'database_upgrade_required'],
      ['in_progress', 'database_upgrade_required'],
      ['recovery_required', 'database_recovery_required'],
      ['unmanaged', 'database_unmanaged'],
      ['newer_than_code', 'database_newer_than_code'],
    ] as const) {
      await expect(inspectEdgeIntegration({
        env: environment({
          edgeDb: edgeDatabase(),
          edgeKv: {} as KVNamespace,
        }),
        inspectLifecycle: lifecycle(state),
      })).resolves.toEqual({ state: 'unavailable', reason });
    }
  });

  it('separates D1 unavailability from target reconciliation', async () => {
    const unavailable = await inspectEdgeIntegration({
      env: environment({
        edgeDb: edgeDatabase(),
        edgeKv: {} as KVNamespace,
      }),
      inspectLifecycle: lifecycle(),
      countPending: vi.fn().mockResolvedValue(0),
      compareTargets: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    });
    expect(unavailable).toMatchObject({
      state: 'unavailable', reason: 'database_unavailable',
    });
    expect(unavailable).toHaveProperty('cause');

    await expect(inspectEdgeIntegration({
      env: environment({
        studioTargets: [{
          target_type: 'page', public_id: 7, status: 'draft',
          allow_comments: 0,
        }],
        edgeDb: edgeDatabase(),
        edgeKv: {} as KVNamespace,
      }),
      inspectLifecycle: lifecycle(),
      countPending: vi.fn().mockResolvedValue(0),
      compareTargets: vi.fn().mockResolvedValue(false),
    })).resolves.toEqual({ state: 'reconciliation_required' });
  });

  it('checks lifecycle, pending outbox, bounded parity, then the final KV binding', async () => {
    const calls: string[] = [];
    const inspectLifecycle = vi.fn(async () => {
      calls.push('lifecycle');
      return lifecycle()();
    });
    const countPending = vi.fn(async () => {
      calls.push('outbox');
      return 0;
    });
    const compareTargets = vi.fn(async () => {
      calls.push('parity');
      return true;
    });
    await expect(inspectEdgeIntegration({
      env: environment({ edgeDb: edgeDatabase() }),
      inspectLifecycle,
      countPending,
      compareTargets,
    })).resolves.toEqual({
      state: 'unavailable', reason: 'edge_kv_binding_missing',
    });
    expect(calls).toEqual(['lifecycle', 'outbox', 'parity']);

    calls.length = 0;
    countPending.mockImplementationOnce(async () => {
      calls.push('outbox');
      return 3;
    });
    await expect(inspectEdgeIntegration({
      env: environment({ edgeDb: edgeDatabase() }),
      inspectLifecycle,
      countPending,
      compareTargets,
    })).resolves.toEqual({
      state: 'projection_pending', pendingTargetEvents: 3,
    });
    expect(calls).toEqual(['lifecycle', 'outbox']);
  });
});
