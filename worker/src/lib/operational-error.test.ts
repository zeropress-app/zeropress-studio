import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  logOperationalFailure,
  logStudioOperationalError,
  OPERATIONAL_LOG_DEFINITIONS,
  StudioOperationalError,
} from './operational-error';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Studio operational errors', () => {
  it('keeps every runtime definition synchronized with the operator catalog', () => {
    const catalog = readFileSync(
      new URL('../../../docs/operational-log-catalog.md', import.meta.url),
      'utf8',
    );
    const documentedCodes = [...catalog.matchAll(/^## `([A-Z0-9_]+)`$/gm)]
      .map((match) => match[1]);

    expect(documentedCodes).toEqual(Object.keys(OPERATIONAL_LOG_DEFINITIONS));

    for (const [code, definition] of Object.entries(OPERATIONAL_LOG_DEFINITIONS)) {
      expect(catalog).toContain(`## \`${code}\``);
      expect(catalog).toContain(`- Level: \`${definition.level}\``);
      expect(catalog).toContain(`- Message: \`${definition.message}\``);
      if ('guidance' in definition) {
        expect(catalog).toContain(`- Guidance: \`${definition.guidance}\``);
      }
    }
  });

  it('uses the catalog definition and preserves safe operational context', () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const cause = new Error('D1_ERROR: no such table: users');
    const error = new StudioOperationalError('AUTH_DATABASE_QUERY_FAILED', {
      cause,
      metadata: {
        resource: 'DB',
        action: 'authenticate_credentials',
        code: 'CALLER_CANNOT_OVERRIDE_CODE',
        guidance: 'Caller cannot override guidance.',
        errorMessage: 'private-sentinel',
        errorType: 'private-sentinel',
      },
    });

    logStudioOperationalError(error, {
      method: 'POST',
      pathname: '/api/auth/login',
    });

    expect(error.message).toBe(
      OPERATIONAL_LOG_DEFINITIONS.AUTH_DATABASE_QUERY_FAILED.message,
    );
    expect(error.cause).toBe(cause);
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio authentication database query failed',
      $zeropress: {
        code: 'AUTH_DATABASE_QUERY_FAILED',
        resource: 'DB',
        action: 'authenticate_credentials',
        method: 'POST',
        pathname: '/api/auth/login',
        errorType: 'Error',
        guidance: 'Verify the DB binding targets the Studio database. If the database is uninstalled, set STUDIO_SITE_MODE to initial and complete installation; otherwise verify its schema lifecycle state.',
      },
    });
  });

  it('does not invent operator guidance for an unclassified failure', () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    logOperationalFailure('UNHANDLED_STUDIO_API_ERROR', {
      cause: new TypeError('Unexpected implementation failure'),
      metadata: {
        method: 'GET',
        pathname: '/api/example',
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Unhandled Studio API error',
      $zeropress: {
        code: 'UNHANDLED_STUDIO_API_ERROR',
        method: 'GET',
        pathname: '/api/example',
        errorType: 'TypeError',
      },
    });
  });

  it('never emits exception payloads through any catalog entry', () => {
    const secret = 'PRIVATE_SENTINEL_password_totp_cookie_provider_key_body';
    const outputs: unknown[] = [];
    for (const method of ['error', 'warn', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((value) => outputs.push(value));
    }
    for (const code of Object.keys(OPERATIONAL_LOG_DEFINITIONS) as Array<keyof typeof OPERATIONAL_LOG_DEFINITIONS>) {
      const cause = new Error(secret, { cause: new Error(secret) });
      cause.name = secret;
      logOperationalFailure(code, { cause });
    }
    expect(outputs).toHaveLength(Object.keys(OPERATIONAL_LOG_DEFINITIONS).length);
    expect(JSON.stringify(outputs)).not.toContain(secret);
    expect(outputs.every((value) => (value as { $zeropress: { errorType: string } }).$zeropress.errorType === 'Error')).toBe(true);
  });
});
