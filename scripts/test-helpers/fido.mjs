import 'reflect-metadata';
import { createHash, KeyObject, sign } from 'node:crypto';
import { BasicConstraintsExtension, CRLDistributionPointsExtension, X509CrlGenerator, KeyUsagesExtension, KeyUsageFlags, X509CertificateGenerator } from '@peculiar/x509';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { SignJWT } from 'jose';

export const AAGUID = '11111111-2222-4333-8444-555555555555';
const sha = (value) => createHash('sha256').update(value).digest();
const b64 = (value) => Buffer.from(value).toString('base64url');
const newKey = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
export async function certificates({ expired = false, crlUrl } = {}) {
  const rootKey = await newKey();
  const nextKey = await newKey();
  const leafKey = await newKey();
  const dates = { notBefore: new Date('2020-01-01'), notAfter: new Date(expired ? '2021-01-01' : '2099-01-01') };
  const root = await X509CertificateGenerator.createSelfSigned({ name: 'CN=Synthetic R3', keys: rootKey, ...dates,
    extensions: [new BasicConstraintsExtension(true, 2, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)] });
  const r46 = await X509CertificateGenerator.createSelfSigned({ name: 'CN=Synthetic R46', keys: nextKey, ...dates,
    extensions: [new BasicConstraintsExtension(true, 1, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)] });
  const cross = await X509CertificateGenerator.create({ subject: r46.subject, issuer: root.subject, publicKey: nextKey.publicKey, signingKey: rootKey.privateKey, ...dates,
    extensions: [new BasicConstraintsExtension(true, 1, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)] });
  const leaf = await X509CertificateGenerator.create({ subject: 'C=US, O=Synthetic Test, OU=Authenticator Attestation, CN=Synthetic Authenticator',
    issuer: r46.subject, publicKey: leafKey.publicKey, signingKey: nextKey.privateKey, ...dates,
    extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), ...(crlUrl ? [new CRLDistributionPointsExtension([crlUrl])] : [])] });
  return { root, r46, cross, leaf, leafKey, nextKey };
}
export function payload(serial = 1) {
  return { legalHeader: 'Synthetic test data', no: serial, nextUpdate: '2026-11-01', entries: [{ aaguid: AAGUID,
    statusReports: [{ status: 'FIDO_CERTIFIED_L1', effectiveDate: '2025-01-01' }],
    metadataStatement: { aaguid: AAGUID, description: 'Synthetic authenticator', authenticationAlgorithms: ['secp256r1_ecdsa_sha256_raw'],
      attestationTypes: ['basic_full'], attestationRootCertificates: [], keyProtection: ['hardware'] } }] };
}
export async function signedBlob(chain, data = payload(), cross = true) {
  return new SignJWT(data).setProtectedHeader({ alg: 'ES256', x5c: [chain.leaf, ...(cross ? [chain.cross] : [])].map((cert) => cert.toString('base64')) }).sign(chain.leafKey.privateKey);
}
export async function registration(chain, { self = false, none = false, aaguid = AAGUID, includeRoot = false } = {}) {
  const credentialKey = await newKey();
  const jwk = await crypto.subtle.exportKey('jwk', credentialKey.publicKey);
  const publicKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credentialId = Buffer.alloc(16, 7);
  const challenge = b64('synthetic challenge');
  const origin = 'https://studio.example.test';
  const rpId = 'studio.example.test';
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
  const authData = Buffer.concat([sha(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.from(aaguid.replaceAll('-', ''), 'hex'), Buffer.from([0, credentialId.length]), credentialId, publicKey]);
  const key = self ? credentialKey : chain.leafKey;
  const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), { key: KeyObject.from(key.privateKey), dsaEncoding: 'der' });
  const statement = none ? new Map() : new Map([['alg', -7], ['sig', signature]]);
  if (!self && !none) statement.set('x5c', [new Uint8Array(chain.leaf.rawData), ...(includeRoot ? [new Uint8Array(chain.r46.rawData)] : [new Uint8Array(chain.cross.rawData)])]);
  const object = isoCBOR.encode(new Map([['fmt', none ? 'none' : 'packed'], ['authData', authData], ['attStmt', statement]]));
  return { response: { id: b64(credentialId), rawId: b64(credentialId), response: { clientDataJSON: b64(clientData), attestationObject: b64(object), transports: ['usb'] }, type: 'public-key', clientExtensionResults: {} }, challenge, origin, rpId };
}

export async function revocationList(chain) {
  return X509CrlGenerator.create({ issuer: chain.r46.subject, signingKey: chain.nextKey.privateKey,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, thisUpdate: new Date('2026-01-01'), nextUpdate: new Date('2099-01-01'),
    entries: [{ serialNumber: chain.leaf.serialNumber, revocationDate: new Date('2026-01-01') }],
  });
}
