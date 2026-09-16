import { z } from 'zod';
import type { MfaEnrollmentSetupData } from '../../../contracts/mfa';
import {
  mfaManagementOperationSchema,
  type MfaManagementOperation,
} from '../../../contracts/mfa-management';
import { isValidStudioWorkerSecret } from '../../../contracts/worker-secret';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const TOKEN_VERSION = 'zp1';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const CONTINUATION_TTL_MS = 5 * 60 * 1000;
const MANAGEMENT_TTL_MS = 5 * 60 * 1000;

const enrollmentPayloadSchema = z.discriminatedUnion('subject_type', [
  z.object({
    version: z.literal(1),
    kind: z.literal('mfa_enrollment'),
    subject_type: z.literal('install'),
    subject_id: z.email().max(254),
    totp_secret: z.string().regex(/^[A-Z2-7]{32}$/u),
    expires_at_ms: z.number().int().positive(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal('mfa_enrollment'),
    subject_type: z.literal('recovery_bootstrap'),
    subject_id: z.email().max(254),
    totp_secret: z.string().regex(/^[A-Z2-7]{32}$/u),
    expires_at_ms: z.number().int().positive(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal('mfa_enrollment'),
    subject_type: z.literal('account_setup'),
    subject_id: z.string().regex(/^[0-9a-f]{32}$/u),
    setup_token_id: z.string().regex(/^[0-9a-f]{32}$/u),
    setup_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
    auth_revision: z.string().regex(/^[0-9a-f]{32}$/u),
    totp_secret: z.string().regex(/^[A-Z2-7]{32}$/u),
    expires_at_ms: z.number().int().positive(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal('mfa_enrollment'),
    subject_type: z.literal('user'),
    subject_id: z.string().regex(/^[0-9a-f]{32}$/u),
    totp_secret: z.string().regex(/^[A-Z2-7]{32}$/u),
    expires_at_ms: z.number().int().positive(),
  }).strict(),
]);

const continuationPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal('mfa_continuation'),
  user_id: z.string().regex(/^[0-9a-f]{32}$/u),
  auth_revision: z.string().regex(/^[0-9a-f]{32}$/u),
  purpose: z.enum(['verify', 'enroll']),
  expires_at_ms: z.number().int().positive(),
}).strict();

const managementPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal('mfa_management'),
  user_id: z.string().regex(/^[0-9a-f]{32}$/u),
  session_id: z.string().regex(/^[0-9a-f]{32}$/u),
  auth_revision: z.string().regex(/^[0-9a-f]{32}$/u),
  operation: mfaManagementOperationSchema,
  target_id: z.string().regex(/^[0-9a-f]{32}$/u).optional(),
  expires_at_ms: z.number().int().positive(),
}).strict();

export type MfaEnrollmentPayload = z.infer<
  typeof enrollmentPayloadSchema
>;
export type MfaContinuationPurpose = 'verify' | 'enroll';
export type MfaManagementGrant = {
  userId: string;
  sessionId: string;
  authRevision: string;
  operation: MfaManagementOperation;
  targetId?: string;
};
export type EncryptedTotpSecret = {
  ciphertext: string;
  iv: string;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('Invalid base64url value.');
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + padding,
  );
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let output = '';

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += alphabet[(buffer << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new TypeError('Invalid base32 value.');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

async function deriveKey(
  authSecret: string,
  info: string,
): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(authSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode('ZeroPress Studio authentication'),
      info: textEncoder.encode(info),
    },
    rootKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sealJson(
  authSecret: string,
  purpose: string,
  payload: unknown,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(authSecret, `${purpose}:token:v1`);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(`${TOKEN_VERSION}:${purpose}`),
    },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  );
  return [
    TOKEN_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(new Uint8Array(ciphertext)),
  ].join('.');
}

async function openJson(
  authSecret: string,
  purpose: string,
  token: string,
): Promise<unknown> {
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== TOKEN_VERSION
    || !parts[1]
    || !parts[2]
  ) {
    throw new TypeError('Invalid sealed token.');
  }
  const key = await deriveKey(authSecret, `${purpose}:token:v1`);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64Url(parts[1]),
      additionalData: textEncoder.encode(`${TOKEN_VERSION}:${purpose}`),
    },
    key,
    decodeBase64Url(parts[2]),
  );
  return JSON.parse(textDecoder.decode(plaintext)) as unknown;
}

export function isConfiguredAuthSecret(
  value: string | undefined,
): value is string {
  return isValidStudioWorkerSecret(value);
}

