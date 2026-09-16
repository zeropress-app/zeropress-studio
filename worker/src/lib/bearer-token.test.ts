import { describe, expect, it } from 'vitest';
import {
  readBearerToken,
  secretTokensMatch,
} from './bearer-token';

const exactToken = 'exact-token-value-00000000000000000';

describe('Studio bearer secret token', () => {
  it('reads a case-insensitive Bearer scheme without normalizing the token', () => {
    expect(readBearerToken(`Bearer ${exactToken}`)).toBe(exactToken);
    expect(readBearerToken(`bearer ${exactToken}`)).toBe(exactToken);
    expect(readBearerToken(`Token ${exactToken}`)).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });

  it('rejects credentials outside the shared Worker-secret policy', () => {
    expect(readBearerToken('Bearer ')).toBeNull();
    expect(readBearerToken(`Bearer ${'x'.repeat(31)}`)).toBeNull();
    expect(readBearerToken(`Bearer ${'x'.repeat(257)}`)).toBeNull();
    expect(readBearerToken(`Bearer ${'x'.repeat(32)}\n`)).toBeNull();
    expect(readBearerToken(`Bearer ${'한'.repeat(32)}`)).toBeNull();
  });

  it('compares token digests without prefix or case matching', async () => {
    await expect(secretTokensMatch(exactToken, exactToken)).resolves.toBe(true);
    await expect(secretTokensMatch(exactToken, `${exactToken}-longer`))
      .resolves.toBe(false);
    await expect(secretTokensMatch(exactToken.toUpperCase(), exactToken))
      .resolves.toBe(false);
  });
});
