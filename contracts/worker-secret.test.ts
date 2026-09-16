import { describe, expect, it } from 'vitest';
import {
  isValidStudioWorkerSecret,
  resolveStudioWorkerSecretState,
  STUDIO_WORKER_SECRET_MAX_LENGTH,
  STUDIO_WORKER_SECRET_MIN_LENGTH,
} from './worker-secret';

describe('Studio Worker secret policy', () => {
  it('accepts the inclusive 32–256 character boundaries', () => {
    expect(isValidStudioWorkerSecret(
      'x'.repeat(STUDIO_WORKER_SECRET_MIN_LENGTH),
    )).toBe(true);
    expect(isValidStudioWorkerSecret(
      'x'.repeat(STUDIO_WORKER_SECRET_MAX_LENGTH),
    )).toBe(true);
  });

  it('rejects values outside the length boundary', () => {
    expect(isValidStudioWorkerSecret(undefined)).toBe(false);
    expect(isValidStudioWorkerSecret('')).toBe(false);
    expect(isValidStudioWorkerSecret(
      'x'.repeat(STUDIO_WORKER_SECRET_MIN_LENGTH - 1),
    )).toBe(false);
    expect(isValidStudioWorkerSecret(
      'x'.repeat(STUDIO_WORKER_SECRET_MAX_LENGTH + 1),
    )).toBe(false);
  });

  it('allows printable ASCII punctuation without allowing whitespace', () => {
    expect(isValidStudioWorkerSecret(
      '!"#$%&\'()*+,-./0123456789:;<=>?@[]^_`{|}~ABCxyz',
    )).toBe(true);
    expect(isValidStudioWorkerSecret(`${'x'.repeat(31)} `)).toBe(false);
    expect(isValidStudioWorkerSecret(`${'x'.repeat(16)} ${'x'.repeat(16)}`))
      .toBe(false);
    expect(isValidStudioWorkerSecret(`${'x'.repeat(32)}\n`)).toBe(false);
    expect(isValidStudioWorkerSecret(`${'x'.repeat(32)}\u007f`)).toBe(false);
  });

  it('rejects non-ASCII text even when its JavaScript length is sufficient', () => {
    expect(isValidStudioWorkerSecret('한'.repeat(32))).toBe(false);
    expect(isValidStudioWorkerSecret('🔐'.repeat(32))).toBe(false);
  });

  it('distinguishes an absent binding from a configured invalid value', () => {
    expect(resolveStudioWorkerSecretState(undefined)).toBe('missing');
    expect(resolveStudioWorkerSecretState('')).toBe('invalid');
    expect(resolveStudioWorkerSecretState('한'.repeat(32))).toBe('invalid');
    expect(resolveStudioWorkerSecretState('x'.repeat(32))).toBe('valid');
  });
});