export async function createMfaEnrollment(input: {
  authSecret: string;
  subject:
    | { type: 'install'; id: string }
    | { type: 'recovery_bootstrap'; id: string }
    | { type: 'user'; id: string }
    | {
      type: 'account_setup';
      id: string;
      setupTokenId: string;
      setupNonce: string;
      authRevision: string;
    };
  accountName: string;
  now?: Date;
}): Promise<MfaEnrollmentSetupData> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  const totpSecret = encodeBase32(
    crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)),
  );
  const payload = {
    version: 1,
    kind: 'mfa_enrollment',
    subject_type: input.subject.type,
    subject_id: input.subject.id,
    ...(input.subject.type === 'account_setup'
      ? {
          setup_token_id: input.subject.setupTokenId,
          setup_nonce: input.subject.setupNonce,
          auth_revision: input.subject.authRevision,
        }
      : {}),
    totp_secret: totpSecret,
    expires_at_ms: expiresAt.getTime(),
  } as const;
  const issuer = 'ZeroPress Studio';
  const label = `${issuer}:${input.accountName}`;
  const query = new URLSearchParams({
    secret: totpSecret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return {
    method: 'totp',
    secret: totpSecret,
    otpauth_uri: `otpauth://totp/${encodeURIComponent(label)}?${query}`,
    enrollment_token: await sealJson(
      input.authSecret,
      'mfa-enrollment',
      payload,
    ),
    expires_at_iso: expiresAt.toISOString(),
  };
}

export async function openMfaEnrollment(input: {
  authSecret: string;
  enrollmentToken: string;
  now?: Date;
}): Promise<MfaEnrollmentPayload | null> {
  try {
    const rawPayload = await openJson(
      input.authSecret,
      'mfa-enrollment',
      input.enrollmentToken,
    );
    const parsed = enrollmentPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success
      || parsed.data.expires_at_ms <= (input.now ?? new Date()).getTime()
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function createMfaContinuation(input: {
  authSecret: string;
  userId: string;
  authRevision: string;
  purpose: MfaContinuationPurpose;
  now?: Date;
}): Promise<{ token: string; expiresAtIso: string }> {
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + CONTINUATION_TTL_MS,
  );
  return {
    token: await sealJson(input.authSecret, 'mfa-continuation', {
      version: 1,
      kind: 'mfa_continuation',
      user_id: input.userId,
      auth_revision: input.authRevision,
      purpose: input.purpose,
      expires_at_ms: expiresAt.getTime(),
    }),
    expiresAtIso: expiresAt.toISOString(),
  };
}

export async function openMfaContinuation(input: {
  authSecret: string;
  token: string;
  expectedPurpose: MfaContinuationPurpose;
  now?: Date;
}): Promise<{ userId: string; authRevision: string } | null> {
  try {
    const rawPayload = await openJson(
      input.authSecret,
      'mfa-continuation',
      input.token,
    );
    const parsed = continuationPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success
      || parsed.data.purpose !== input.expectedPurpose
      || parsed.data.expires_at_ms <= (input.now ?? new Date()).getTime()
    ) {
      return null;
    }
    return {
      userId: parsed.data.user_id,
      authRevision: parsed.data.auth_revision,
    };
  } catch {
    return null;
  }
}

export async function createMfaManagementGrant(input: {
  authSecret: string;
  userId: string;
  sessionId: string;
  authRevision: string;
  operation: MfaManagementOperation;
  targetId?: string;
  now?: Date;
}): Promise<{ token: string; expiresAtIso: string }> {
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + MANAGEMENT_TTL_MS,
  );
  return {
    token: await sealJson(input.authSecret, 'mfa-management', {
      version: 1,
      kind: 'mfa_management',
      user_id: input.userId,
      session_id: input.sessionId,
      auth_revision: input.authRevision,
      operation: input.operation,
      ...(input.targetId ? { target_id: input.targetId } : {}),
      expires_at_ms: expiresAt.getTime(),
    }),
    expiresAtIso: expiresAt.toISOString(),
  };
}

export async function openMfaManagementGrant(input: {
  authSecret: string;
  token: string;
  expectedOperation: MfaManagementOperation;
  expectedTargetId?: string;
  now?: Date;
}): Promise<MfaManagementGrant | null> {
  try {
    const rawPayload = await openJson(
      input.authSecret,
      'mfa-management',
      input.token,
    );
    const parsed = managementPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success
      || parsed.data.operation !== input.expectedOperation
      || parsed.data.target_id !== input.expectedTargetId
      || parsed.data.expires_at_ms <= (input.now ?? new Date()).getTime()
    ) {
      return null;
    }
    return {
      userId: parsed.data.user_id,
      sessionId: parsed.data.session_id,
      authRevision: parsed.data.auth_revision,
      operation: parsed.data.operation,
      ...(parsed.data.target_id
        ? { targetId: parsed.data.target_id }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function encryptTotpSecret(
  authSecret: string,
  totpSecret: string,
): Promise<EncryptedTotpSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(
    authSecret,
    'mfa-totp-secret:v1',
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(totpSecret),
  );
  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    iv: encodeBase64Url(iv),
  };
}

export async function decryptTotpSecret(
  authSecret: string,
  encrypted: EncryptedTotpSecret,
): Promise<string> {
  const key = await deriveKey(
    authSecret,
    'mfa-totp-secret:v1',
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64Url(encrypted.iv) },
    key,
    decodeBase64Url(encrypted.ciphertext),
  );
  return textDecoder.decode(plaintext);
}

async function totpAtStep(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = step;
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, counter),
  );
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = (
    ((digest[offset] ?? 0) & 0x7f) << 24
    | ((digest[offset + 1] ?? 0) & 0xff) << 16
    | ((digest[offset + 2] ?? 0) & 0xff) << 8
    | ((digest[offset + 3] ?? 0) & 0xff)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export async function createTotpCode(input: {
  secret: string;
  now?: Date;
}): Promise<string> {
  const step = Math.floor(
    (input.now ?? new Date()).getTime() / 1000 / TOTP_PERIOD_SECONDS,
  );
  return totpAtStep(input.secret, step);
}

export async function verifyTotpCode(input: {
  secret: string;
  code: string;
  now?: Date;
}): Promise<number | null> {
  const currentStep = Math.floor(
    (input.now ?? new Date()).getTime() / 1000 / TOTP_PERIOD_SECONDS,
  );
  for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
    if (await totpAtStep(input.secret, step) === input.code) {
      return step;
    }
  }
  return null;
}

export async function verifyMfaEnrollmentProof(input: {
  enrollment: MfaEnrollmentPayload;
  totpCode: string;
  now?: Date;
}): Promise<{ matchedStep: number | null }> {
  return {
    matchedStep: await verifyTotpCode({
      secret: input.enrollment.totp_secret,
      code: input.totpCode,
      now: input.now,
    }),
  };
}
