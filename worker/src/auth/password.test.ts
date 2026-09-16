import { afterEach, describe, expect, it, vi } from 'vitest';
import { DUMMY_PASSWORD_HASH } from './authenticate';
import { hashPassword, verifyPassword } from './password';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Argon2id password compatibility', () => {
  it('verifies hashes produced with the existing Studio parameters', async () => {
    const password = 'a123456789123456789@';
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword('incorrect-password', hash)).resolves.toBe(false);
  });

  it('treats the synthetic timing hash as a valid non-match', async () => {
    await expect(verifyPassword('any-password', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('records incompatible stored hashes as structured operational failures', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(verifyPassword('any-password', 'not-an-argon2id-hash')).resolves.toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio password verification is unavailable',
      $zeropress: {
        code: 'PASSWORD_VERIFICATION_NOT_AVAILABLE',
        component: 'argon2id',
        action: 'verify_password',
        errorType: expect.any(String),
        guidance: 'Verify that users.password_hash contains a compatible Argon2id PHC string and confirm the deployed Worker includes the Argon2id WASM assets.',
      },
    });
  });
});
