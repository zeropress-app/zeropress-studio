import { describe, expect, it } from 'vitest';
import { resolveWebAuthnRequestContext } from './webauthn-origin';

describe('WebAuthn request context', () => {
  it('binds production credentials to the exact HTTPS hostname', () => {
    expect(resolveWebAuthnRequestContext(
      'https://Studio.Example.com:8443/api/auth/mfa/webauthn/options',
    )).toEqual({
      origin: 'https://studio.example.com:8443',
      rpId: 'studio.example.com',
    });
  });

  it('allows HTTP only for local loopback development', () => {
    expect(resolveWebAuthnRequestContext(
      'http://localhost:5173/api/auth/mfa/webauthn/options',
    )).toEqual({
      origin: 'http://localhost:5173',
      rpId: 'localhost',
    });
    expect(resolveWebAuthnRequestContext(
      'http://127.0.0.1:8787/api/auth/mfa/webauthn/options',
    )).toEqual({
      origin: 'http://127.0.0.1:8787',
      rpId: '127.0.0.1',
    });
    expect(resolveWebAuthnRequestContext(
      'http://[::1]:8787/api/auth/mfa/webauthn/options',
    )).toEqual({
      origin: 'http://[::1]:8787',
      rpId: '::1',
    });
    expect(resolveWebAuthnRequestContext(
      'http://studio.example.com/api/auth/mfa/webauthn/options',
    )).toBeNull();
  });

  it('rejects non-HTTP origins and malformed URLs', () => {
    expect(resolveWebAuthnRequestContext('not a url')).toBeNull();
    expect(resolveWebAuthnRequestContext(
      'ftp://studio.example.com/file',
    )).toBeNull();
  });
});
