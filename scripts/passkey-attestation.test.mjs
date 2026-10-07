import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { evaluatePasskeyRegistration } from '../worker/src/auth/passkey-metadata.ts';
import { generateMetadata } from './passkey-metadata.mjs';
import { AAGUID, certificates, payload, registration, revocationList } from './test-helpers/fido.mjs';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function metadata(chain, change = () => {}) {
  const data = payload();
  data.entries[0].metadataStatement.attestationRootCertificates = [chain.r46.toString('base64')]; change(data.entries[0]);
  return generateMetadata({ payload: data, blobHash: 'a'.repeat(64), evaluatedAtIso: '2026-10-01T00:00:00.000Z', names: {}, namesCommit: 'b'.repeat(40) }).worker;
}
async function verified(fixture) {
  const result = await verifyRegistrationResponse({ response: fixture.response, expectedChallenge: fixture.challenge, expectedOrigin: fixture.origin,
    expectedRPID: fixture.rpId, requireUserVerification: true, requireUserPresence: true });
  expect(result.verified).toBe(true);
  return { response: fixture.response, registration: result.registrationInfo };
}
describe('attestation proof, independently of model certification', () => {
  it('accepts a signed packed registration only when its chain belongs to the certified model', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external call'); }));
    const chain = await certificates(); const input = await verified(await registration(chain));
    expect(await evaluatePasskeyRegistration(input, { metadata: metadata(chain) })).toMatchObject({ proof: { state: 'verified', reason: 'verified' }, rejection: null });
    const wrongChain = await certificates();
    expect(await evaluatePasskeyRegistration(input, { metadata: metadata(wrongChain) })).toMatchObject({ proof: { state: 'unverified' }, rejection: 'attestation_unverified' });
    expect(await evaluatePasskeyRegistration({ ...input, registration: { ...input.registration, aaguid: 'aaaaaaaa-2222-4333-8444-555555555555' } }, { metadata: metadata(chain) })).toMatchObject({ proof: { reason: 'trust_not_verified' } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects certified self-attestation (including the Windows Hello case), none, and empty trust roots', async () => {
    const chain = await certificates();
    const self = await verified(await registration(chain, { self: true }));
    expect(await evaluatePasskeyRegistration(self, { metadata: metadata(chain) })).toMatchObject({ proof: { reason: 'self_attestation' }, rejection: 'attestation_unverified' });
    const none = await verified(await registration(chain, { none: true }));
    expect(await evaluatePasskeyRegistration(none, { metadata: metadata(chain) })).toMatchObject({ proof: { reason: 'no_attestation' }, rejection: 'attestation_unverified' });
    const input = await verified(await registration(chain));
    expect(await evaluatePasskeyRegistration(input, { metadata: metadata(chain, (entry) => { entry.metadataStatement.attestationRootCertificates = []; }) })).toMatchObject({ proof: { reason: 'trust_roots_missing' } });
    const unknown = metadata(chain); delete unknown.models[AAGUID]; delete unknown.statements[AAGUID];
    expect(await evaluatePasskeyRegistration(none, { metadata: unknown })).toMatchObject({ rejection: 'metadata_missing' });
  });
  it.each([false, true])('verifies an unchanged attestation chain after trust-root sorting (includes root: %s)', async (includeRoot) => {
    const chain = await certificates(); const unrelated = await certificates();
    const fixture = await registration(chain, { includeRoot });
    const response = structuredClone(fixture.response);
    const input = await verified(fixture);
    const roots = [unrelated.root.toString('base64'), chain.r46.toString('base64')];
    const first = metadata(chain, (entry) => { entry.metadataStatement.attestationRootCertificates = roots; });
    const second = metadata(chain, (entry) => { entry.metadataStatement.attestationRootCertificates = roots.toReversed(); });
    expect(first).toEqual(second);
    expect(await evaluatePasskeyRegistration(input, { metadata: first })).toMatchObject({ proof: { state: 'verified' }, rejection: null });
    expect(fixture.response).toEqual(response);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes certification, unresolved security incidents and service failures without a live MDS request', async () => {
    const chain = await certificates(); const input = await verified(await registration(chain));
    for (const status of ['NOT_FIDO_CERTIFIED', 'SELF_ASSERTION_SUBMITTED', 'FIPS_CERTIFIED']) {
      const m = metadata(chain, (entry) => { entry.statusReports = [{ status }]; });
      expect((await evaluatePasskeyRegistration(input, { metadata: m })).rejection).toBe(status === 'FIPS_CERTIFIED' ? 'metadata_missing' : 'not_certified');
    }
    for (const status of ['REVOKED', 'ATTESTATION_KEY_COMPROMISE', 'USER_VERIFICATION_BYPASS', 'USER_KEY_REMOTE_COMPROMISE', 'USER_KEY_PHYSICAL_COMPROMISE']) {
      const m = metadata(chain, (entry) => entry.statusReports.push({ status, authenticatorVersion: 1 }, { status: 'UPDATE_AVAILABLE' }));
      expect((await evaluatePasskeyRegistration(input, { metadata: m })).rejection).toBe('security_status');
    }
    expect(await evaluatePasskeyRegistration(input, { metadata: metadata(chain), validatePath: async () => { throw new TypeError('service unavailable'); } })).toMatchObject({ rejection: 'verification_unavailable' });
  });
  it('freezes future MDS reports and nextUpdate while still enforcing actual certificate expiry', async () => {
    const chain = await certificates(); const input = await verified(await registration(chain));
    const m = metadata(chain, (entry) => entry.statusReports.push({ status: 'REVOKED', effectiveDate: '2027-01-01' }));
    vi.useFakeTimers(); vi.setSystemTime(new Date('2028-01-01'));
    expect((await evaluatePasskeyRegistration(input, { metadata: m })).rejection).toBe(null);
    vi.setSystemTime(new Date('2100-01-01'));
    expect((await evaluatePasskeyRegistration(input, { metadata: m })).rejection).toBe('attestation_unverified');
    await expect(verified(await registration(chain))).rejects.toThrow();
  });
});

it('rejects a certificate whose revocation is confirmed by a signed CRL', async () => {
  const chain = await certificates({ crlUrl: 'https://crl.example.test/authenticator.crl' });
  const input = await verified(await registration(chain));
  const crl = await revocationList(chain);
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    expect(url).toBe('https://crl.example.test/authenticator.crl');
    return new Response(crl.rawData);
  }));
  expect((await evaluatePasskeyRegistration(input, { metadata: metadata(chain) })).rejection).toBe('attestation_unverified');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('accepts an identical bundled root sent at the end of x5c without trusting arbitrary roots', async () => {
  const chain = await certificates();
  const input = await verified(await registration(chain, { includeRoot: true }));
  expect((await evaluatePasskeyRegistration(input, { metadata: metadata(chain) })).rejection).toBe(null);
});
it('only excludes a certificate-scoped incident when the verified chain is demonstrably unaffected', async () => {
  const chain = await certificates(); const input = await verified(await registration(chain));
  const other = await certificates();
  const scoped = (certificate) => metadata(chain, (entry) => entry.statusReports.push({ status: 'ATTESTATION_KEY_COMPROMISE', certificate }));
  expect((await evaluatePasskeyRegistration(input, { metadata: scoped(chain.leaf.toString('base64')) })).rejection).toBe('security_status');
  expect((await evaluatePasskeyRegistration(input, { metadata: scoped(other.leaf.toString('base64')) })).rejection).toBe(null);
  const self = await verified(await registration(chain, { self: true }));
  expect((await evaluatePasskeyRegistration(self, { metadata: scoped(other.leaf.toString('base64')) })).rejection).toBe('security_status');
});
