import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, StudioHonoEnvironment } from '../types';
import { requireEdgeIntegrationReady } from './edge-integration-gate';

function app(input: {
  mode?: 'enabled' | 'disabled';
  runtime?: 'ready' | 'upgrade_required' | 'recovery_required' | 'unavailable';
}) {
  const routes = new Hono<StudioHonoEnvironment>();
  const inspect = vi.fn().mockResolvedValue({
    state: input.runtime ?? 'ready',
    reason: input.runtime === 'unavailable' ? 'query_failed' : 'ready',
    currentSchemaVersion: input.runtime === 'upgrade_required' ? 1 : 2,
  });
  routes.get('/', async (c) => (
    await requireEdgeIntegrationReady(
      c,
      vi.fn().mockResolvedValue(input.mode ?? 'enabled'),
      inspect,
    ) ?? c.json({ success: true })
  ));
  return { routes, inspect };
}

const env = {
  DB: {} as D1Database,
  EDGE_DB: {} as D1Database,
  KV: {} as KVNamespace,
  AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
} satisfies Env;

afterEach(() => vi.restoreAllMocks());

describe('Edge-backed API gate', () => {
  it('does not inspect Edge DB when Studio management is disabled', async () => {
    const { routes, inspect } = app({ mode: 'disabled' });
    const response = await routes.fetch(new Request('https://studio.local/'), env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false, error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['ready', 200, null],
    ['upgrade_required', 409, 'EDGE_DATABASE_UPGRADE_REQUIRED'],
    ['recovery_required', 409, 'EDGE_DATABASE_RECOVERY_REQUIRED'],
  ] as const)('maps %s before the product repository runs', async (
    runtime,
    expectedStatus,
    expectedCode,
  ) => {
    const { routes } = app({ runtime });
    const response = await routes.fetch(new Request('https://studio.local/'), env);
    expect(response.status).toBe(expectedStatus);
    if (expectedCode) {
      await expect(response.json()).resolves.toEqual({
        success: false, error: { code: expectedCode },
      });
    }
  });

  it('returns a bounded unavailable response and operational event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { routes } = app({ runtime: 'unavailable' });
    const response = await routes.fetch(new Request('https://studio.local/'), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false, error: { code: 'EDGE_INTEGRATION_UNAVAILABLE' },
    });
    expect(error).toHaveBeenCalledOnce();
  });
});
