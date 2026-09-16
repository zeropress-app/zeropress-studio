import { describe, expect, it, vi } from 'vitest';
import { createPasswordBreachRoutes } from './password-breach-routes';
import type { Env } from '../types';

function environment(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

describe('password breach check route', () => {
  it('checks a password within the same-origin rate-limit boundary', async () => {
    const checkBreach = vi.fn().mockResolvedValue({
      status: 'clear',
      source: 'offline',
    });
    const env = environment();
    const response = await createPasswordBreachRoutes({ checkBreach }).fetch(
      new Request('https://studio.example/check', {
        method: 'POST',
        headers: {
          Origin: 'https://studio.example',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.10',
        },
        body: JSON.stringify({
          password: 'harbor lantern canyon marble circuit',
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: 'clear', source: 'offline' },
    });
    expect(env.AUTH_ROUTE_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: 'password-check:203.0.113.10',
    });
    expect(checkBreach).toHaveBeenCalledWith({
      password: 'harbor lantern canyon marble circuit',
      env,
    });
  });

  it('rejects cross-origin checks before consuming the limiter', async () => {
    const env = environment();
    const response = await createPasswordBreachRoutes().fetch(
      new Request('https://studio.example/check', {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: 'x'.repeat(20) }),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(env.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });
});
