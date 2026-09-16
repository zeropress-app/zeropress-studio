import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLogErrorType,
  logError,
  logInfo,
  logWarn,
} from './log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Studio operational logging', () => {
  it.each([
    ['error', logError],
    ['warn', logWarn],
    ['log', logInfo],
  ] as const)('writes %s logs using the ZeroPress structured envelope', (method, log) => {
    const consoleSpy = vi
      .spyOn(console, method)
      .mockImplementation(() => undefined);

    log('Database lifecycle check failed', {
      code: 'DATABASE_LIFECYCLE_CHECK_FAILED',
      reason: 'query_failed',
      omitted: undefined,
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Database lifecycle check failed',
      $zeropress: {
        code: 'DATABASE_LIFECYCLE_CHECK_FAILED',
        reason: 'query_failed',
      },
    });
  });

  it('omits the metadata envelope when no defined metadata remains', () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    logWarn('Maintenance mode is active', { mode: undefined });

    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Maintenance mode is active',
    });
  });

  it('classifies exceptions without serializing untrusted values', () => {
    const secret = 'private-sentinel-password-token-body';
    const error = new Error(secret, { cause: new Error(secret) });
    error.name = secret;
    expect(getLogErrorType(error)).toBe('Error');
    expect(getLogErrorType(new TypeError(secret))).toBe('TypeError');
    expect(getLogErrorType(new RangeError(secret))).toBe('RangeError');
    expect(getLogErrorType(new SyntaxError(secret))).toBe('SyntaxError');
    expect(getLogErrorType(secret)).toBe('NonError');
    expect(getLogErrorType({ toString: () => { throw new Error(secret); } })).toBe('NonError');
    expect(getLogErrorType(null)).toBe('NonError');
  });
});
