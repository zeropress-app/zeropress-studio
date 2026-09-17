import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOperationsIpAllowed,
  resolveOperationsConfiguration,
  synchronizeOperationsConfigurationIncident,
} from './access';
import { resetSystemIncidentDeduplicationForTests } from '../system/system-incident';
import type { Env } from '../types';

const strongToken = 'o'.repeat(32);

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'maintenance',
    STUDIO_OPERATIONS_ALLOWED_IPS: '127.0.0.1,2001:db8::1',
    STUDIO_OPERATIONS_TOKEN: strongToken,
    ...overrides,
  };
}

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

describe('Maintenance and Recovery access configuration', () => {
  it('is disabled when the exact-IP allowlist is not configured', () => {
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_ALLOWED_IPS: undefined,
    }))).toEqual({ state: 'disabled', tokenState: 'valid' });
  });

  it('normalizes and deduplicates exact IPv4 and IPv6 entries', () => {
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_ALLOWED_IPS:
        '127.0.0.1, 2001:0DB8::1,2001:db8::1',
    }))).toEqual({
      state: 'ready',
      allowedIps: ['127.0.0.1', '2001:db8::1'],
      token: strongToken,
    });
  });

  it('fails closed for an empty allowlist or weak token', () => {
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_ALLOWED_IPS: '',
    }))).toEqual({
      state: 'invalid',
      reason: 'allowed_ips_empty',
      allowedIps: null,
      tokenState: 'valid',
    });
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_ALLOWED_IPS: '127.0.0.1,not-an-ip',
    }))).toEqual({
      state: 'invalid',
      reason: 'allowed_ip_invalid',
      allowedIps: null,
      tokenState: 'valid',
    });
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_TOKEN: 'too-short',
    }))).toEqual({
      state: 'invalid',
      reason: 'token_too_short',
      allowedIps: ['127.0.0.1', '2001:db8::1'],
      tokenState: 'invalid',
    });
    for (const token of [
      'x'.repeat(257),
      '한'.repeat(32),
      `${'x'.repeat(16)} ${'x'.repeat(16)}`,
      `${'x'.repeat(32)}\n`,
    ]) {
      expect(resolveOperationsConfiguration(env({
        STUDIO_OPERATIONS_TOKEN: token,
      }))).toEqual({
        state: 'invalid',
        reason: 'token_invalid',
        allowedIps: ['127.0.0.1', '2001:db8::1'],
        tokenState: 'invalid',
      });
    }
    expect(resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_TOKEN: 'x'.repeat(256),
    }))).toMatchObject({ state: 'ready' });
  });

  it('matches only a normalized exact address', () => {
    const configuration = resolveOperationsConfiguration(env());
    expect(configuration.state).toBe('ready');
    if (configuration.state !== 'ready') return;

    expect(isOperationsIpAllowed(configuration, '127.0.0.1')).toBe(true);
    expect(isOperationsIpAllowed(configuration, '127.0.0.2')).toBe(false);
    expect(isOperationsIpAllowed(configuration, null)).toBe(false);
  });

  it('deduplicates invalid configuration diagnostics without logging values', () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const configuration = resolveOperationsConfiguration(env({
      STUDIO_OPERATIONS_ALLOWED_IPS: 'private-value-that-must-not-be-logged',
    }));

    synchronizeOperationsConfigurationIncident(configuration);
    synchronizeOperationsConfigurationIncident(configuration);

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'private-value-that-must-not-be-logged',
    );
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Maintenance and Recovery configuration is invalid',
      $zeropress: {
        code: 'OPERATIONS_CONFIGURATION_INVALID',
        component: 'worker_configuration',
        action: 'resolve_operations_access',
        reason: 'allowed_ip_invalid',
        guidance: expect.any(String),
      },
    });
  });
});
