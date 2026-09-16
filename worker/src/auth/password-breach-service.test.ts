import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import {
  assessPasswordAcceptance,
  checkPasswordBreach,
} from './password-breach-service';

function environment(input: {
  cached?: Map<string, string>;
} = {}): Env {
  const cache = input.cached ?? new Map<string, string>();
  return {
    DB: {} as D1Database,
    KV: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
    } as unknown as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

async function sha1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

describe('password breach service', () => {
  it('uses only the bundled list in an offline runtime', async () => {
    const fetchFn = vi.fn();

    await expect(checkPasswordBreach({
      password: 'harbor lantern canyon marble circuit',
      env: environment(),
      fetchFn,
      hibpEnabled: false,
    })).resolves.toEqual({ status: 'clear', source: 'offline' });
    await expect(checkPasswordBreach({
      password: 'correct horse battery staple',
      env: environment(),
      fetchFn,
      hibpEnabled: false,
    })).resolves.toEqual({ status: 'hit', source: 'offline' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the HIBP range contract and caches a padded response', async () => {
    const password = 'range lookup regression password 2026';
    const digest = await sha1(password);
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      `${digest.slice(5)}:7\n00000000000000000000000000000000000:0`,
      { status: 200 },
    ));
    const env = environment();

    await expect(checkPasswordBreach({
      password,
      env,
      fetchFn,
      hibpEnabled: true,
    })).resolves.toEqual({ status: 'hit', source: 'hibp' });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'Add-Padding': 'true' }),
      }),
    );
    expect(env.KV.put).toHaveBeenCalledWith(
      `security:hibp:range:${digest.slice(0, 5)}`,
      expect.any(String),
      { expirationTtl: 86_400 },
    );
  });

  it('allows the local policy when HIBP is unavailable', async () => {
    const assessment = await assessPasswordAcceptance({
      password: 'harbor lantern canyon marble circuit',
      email: 'owner@example.com',
      displayName: 'Owner',
      env: environment(),
      checkBreach: vi.fn().mockResolvedValue({
        status: 'unavailable',
        source: 'hibp',
      }),
    });

    expect(assessment).toMatchObject({
      allowed: true,
      breach: { status: 'unavailable', source: 'hibp' },
    });
  });
});
