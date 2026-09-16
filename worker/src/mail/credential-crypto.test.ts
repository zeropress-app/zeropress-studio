import { describe, expect, it } from 'vitest';
import {
  decryptMailCredential,
  encryptMailCredential,
} from './credential-crypto';

const AUTH_SECRET = 'test-auth-secret-value-with-at-least-32-characters';

describe('mail credential encryption', () => {
  it('round-trips a provider credential without storing plaintext', async () => {
    const encrypted = await encryptMailCredential({
      authSecret: AUTH_SECRET,
      kind: 'resend_api_key',
      value: 're_secret-value',
    });
    expect(JSON.stringify(encrypted)).not.toContain('secret-value');
    await expect(decryptMailCredential({
      authSecret: AUTH_SECRET,
      kind: 'resend_api_key',
      encrypted,
    })).resolves.toBe('re_secret-value');
  });

  it('binds ciphertext to its provider credential kind', async () => {
    const encrypted = await encryptMailCredential({
      authSecret: AUTH_SECRET,
      kind: 'resend_api_key',
      value: 're_secret-value',
    });
    await expect(decryptMailCredential({
      authSecret: AUTH_SECRET,
      kind: 'cloudflare_api_token',
      encrypted,
    })).rejects.toMatchObject({ code: 'MAIL_CREDENTIAL_CRYPTO_FAILED' });
  });
});
