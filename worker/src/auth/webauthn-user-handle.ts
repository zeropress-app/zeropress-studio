import { isoBase64URL } from '@simplewebauthn/server/helpers';

const USER_ID_PATTERN = /^[0-9a-f]{32}$/u;

export function opaqueWebAuthnUserIdBytes(
  userId: string,
): Uint8Array<ArrayBuffer> {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new TypeError('WebAuthn user ID must be 32 lowercase hex characters.');
  }
  const bytes = new Uint8Array(new ArrayBuffer(userId.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      userId.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

export function matchesWebAuthnUserHandle(
  userId: string,
  userHandle: string,
): boolean {
  let actual: Uint8Array;
  try {
    actual = isoBase64URL.toBuffer(userHandle);
  } catch {
    return false;
  }
  const expected = opaqueWebAuthnUserIdBytes(userId);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}
