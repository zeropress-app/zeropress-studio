import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { apiErrorSchema } from './api';
import { authenticatedSuccessSchema } from './auth';
import {
  mfaContinuationTokenSchema,
} from './mfa';

export const MAX_WEBAUTHN_CREDENTIALS = 10;
export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * 60;

const base64UrlSchema = z.string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/u);

const clientExtensionResultsSchema = z.record(
  z.string().max(128),
  z.unknown(),
);

export const webAuthnTransportSchema = z.enum([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

export const webAuthnCredentialDeviceTypeSchema = z.enum([
  'singleDevice',
  'multiDevice',
]);

export const webAuthnAttestationFormatSchema = z.enum([
  'fido-u2f',
  'packed',
  'android-safetynet',
  'android-key',
  'tpm',
  'apple',
  'none',
]);

export const webAuthnAaguidSchema = z.string()
  .toLowerCase()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  )
  .refine(
    (value) => value !== '00000000-0000-0000-0000-000000000000',
  );

export const webAuthnCredentialIdSchema = z.string()
  .regex(/^[0-9a-f]{32}$/u);

export const webAuthnChallengeTokenSchema = z.string()
  .regex(/^[0-9a-f]{32}$/u);

export const webAuthnCredentialNameSchema = z.string()
  .trim()
  .min(1)
  .max(100);

export const webAuthnCredentialSummarySchema = z.object({
  id: webAuthnCredentialIdSchema,
  display_name: webAuthnCredentialNameSchema,
  rp_id: z.string().trim().toLowerCase().min(1).max(253),
  transports: z.array(webAuthnTransportSchema).max(7),
  credential_device_type: webAuthnCredentialDeviceTypeSchema,
  backed_up: z.boolean(),
  attestation_format: webAuthnAttestationFormatSchema,
  aaguid: webAuthnAaguidSchema.nullable(),
  created_at_iso: z.iso.datetime({ offset: true }),
  last_used_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const webAuthnRegistrationResponseSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    attestationObject: base64UrlSchema,
    authenticatorData: base64UrlSchema.optional(),
    transports: z.array(webAuthnTransportSchema).max(7).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64UrlSchema.optional(),
  }).strict(),
  authenticatorAttachment: z.enum([
    'cross-platform',
    'platform',
  ]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  type: z.literal('public-key'),
}).strict().transform(
  (value) => value as unknown as RegistrationResponseJSON,
);

export const webAuthnAuthenticationResponseSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    authenticatorData: base64UrlSchema,
    signature: base64UrlSchema,
    userHandle: base64UrlSchema.optional(),
  }).strict(),
  authenticatorAttachment: z.enum([
    'cross-platform',
    'platform',
  ]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  type: z.literal('public-key'),
}).strict().transform(
  (value) => value as unknown as AuthenticationResponseJSON,
);

function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).challenge === 'string';
}

export const webAuthnRegistrationOptionsSchema =
  z.custom<PublicKeyCredentialCreationOptionsJSON>(isOptionsObject);

export const webAuthnAuthenticationOptionsSchema =
  z.custom<PublicKeyCredentialRequestOptionsJSON>(isOptionsObject);

export const webAuthnLoginOptionsRequestSchema = z.object({
  continuation_token: mfaContinuationTokenSchema,
}).strict();

export const webAuthnLoginOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    options: webAuthnAuthenticationOptionsSchema,
    challenge_token: webAuthnChallengeTokenSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export const webAuthnLoginOptionsResponseSchema = z.union([
  webAuthnLoginOptionsSuccessSchema,
  apiErrorSchema,
]);

export const webAuthnLoginVerifyRequestSchema = z.object({
  continuation_token: mfaContinuationTokenSchema,
  challenge_token: webAuthnChallengeTokenSchema,
  response: webAuthnAuthenticationResponseSchema,
}).strict();

export const webAuthnLoginVerifyResponseSchema = z.union([
  authenticatedSuccessSchema,
  apiErrorSchema,
]);

export const passkeySignInOptionsRequestSchema = z.object({}).strict();

export const passkeySignInOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    options: webAuthnAuthenticationOptionsSchema,
    challenge_token: webAuthnChallengeTokenSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export const passkeySignInOptionsResponseSchema = z.union([
  passkeySignInOptionsSuccessSchema,
  apiErrorSchema,
]);

export const passkeySignInVerifyRequestSchema = z.object({
  challenge_token: webAuthnChallengeTokenSchema,
  response: webAuthnAuthenticationResponseSchema.refine(
    (value) => typeof value.response.userHandle === 'string'
      && value.response.userHandle.length > 0,
  ),
}).strict();

export const passkeySignInVerifyResponseSchema = z.union([
  authenticatedSuccessSchema,
  apiErrorSchema,
]);

export type WebAuthnTransport = z.infer<typeof webAuthnTransportSchema>;
export type WebAuthnCredentialSummary = z.infer<
  typeof webAuthnCredentialSummarySchema
>;
export type WebAuthnRegistrationResponse = RegistrationResponseJSON;
export type WebAuthnAuthenticationResponse = AuthenticationResponseJSON;
export type WebAuthnLoginOptionsRequest = z.infer<
  typeof webAuthnLoginOptionsRequestSchema
>;
export type WebAuthnLoginOptionsResponse = z.infer<
  typeof webAuthnLoginOptionsResponseSchema
>;
export type WebAuthnLoginVerifyRequest = z.infer<
  typeof webAuthnLoginVerifyRequestSchema
>;
export type WebAuthnLoginVerifyResponse = z.infer<
  typeof webAuthnLoginVerifyResponseSchema
>;
export type PasskeySignInOptionsRequest = z.infer<
  typeof passkeySignInOptionsRequestSchema
>;
export type PasskeySignInOptionsResponse = z.infer<
  typeof passkeySignInOptionsResponseSchema
>;
export type PasskeySignInVerifyRequest = z.infer<
  typeof passkeySignInVerifyRequestSchema
>;
export type PasskeySignInVerifyResponse = z.infer<
  typeof passkeySignInVerifyResponseSchema
>;
