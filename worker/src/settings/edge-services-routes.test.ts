import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createEdgeServicesRoutes } from './edge-services-routes';

const CSRF = 'c'.repeat(43);
const REVISION = '1'.repeat(32);
const NEXT_REVISION = '2'.repeat(32);
const NOW = new Date('2026-08-11T01:00:00.000Z');

function session(role: 'admin' | 'editor' = 'admin'): ResolvedSession {
  return {
    user: {
      id: '3'.repeat(32), email: 'owner@example.com', name: 'Owner',
      roles: [role],
    },
    session: { id: '4'.repeat(32) },
    csrfToken: CSRF,
    authRevision: '5'.repeat(32),
    mfaVerifiedAtIso: NOW.toISOString(),
  } as ResolvedSession;
}

function env(includeEdge = false): Env {
  return {
    DB: {} as D1Database,
    ...(includeEdge
      ? { EDGE_DB: {} as D1Database, EDGE_KV: {} as KVNamespace }
      : {}),
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

function mutation(path: string, body: unknown) {
  return new Request(`https://studio.local${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF,
    },
    body: JSON.stringify(body),
  });
}

function updateRequest(mode: 'enabled' | 'disabled') {
  const request = mutation('/', {
    settings: { mode },
    expected_revision: REVISION,
  });
  return new Request(request, { method: 'PUT' });
}

function document(mode: 'enabled' | 'disabled', revision = REVISION) {
  return {
    settings: { mode },
    revision,
    updated_at_iso: NOW.toISOString(),
  } as const;
}

describe('Edge Services settings routes', () => {
  it('returns disabled state without touching Edge resources', async () => {
    const inspect = vi.fn();
    const routes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readSettings: vi.fn().mockResolvedValue(document('disabled')),
      countPending: vi.fn().mockResolvedValue(3),
      inspect,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        ...document('disabled'),
        effective_state: 'disabled',
        pending_target_events: 3,
      },
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('disables using only Studio D1 and preserves revision guards', async () => {
    let mode: 'enabled' | 'disabled' = 'enabled';
    let revision = REVISION;
    const inspect = vi.fn();
    const updateSettings = vi.fn(async (input: { mode: typeof mode }) => {
      mode = input.mode;
      revision = NEXT_REVISION;
      return { kind: 'completed' as const, document: document(mode, revision) };
    });
    const routes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readSettings: vi.fn(async () => document(mode, revision)),
      updateSettings,
      countPending: vi.fn().mockResolvedValue(0),
      inspect,
      now: () => NOW,
      createRevision: () => NEXT_REVISION,
    });
    const response = await routes.fetch(updateRequest('disabled'), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        settings: { mode: 'disabled' },
        effective_state: 'disabled',
        revision: NEXT_REVISION,
      },
    });
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      mode: 'disabled',
      expectedRevision: REVISION,
      updatedBy: '3'.repeat(32),
      now: NOW,
      createRevision: expect.any(Function),
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('enables only after pending events and exact parity are clear', async () => {
    const updateSettings = vi.fn();
    const pendingRoutes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      countPending: vi.fn().mockResolvedValue(1),
      inspect: vi.fn().mockResolvedValue({
        state: 'projection_pending',
        pendingTargetEvents: 1,
      }),
      updateSettings,
    });
    const pending = await pendingRoutes.fetch(updateRequest('enabled'), env());
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_TARGET_PROJECTION_PENDING' },
    });

    const mismatchRoutes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      countPending: vi.fn().mockResolvedValue(0),
      inspect: vi.fn().mockResolvedValue({
        state: 'reconciliation_required',
      }),
      updateSettings,
    });
    const mismatch = await mismatchRoutes.fetch(
      updateRequest('enabled'),
      env(true),
    );
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_RECONCILIATION_REQUIRED' },
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('separates unavailable activation from a successful ready activation', async () => {
    const consoleSpy = vi.spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const unavailableRoutes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      countPending: vi.fn().mockResolvedValue(0),
      inspect: vi.fn().mockResolvedValue({
        state: 'unavailable', reason: 'edge_db_binding_missing',
      }),
      updateSettings: vi.fn(),
    });
    const unavailable = await unavailableRoutes.fetch(
      updateRequest('enabled'),
      env(),
    );
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_UNAVAILABLE' },
    });
    expect(consoleSpy).toHaveBeenCalledOnce();

    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: document('enabled', NEXT_REVISION),
    });
    const readyRoutes = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readSettings: vi.fn().mockResolvedValue(
        document('enabled', NEXT_REVISION),
      ),
      countPending: vi.fn().mockResolvedValue(0),
      inspect: vi.fn().mockResolvedValue({ state: 'ready' }),
      updateSettings,
      now: () => NOW,
    });
    const ready = await readyRoutes.fetch(updateRequest('enabled'), env(true));
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      success: true,
      data: { settings: { mode: 'enabled' }, effective_state: 'ready' },
    });
    expect(updateSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ['database_uninstalled', 'EDGE_DATABASE_INSTALL_REQUIRED'],
    ['database_adoption_required', 'EDGE_DATABASE_ADOPTION_REQUIRED'],
    ['database_upgrade_required', 'EDGE_DATABASE_UPGRADE_REQUIRED'],
    ['database_recovery_required', 'EDGE_DATABASE_RECOVERY_REQUIRED'],
  ] as const)(
    'maps %s activation state to %s',
    async (reason, code) => {
      const routes = createEdgeServicesRoutes({
        resolveSession: vi.fn().mockResolvedValue(session()),
        countPending: vi.fn().mockResolvedValue(0),
        inspect: vi.fn().mockResolvedValue({ state: 'unavailable', reason }),
        updateSettings: vi.fn(),
      });
      const response = await routes.fetch(updateRequest('enabled'), env(true));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code },
      });
    },
  );

  it('requires manager, same-origin CSRF, and enabled mode for manual drain', async () => {
    const drain = vi.fn().mockResolvedValue({
      processedEvents: 2,
      remainingEvents: 1,
    });
    const denied = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      drain,
    });
    expect((await denied.fetch(
      mutation('/projections/drain', {}),
      env(true),
    )).status).toBe(403);

    const disabled = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readSettings: vi.fn().mockResolvedValue(document('disabled')),
      drain,
    });
    expect((await disabled.fetch(
      mutation('/projections/drain', {}),
      env(true),
    )).status).toBe(409);

    const enabled = createEdgeServicesRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readSettings: vi.fn().mockResolvedValue(document('enabled')),
      drain,
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
      now: () => NOW,
    });
    const response = await enabled.fetch(
      mutation('/projections/drain', {}),
      env(true),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { processed_events: 2, remaining_events: 1 },
    });
  });
});
