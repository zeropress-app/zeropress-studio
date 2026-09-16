export const USER_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
export const USER_CREDENTIAL_RECOVERY_TTL_MS = 60 * 60 * 1000;

export type UserSetupTokenMaterial = {
  id: string;
  token: string;
  secretDigest: string;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function digestUserSetupSecret(
  secret: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  return toHex(new Uint8Array(digest));
}

export async function createUserSetupToken(): Promise<
  UserSetupTokenMaterial
> {
  const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const secret = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  return {
    id,
    token: `${id}.${secret}`,
    secretDigest: await digestUserSetupSecret(secret),
  };
}

export async function parseUserSetupToken(
  token: string,
): Promise<{ id: string; secretDigest: string } | null> {
  const match = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return null;
  return {
    id: match[1],
    secretDigest: await digestUserSetupSecret(match[2]),
  };
}

export function createUserSecurityRevision(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}
