import { describe, expect, it } from 'vitest';
import {
  createUserSetupToken,
  parseUserSetupToken,
} from './setup-token-crypto';

describe('user setup token crypto', () => {
  it('creates a high-entropy token while exposing only its digest for D1', async () => {
    const material = await createUserSetupToken();
    expect(material.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(material.token).toMatch(
      /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/u,
    );
    expect(material.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(parseUserSetupToken(material.token)).resolves.toEqual({
      id: material.id,
      secretDigest: material.secretDigest,
    });
    expect(material.token).not.toContain(material.secretDigest);
  });

  it('rejects malformed setup values before hashing them', async () => {
    await expect(parseUserSetupToken('invalid')).resolves.toBeNull();
  });
});
