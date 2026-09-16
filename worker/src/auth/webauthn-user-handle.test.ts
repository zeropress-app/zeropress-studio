import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { describe, expect, it } from 'vitest';
import {
  matchesWebAuthnUserHandle,
  opaqueWebAuthnUserIdBytes,
} from './webauthn-user-handle';

describe('WebAuthn opaque user handles', () => {
  it('round-trips an internal opaque user ID without exposing PII', () => {
    const userId = '0123456789abcdef0123456789abcdef';
    const handle = isoBase64URL.fromBuffer(opaqueWebAuthnUserIdBytes(userId));

    expect(handle).toBe('ASNFZ4mrze8BI0VniavN7w');
    expect(matchesWebAuthnUserHandle(userId, handle)).toBe(true);
    expect(matchesWebAuthnUserHandle('f'.repeat(32), handle)).toBe(false);
  });

  it('rejects malformed IDs and handles', () => {
    expect(() => opaqueWebAuthnUserIdBytes('owner@example.com'))
      .toThrow(/32 lowercase hex/u);
    expect(matchesWebAuthnUserHandle('0'.repeat(32), 'not+base64url'))
      .toBe(false);
    expect(matchesWebAuthnUserHandle('0'.repeat(32), 'AA'))
      .toBe(false);
  });
});
