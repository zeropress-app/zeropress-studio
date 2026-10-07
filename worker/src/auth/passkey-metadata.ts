import { convertCertBufferToPEM, decodeAttestationObject, decodeCredentialPublicKey, isoBase64URL, parseAuthenticatorData, validateCertificatePath } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, VerifiedRegistrationResponse } from '@simplewebauthn/server';
import type { AttestationVerification, PasskeyModel, PasskeySnapshot } from '../../../contracts/passkey-metadata';
import bundled from './metadata/passkey-metadata.json';

type MetadataStatement = { authenticationAlgorithms: string[]; attestationTypes: string[]; attestationRootCertificates: string[]; rogueListPresent: boolean };
export type PasskeyMetadata = { snapshot: PasskeySnapshot; models: Record<string, PasskeyModel>; statements: Record<string, MetadataStatement> };
export const PASSKEY_METADATA = bundled as PasskeyMetadata;
export const PASSKEY_SNAPSHOT = PASSKEY_METADATA.snapshot;
export type PasskeyEvaluation = { proof: AttestationVerification; rejection: 'not_certified' | 'metadata_missing' | 'attestation_unverified' | 'security_status' | 'verification_unavailable' | null };
const algorithms: Record<number, string[]> = {
  [-7]: ['secp256r1_ecdsa_sha256_raw', 'secp256r1_ecdsa_sha256_der'],
  [-8]: ['ed25519_eddsa_sha512_raw'], [-35]: ['secp384r1_ecdsa_sha384_raw'], [-36]: ['secp521r1_ecdsa_sha512_raw'],
  [-47]: ['secp256k1_ecdsa_sha256_raw'], [-257]: ['rsassa_pkcsv15_sha256_raw'], [-37]: ['rsassa_pss_sha256_raw'], [-65535]: ['rsassa_pkcsv15_sha1_raw'],
};
const certBody = (pem: string) => pem.replace(/-----[^-]+-----|\s/gu, '');
/** Called only after complete WebAuthn verification; no global trust-store changes. */
export async function evaluatePasskeyRegistration(input: {
  response: RegistrationResponseJSON; registration: NonNullable<VerifiedRegistrationResponse['registrationInfo']>; now?: Date;
}, dependencies: { metadata?: PasskeyMetadata; validatePath?: typeof validateCertificatePath } = {}): Promise<PasskeyEvaluation> {
  const metadata = dependencies.metadata ?? PASSKEY_METADATA;
  const proof = (reason: AttestationVerification['reason']): AttestationVerification => ({
    state: reason === 'verified' ? 'verified' : 'unverified', reason,
    evaluated_at_iso: (input.now ?? new Date()).toISOString(), snapshot_id: metadata.snapshot.id,
  });
  const id = input.registration.aaguid.toLowerCase();
  const model = metadata.models[id];
  const statement = metadata.statements[id];
  let result = proof('no_attestation');
  let certificates: string[] = [];
  try {
    const object = decodeAttestationObject(isoBase64URL.toBuffer(input.response.response.attestationObject));
    const fmt = object.get('fmt');
    const authData = parseAuthenticatorData(object.get('authData'));
    const actualId = authData.aaguid ? Array.from(authData.aaguid, (byte) => byte.toString(16).padStart(2, '0')).join('') : '';
    // Bind the verified model identity to the signed authenticator data, not a caller-supplied label.
    if (fmt !== input.registration.fmt || actualId !== id.replaceAll('-', '')) {
      result = proof('trust_not_verified');
    } else if (fmt === 'none') {
      result = proof('no_attestation');
    } else if (!statement) {
      result = proof('metadata_missing');
    } else if (!['packed', 'tpm', 'android-key', 'apple'].includes(fmt)) {
      result = proof('unsupported_attestation');
    } else {
      const chain = object.get('attStmt').get('x5c');
      if (!chain?.length) result = proof('self_attestation');
      else if (!statement.attestationRootCertificates.length) result = proof('trust_roots_missing');
      else {
        certificates = chain.map((cert: Uint8Array) => convertCertBufferToPEM(new Uint8Array(cert)));
        const algorithm = decodeCredentialPublicKey(input.registration.credential.publicKey).get(3);
        const supported = (algorithms[algorithm!] ?? []).some((value) => statement.authenticationAlgorithms.includes(value));
        const attested = statement.attestationTypes.some((type) => type === 'basic_full' || type === 'attca');
        if (!supported || !attested) result = proof('unsupported_attestation');
        else {
          const roots = statement.attestationRootCertificates.map((cert) => convertCertBufferToPEM(cert));
          // Roots supplied in x5c remain untrusted; only the model's bundled roots are anchors.
          // Some authenticators also send the root. The verifier appends its own anchor
          // and rejects duplicate certificates, so omit only an identical trailing anchor.
          const path = certificates.length > 1 && roots.some((root) => certBody(root) === certBody(certificates.at(-1)!))
            ? certificates.slice(0, -1) : certificates;
          const validated = await (dependencies.validatePath ?? validateCertificatePath)(path, roots);
          result = proof(validated ? 'verified' : 'trust_not_verified');
        }
      }
    }
  } catch (error) {
    result = proof(error && typeof error === 'object' && 'code' in error && error.code === 'CERTIFICATE_PATH_VERIFICATION_FAILED'
      ? 'trust_not_verified' : 'verification_unavailable');
  }
  // A firmware version cannot be established from these attestation formats. Version-scoped
  // incidents therefore remain applicable. Certificate scopes can be ruled out only with proof.
  const unsafe = model?.security_reports.some((report) => {
    if (report.authenticatorVersion !== undefined || !report.certificate && !report.batchCertificate) return true;
    if (result.state !== 'verified') return true;
    const affected = [report.certificate, report.batchCertificate].filter((cert): cert is string => Boolean(cert));
    return certificates.some((cert) => affected.some((scope) => certBody(cert) === certBody(scope)));
  }) || statement?.rogueListPresent;
  const rejection = result.reason === 'verification_unavailable' ? 'verification_unavailable'
    : !model?.listed ? 'metadata_missing'
    : unsafe ? 'security_status'
    : model.certification === 'unknown' ? 'metadata_missing'
    : model.certification !== 'certified' ? 'not_certified'
    : result.state !== 'verified' ? 'attestation_unverified' : null;
  return { proof: result, rejection };
}

export function getPasskeyModel(aaguid: string | null) {
  const model = aaguid ? PASSKEY_METADATA.models[aaguid.toLowerCase()] : undefined;
  return model ? { ...model, security_reports: model.security_reports.map(({ status }) => ({ status })) } : null;
}
