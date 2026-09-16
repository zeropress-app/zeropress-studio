const SESSION_COOKIE_VERSION = 's1';
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CSRF_DOMAIN = 'zeropress-studio:session-csrf:v1:';

type RandomBytes = (length: number) => Uint8Array;

export type ParsedSessionToken = {
  id: string;
  secret: string;
};

export type SessionTokenMaterial = ParsedSessionToken & {
  cookieValue: string;
  secretDigest: string;
  csrfToken: string;
};

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export async function digestSessionSecret(secret: string): Promise<string> {
  return bytesToHex(await sha256(secret));
}

export async function deriveSessionCsrfToken(
  secret: string,
): Promise<string> {
  return bytesToBase64Url(await sha256(`${CSRF_DOMAIN}${secret}`));
}

export async function createSessionTokenMaterial(
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<SessionTokenMaterial> {
  const id = bytesToHex(randomBytes(16));
  const secret = bytesToBase64Url(randomBytes(32));
  if (
    !SESSION_ID_PATTERN.test(id)
    || !SESSION_SECRET_PATTERN.test(secret)
  ) {
    throw new TypeError('Session token generator returned invalid bytes.');
  }

  return {
    id,
    secret,
    cookieValue: `${SESSION_COOKIE_VERSION}.${id}.${secret}`,
    secretDigest: await digestSessionSecret(secret),
    csrfToken: await deriveSessionCsrfToken(secret),
  };
}

export function parseSessionToken(
  value: string | undefined,
): ParsedSessionToken | null {
  if (!value) return null;
  const parts = value.split('.');
  if (
    parts.length !== 3
    || parts[0] !== SESSION_COOKIE_VERSION
    || !SESSION_ID_PATTERN.test(parts[1])
    || !SESSION_SECRET_PATTERN.test(parts[2])
  ) {
    return null;
  }
  return {
    id: parts[1],
    secret: parts[2],
  };
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
