const WORKER_SECRET_BYTE_LENGTH = 32;

/**
 * Generates a 256-bit candidate for a Studio Worker secret.
 *
 * Hex keeps the result inside Studio's strict printable-ASCII policy without
 * padding, whitespace, or characters that are awkward to copy between shells
 * and the Cloudflare dashboard. The value remains in the calling browser; this
 * helper performs no persistence or network I/O.
 */
export function generateWorkerSecretCandidate(
  randomSource: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto,
): string {
  if (!randomSource) {
    throw new Error('Web Crypto is unavailable.');
  }

  const bytes = new Uint8Array(WORKER_SECRET_BYTE_LENGTH);
  randomSource.getRandomValues(bytes);
  return Array.from(
    bytes,
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
}
