export const STUDIO_WORKER_SECRET_MIN_LENGTH = 32;
export const STUDIO_WORKER_SECRET_MAX_LENGTH = 256;

export const STUDIO_WORKER_SECRET_STATES = [
  'valid',
  'missing',
  'invalid',
] as const;

export type StudioWorkerSecretState =
  typeof STUDIO_WORKER_SECRET_STATES[number];

const PRINTABLE_ASCII_WITHOUT_SPACES = /^[\u0021-\u007e]+$/u;

/**
 * Worker secrets used at Studio infrastructure boundaries deliberately share
 * one copy/paste-safe format. Printable ASCII keeps JavaScript character,
 * UTF-8 byte, HTTP header ByteString, and operator-visible lengths identical.
 */
export function isValidStudioWorkerSecret(
  value: unknown,
): value is string {
  return typeof value === 'string'
    && value.length >= STUDIO_WORKER_SECRET_MIN_LENGTH
    && value.length <= STUDIO_WORKER_SECRET_MAX_LENGTH
    && PRINTABLE_ASCII_WITHOUT_SPACES.test(value);
}

export function resolveStudioWorkerSecretState(
  value: unknown,
): StudioWorkerSecretState {
  if (value === undefined) return 'missing';
  return isValidStudioWorkerSecret(value) ? 'valid' : 'invalid';
}
