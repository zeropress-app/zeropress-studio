import { describe, expect, it } from 'vitest';
import {
  databaseStatusSchema,
  operationsEntrySchema,
  systemStatusResponseSchema,
} from './system';

describe('system status contract', () => {
  it('accepts the installation state without operator secrets or messages', () => {
    expect(systemStatusResponseSchema.parse({
      success: true,
      data: {
        site_mode: 'initial',
        operations: { state: 'not_found' },
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: {
          state: 'installation',
        },
        installation_configuration: {
          site_mode: 'initial',
          auth_secret: 'valid',
          install_token: 'valid',
        },
      },
    })).toEqual({
      success: true,
      data: {
        site_mode: 'initial',
        operations: { state: 'not_found' },
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: {
          state: 'installation',
        },
        installation_configuration: {
          site_mode: 'initial',
          auth_secret: 'valid',
          install_token: 'valid',
        },
      },
    });
  });

  it('accepts all public database lifecycle discriminators', () => {
    const statuses = [
      { state: 'ready', schema_version: 1, target_schema_version: 1 },
      { state: 'upgrade_required', schema_version: 1, target_schema_version: 2 },
      { state: 'update_in_progress', schema_version: 1, target_schema_version: 2 },
      { state: 'recovery_required', schema_version: null, target_schema_version: 1 },
      { state: 'newer_than_code', schema_version: 2, target_schema_version: 1 },
      { state: 'unsupported', schema_version: 0, target_schema_version: 1 },
      { state: 'unmanaged' },
      { state: 'unavailable' },
    ];

    for (const status of statuses) {
      expect(databaseStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('accepts recovery mode as an explicit non-operational state', () => {
    expect(systemStatusResponseSchema.safeParse({
      success: true,
      data: {
        site_mode: 'recovery',
        operations: { state: 'available' },
        database: {
          state: 'ready',
          schema_version: 1,
          target_schema_version: 1,
        },
        access: { state: 'recovery' },
        installation_configuration: null,
      },
    }).success).toBe(true);
  });

  it('accepts a distinct operational uninstalled access reason', () => {
    expect(systemStatusResponseSchema.safeParse({
      success: true,
      data: {
        site_mode: 'operational',
        operations: { state: 'not_found' },
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: {
          state: 'blocked',
          reason: 'DATABASE_UNINSTALLED',
        },
        installation_configuration: null,
      },
    }).success).toBe(true);
  });

  it('accepts a distinct retained install-token configuration reason', () => {
    expect(systemStatusResponseSchema.safeParse({
      success: true,
      data: {
        site_mode: 'operational',
        operations: {
          state: 'setup_required',
          configuration: { allowed_ips: 'valid', token: 'missing' },
        },
        database: {
          state: 'ready',
          schema_version: 1,
          target_schema_version: 1,
        },
        access: {
          state: 'blocked',
          reason: 'INSTALL_TOKEN_STILL_CONFIGURED',
        },
        installation_configuration: null,
      },
    }).success).toBe(true);
  });

  it('rejects messages, unknown fields, and malformed state combinations', () => {
    expect(systemStatusResponseSchema.safeParse({
      success: true,
      data: {
        site_mode: 'operational',
        operations: { state: 'not_found' },
        database: {
          state: 'ready',
          schema_version: 1,
          target_schema_version: 1,
          tables: ['users'],
        },
        access: {
          state: 'operational',
          message: 'Ready',
        },
        installation_configuration: null,
      },
    }).success).toBe(false);

    expect(databaseStatusSchema.safeParse({
      state: 'ready',
      target_schema_version: 1,
    }).success).toBe(false);
  });
});

describe('public Operations entry contract', () => {
  it.each(['available', 'not_found'])(
    'accepts only the bounded %s state',
    (state) => {
      expect(operationsEntrySchema.parse({ state })).toEqual({ state });
    },
  );

  it('accepts bounded setup states only when a correction is required', () => {
    for (const allowed_ips of ['valid', 'missing', 'invalid']) {
      for (const token of ['valid', 'missing', 'invalid']) {
        expect(operationsEntrySchema.safeParse({
          state: 'setup_required',
          configuration: {
            allowed_ips, token,
            ...(allowed_ips === 'valid' ? {} : { client_ip: null }),
          },
        }).success).toBe(allowed_ips !== 'valid' || token !== 'valid');
      }
    }
  });

  it.each(['203.0.113.10', '2001:db8::1', '::1', null])(
    'accepts a bounded requester IP only for allowlist setup (%s)',
    (client_ip) => {
      for (const allowed_ips of ['missing', 'invalid']) {
        expect(operationsEntrySchema.safeParse({
          state: 'setup_required',
          configuration: { allowed_ips, token: 'valid', client_ip },
        }).success).toBe(true);
      }
    },
  );

  it('rejects invalid IPs, missing IP resolution, and disclosure outside allowlist setup', () => {
    for (const client_ip of ['not-an-ip', '', '192.0.2.999', '127.000.0.1', '192.0.2.1/24', '127.0.0.1,::1', '<script>', undefined]) {
      expect(operationsEntrySchema.safeParse({
        state: 'setup_required',
        configuration: { allowed_ips: 'missing', token: 'valid', client_ip },
      }).success).toBe(false);
    }
    for (const client_ip of ['203.0.113.10', null]) {
      expect(operationsEntrySchema.safeParse({
        state: 'setup_required',
        configuration: { allowed_ips: 'valid', token: 'missing', client_ip },
      }).success).toBe(false);
      for (const state of ['available', 'not_found']) {
        expect(operationsEntrySchema.safeParse({ state, client_ip }).success).toBe(false);
      }
    }
  });

  it('rejects missing state, auth claims, allowlists, credentials, and diagnostics', () => {
    for (const value of [
      {},
      { state: 'authenticated' },
      { state: 'available', token: 'secret' },
      { state: 'available', allowed_ips: ['127.0.0.1'] },
      { state: 'not_found', current_ip: '127.0.0.1' },
      { state: 'configuration_error', reason: 'token_missing' },
      { state: 'setup_required' },
      { state: 'setup_required', configuration: { allowed_ips: ['127.0.0.1'], token: 'missing' } },
      { state: 'setup_required', configuration: { allowed_ips: 'valid', token: 'actual-secret' } },
      { state: 'setup_required', configuration: { allowed_ips: 'valid', token: 'invalid', reason: 'token_too_short' } },
      { state: 'not_found', configuration: { allowed_ips: 'valid', token: 'missing' } },
      { state: 'available', configuration: { allowed_ips: 'valid', token: 'valid' } },
    ]) {
      expect(operationsEntrySchema.safeParse(value).success).toBe(false);
    }
  });
});
