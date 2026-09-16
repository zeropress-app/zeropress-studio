import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resetCloudflareAccessJwksCacheForTests,
  verifyCloudflareAccessAssertion,
} from './assertion-verifier';

const ISSUER = 'https://zeropress.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const ORIGIN = 'https://studio.example.com';
const NOW = new Date('2026-08-28T00:00:00.000Z');
const KID = 'test-key';
let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = {
    ...await exportJWK(keys.publicKey),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };
});

afterEach(() => {
  resetCloudflareAccessJwksCacheForTests();
  vi.unstubAllGlobals();
});

async function assertion(input: {
  audience?: string;
  issuer?: string;
  type?: string;
  email?: string;
  key?: CryptoKey;
} = {}) {
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  return new SignJWT({
    type: input.type ?? 'app',
    email: input.email ?? 'admin@example.com',
    aud: [input.audience ?? AUDIENCE],
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(input.issuer ?? ISSUER)
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds - 5)
    .setExpirationTime(nowSeconds + 300)
    .sign(input.key ?? privateKey);
}

function installJwksFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    keys: [publicJwk],
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(JSON.stringify({ keys: [publicJwk] }).length),
    },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Cloudflare Access assertion verifier', () => {
  it('does not contact JWKS for an absent or malformed assertion', async () => {
    const fetchMock = installJwksFetch();
    await expect(verifyCloudflareAccessAssertion({
      assertion: undefined,
      origin: ORIGIN,
      now: NOW,
    })).resolves.toEqual({ state: 'missing' });
    await expect(verifyCloudflareAccessAssertion({
      assertion: 'not-a-jwt',
      origin: ORIGIN,
      now: NOW,
    })).resolves.toEqual({ state: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies signature, app type, issuer, audience, and current identity', async () => {
    const fetchMock = installJwksFetch();
    await expect(verifyCloudflareAccessAssertion({
      assertion: await assertion(),
      origin: ORIGIN,
      now: NOW,
    })).resolves.toEqual({
      state: 'verified',
      identity: {
        issuer: ISSUER,
        team_domain: 'zeropress',
        audience: AUDIENCE,
        identity_email: 'admin@example.com',
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `${ISSUER}/cdn-cgi/access/certs`,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects a stored-origin mismatch before contacting JWKS', async () => {
    const fetchMock = installJwksFetch();
    await expect(verifyCloudflareAccessAssertion({
      assertion: await assertion(),
      origin: 'https://other.example.com',
      expected: {
        mode: 'required',
        issuer: ISSUER,
        audience: AUDIENCE,
        bound_origin: ORIGIN,
        verified_at_iso: NOW.toISOString(),
      },
      now: NOW,
    })).resolves.toEqual({ state: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('distinguishes an invalid signature from JWKS unavailability', async () => {
    installJwksFetch();
    const otherKeys = await generateKeyPair('RS256');
    await expect(verifyCloudflareAccessAssertion({
      assertion: await assertion({ key: otherKeys.privateKey }),
      origin: ORIGIN,
      now: NOW,
    })).resolves.toEqual({ state: 'invalid' });

    resetCloudflareAccessJwksCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(verifyCloudflareAccessAssertion({
      assertion: await assertion(),
      origin: ORIGIN,
      now: NOW,
    })).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('rejects an oversized streamed JWKS response without trusting its headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Uint8Array(256 * 1024 + 1),
      { headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(verifyCloudflareAccessAssertion({
      assertion: await assertion(),
      origin: ORIGIN,
      now: NOW,
    })).resolves.toMatchObject({ state: 'unavailable' });
  });
});
