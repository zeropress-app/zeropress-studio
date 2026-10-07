import { z } from 'zod';

export const passkeySnapshotSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  mds_no: z.number().int().positive(),
  blob_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  evaluated_at_iso: z.iso.datetime(),
  next_update: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  names_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  source: z.literal('https://mds.fidoalliance.org/'),
}).strict();
export type PasskeySnapshot = z.infer<typeof passkeySnapshotSchema>;
export const attestationReasonSchema = z.enum([
  'verified', 'not_evaluated', 'no_attestation', 'self_attestation',
  'metadata_missing', 'trust_roots_missing', 'unsupported_attestation',
  'trust_not_verified', 'verification_unavailable',
]);
export const attestationVerificationSchema = z.object({
  state: z.enum(['verified', 'unverified', 'not_evaluated']),
  reason: attestationReasonSchema,
  evaluated_at_iso: z.iso.datetime().nullable(),
  snapshot_id: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
}).strict().superRefine((value, ctx) => {
  const historical = value.state === 'not_evaluated';
  if ((value.state === 'verified') !== (value.reason === 'verified')
    || historical !== (value.reason === 'not_evaluated')
    || historical !== (value.evaluated_at_iso === null)
    || historical !== (value.snapshot_id === null)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent attestation verification record.' });
  }
});
export type AttestationVerification = z.infer<typeof attestationVerificationSchema>;
export const UNEVALUATED_ATTESTATION = {
  state: 'not_evaluated', reason: 'not_evaluated', evaluated_at_iso: null, snapshot_id: null,
} as const satisfies AttestationVerification;
export type AuthenticatorStatusReport = {
  status: string; effectiveDate?: string; authenticatorVersion?: number;
  certificate?: string; batchCertificate?: string;
};
export type PasskeyModel = {
  name: string;
  listed: boolean;
  certification: 'certified' | 'not_certified' | 'unknown';
  certification_level: string | null;
  security_reports: AuthenticatorStatusReport[];
  key_protection: string[];
};
export const CERTIFICATION_LEVELS = [
  'FIDO_CERTIFIED', 'FIDO_CERTIFIED_L1', 'FIDO_CERTIFIED_L1plus',
  'FIDO_CERTIFIED_L2', 'FIDO_CERTIFIED_L2plus', 'FIDO_CERTIFIED_L3', 'FIDO_CERTIFIED_L3plus',
] as const;
export const SECURITY_STATUSES = new Set([
  'REVOKED', 'USER_VERIFICATION_BYPASS', 'ATTESTATION_KEY_COMPROMISE',
  'USER_KEY_REMOTE_COMPROMISE', 'USER_KEY_PHYSICAL_COMPROMISE',
]);
/** Evaluate metadata once at the snapshot's fixed reference date, never the request clock. */
export function describePasskeyModel(input: {
  description: string; statusReports: AuthenticatorStatusReport[];
  keyProtection: string[]; evaluatedAtIso: string;
}): PasskeyModel {
  const effective = input.statusReports.filter((report) =>
    !report.effectiveDate || report.effectiveDate <= input.evaluatedAtIso.slice(0, 10));
  const certificationReports = effective.filter((report) =>
    (CERTIFICATION_LEVELS as readonly string[]).includes(report.status)
      || ['NOT_FIDO_CERTIFIED', 'SELF_ASSERTION_SUBMITTED'].includes(report.status));
  const latest = certificationReports.reduce((date, report) =>
    report.effectiveDate && report.effectiveDate > date ? report.effectiveDate : date, '');
  const current = certificationReports.filter((report) => (report.effectiveDate ?? '') === latest);
  const blocked = current.some((report) => ['NOT_FIDO_CERTIFIED', 'SELF_ASSERTION_SUBMITTED'].includes(report.status));
  const level = blocked ? undefined : [...CERTIFICATION_LEVELS].reverse().find((status) =>
    current.some((report) => report.status === status));
  return {
    name: input.description, listed: true,
    certification: level ? 'certified' : blocked ? 'not_certified' : 'unknown',
    certification_level: level ?? null,
    security_reports: effective.filter((report) => SECURITY_STATUSES.has(report.status)),
    key_protection: input.keyProtection,
  };
}

export const passkeyModelSchema = z.object({
  name: z.string(), listed: z.boolean(), certification: z.enum(['certified', 'not_certified', 'unknown']),
  certification_level: z.string().nullable(), security_reports: z.array(z.object({ status: z.string() }).strict()), key_protection: z.array(z.string()),
}).strict();
