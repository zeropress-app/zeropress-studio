import { z } from 'zod';
import { StudioOperationalError } from '../lib/operational-error';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ENVELOPE_VERSION = 1;

export const encryptedMailCredentialSchema = z.object({
  version: z.literal(ENVELOPE_VERSION),
  iv: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
}).strict();

export type EncryptedMailCredential = z.infer<
  typeof encryptedMailCredentialSchema
>;
export type MailCredentialKind = 'resend_api_key' | 'cloudflare_api_token';

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
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveMailCredentialKey(
  authSecret: string,
  kind: MailCredentialKind,
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
      salt: textEncoder.encode('ZeroPress Studio mail credentials'),
      info: textEncoder.encode(`${kind}:v1`),
    },
    rootKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function additionalData(kind: MailCredentialKind): Uint8Array {
  return textEncoder.encode(`zeropress-studio:${kind}:v1`);
}

function cryptoFailure(
  action: 'encrypt_mail_credential' | 'decrypt_mail_credential',
  cause: unknown,
): StudioOperationalError {
  return new StudioOperationalError('MAIL_CREDENTIAL_CRYPTO_FAILED', {
    cause,
    metadata: {
      resource: 'STUDIO_AUTH_SECRET',
      action,
    },
  });
}

export async function encryptMailCredential(input: {
  authSecret: string;
  kind: MailCredentialKind;
  value: string;
}): Promise<EncryptedMailCredential> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveMailCredentialKey(input.authSecret, input.kind);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: additionalData(input.kind),
      },
      key,
      textEncoder.encode(input.value),
    );
    return {
      version: ENVELOPE_VERSION,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw cryptoFailure('encrypt_mail_credential', error);
  }
}

export async function decryptMailCredential(input: {
  authSecret: string;
  kind: MailCredentialKind;
  encrypted: EncryptedMailCredential;
}): Promise<string> {
  try {
    const parsed = encryptedMailCredentialSchema.parse(input.encrypted);
    const key = await deriveMailCredentialKey(input.authSecret, input.kind);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64Url(parsed.iv),
        additionalData: additionalData(input.kind),
      },
      key,
      decodeBase64Url(parsed.ciphertext),
    );
    const value = textDecoder.decode(plaintext);
    if (!value) throw new TypeError('Decrypted credential is empty.');
    return value;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw cryptoFailure('decrypt_mail_credential', error);
  }
}
