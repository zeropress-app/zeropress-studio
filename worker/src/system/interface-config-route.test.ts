import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { createSystemRoutes } from './routes';

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

describe('public Studio interface config route', () => {
  it('returns only the enabled/default locale policy without authentication', async () => {
    const readInterfaceSettings = vi.fn().mockResolvedValue({
      settings: {
        default_locale: 'ko',
        enabled_locales: ['ko'],
      },
      revision: '1'.repeat(32),
      updated_at_iso: '2026-08-10T03:00:00.000Z',
    });
    const routes = createSystemRoutes({ readInterfaceSettings });

    const response = await routes.fetch(
      new Request('https://studio.local/interface-config'),
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        default_locale: 'ko',
        enabled_locales: ['ko'],
      },
    });
    expect(readInterfaceSettings).toHaveBeenCalledWith({
      db: expect.anything(),
    });
  });
});
