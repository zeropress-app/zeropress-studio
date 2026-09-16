import { describe, expect, it } from 'vitest';
import {
  createSessionTokenMaterial,
  deriveSessionCsrfToken,
  digestSessionSecret,
  parseSessionToken,
  timingSafeEqual,
} from './session-crypto';

describe('session cryptography', () => {
  it('creates a versioned opaque token and stores only its digest', async () => {
    const material = await createSessionTokenMaterial((length) =>
      Uint8Array.from({ length }, (_, index) => index + 1)
    );

    expect(material.id).toBe('0102030405060708090a0b0c0d0e0f10');
    expect(material.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.cookieValue).toBe(
      `s1.${material.id}.${material.secret}`,
    );
    expect(material.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(material.secretDigest).not.toContain(material.secret);
    expect(material.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(parseSessionToken(material.cookieValue)).toEqual({
      id: material.id,
      secret: material.secret,
    });
  });

  it('derives stable domain-separated values and compares them safely', async () => {
    const secret = 's'.repeat(43);
    expect(await digestSessionSecret(secret)).toBe(
      await digestSessionSecret(secret),
    );
    expect(await deriveSessionCsrfToken(secret)).not.toBe(
      await digestSessionSecret(secret),
    );
    expect(timingSafeEqual('same', 'same')).toBe(true);
    expect(timingSafeEqual('same', 'diff')).toBe(false);
    expect(timingSafeEqual('short', 'longer')).toBe(false);
  });

  it('rejects malformed or legacy cookie values', () => {
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken('')).toBeNull();
    expect(parseSessionToken(`s0.${'a'.repeat(32)}.${'s'.repeat(43)}`))
      .toBeNull();
    expect(parseSessionToken(`s1.${'a'.repeat(31)}.${'s'.repeat(43)}`))
      .toBeNull();
    expect(parseSessionToken(`s1.${'a'.repeat(32)}.${'s'.repeat(42)}!`))
      .toBeNull();
  });
});
