import type {
  AttestationFormat,
  CredentialDeviceType,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  MAX_WEBAUTHN_CREDENTIALS,
  webAuthnTransportSchema,
  type WebAuthnCredentialSummary,
  type WebAuthnTransport,
} from '../../../contracts/webauthn';
import { StudioOperationalError } from '../lib/operational-error';

export type WebAuthnChallengePurpose =
  | 'login'
  | 'management_step_up'
  | 'registration';

type WebAuthnCredentialRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  signature_counter: number;
  display_name: string;
  rp_id: string;
  transports: string;
  credential_device_type: CredentialDeviceType;
  backed_up: number;
  attestation_format: AttestationFormat;
  aaguid: string | null;
  created_at_iso: string;
  updated_at_iso: string;
  last_used_at_iso: string | null;
};

type WebAuthnChallengeRow = {
  id: string;
  user_id: string;
  session_id: string | null;
  auth_revision: string;
  purpose: WebAuthnChallengePurpose;
  operation: string | null;
  target_id: string | null;
  challenge: string;
  origin: string;
  rp_id: string;
  created_at_iso: string;
  expires_at_iso: string;
};

type WebAuthnDiscoveryChallengeRow = {
  id: string;
  challenge: string;
  origin: string;
  rp_id: string;
  created_at_iso: string;
  expires_at_iso: string;
};

type PasswordlessWebAuthnCredentialRow = WebAuthnCredentialRow & {
  auth_revision: string;
};

export type StoredWebAuthnCredential = {
  rowId: string;
  externalId: string;
  userId: string;
  rpId: string;
  oldCounter: number;
  credential: WebAuthnCredential;
};

export type StoredWebAuthnChallenge = {
  id: string;
  userId: string;
  sessionId: string | null;
  authRevision: string;
  purpose: WebAuthnChallengePurpose;
  operation: string | null;
  targetId: string | null;
  challenge: string;
  origin: string;
  rpId: string;
  createdAtIso: string;
  expiresAtIso: string;
};

export type StoredWebAuthnDiscoveryChallenge = {
  id: string;
  challenge: string;
  origin: string;
  rpId: string;
  createdAtIso: string;
  expiresAtIso: string;
};

export type StoredPasswordlessWebAuthnCredential = StoredWebAuthnCredential & {
  authRevision: string;
};

function createOpaqueId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function parseTransports(value: string): WebAuthnTransport[] {
  const parsed = webAuthnTransportSchema.array().safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new TypeError('D1 returned invalid WebAuthn transports.');
  }
  return [...new Set(parsed.data)];
}

const ZERO_CANONICAL_AAGUID = '00000000-0000-0000-0000-000000000000';
const ZERO_STORED_AAGUID = '00000000000000000000000000000000';
const CANONICAL_AAGUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STORED_AAGUID_PATTERN = /^[0-9a-f]{32}$/u;
const ATTESTATION_FORMATS = new Set<AttestationFormat>([
  'fido-u2f',
  'packed',
  'android-safetynet',
  'android-key',
  'tpm',
  'apple',
  'none',
]);

function normalizeAaguid(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized
    && normalized !== ZERO_CANONICAL_AAGUID
    && CANONICAL_AAGUID_PATTERN.test(normalized)
    ? normalized.replaceAll('-', '')
    : null;
}

function formatStoredAaguid(value: string | null): string | null {
  if (value === null) return null;
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

function toSummary(row: WebAuthnCredentialRow): WebAuthnCredentialSummary {
  if (
    !Number.isInteger(row.signature_counter)
    || row.signature_counter < 0
    || !['singleDevice', 'multiDevice'].includes(
      row.credential_device_type,
    )
    || ![0, 1].includes(row.backed_up)
    || !ATTESTATION_FORMATS.has(row.attestation_format)
    || (
      row.aaguid !== null
      && (
        row.aaguid === ZERO_STORED_AAGUID
        || !STORED_AAGUID_PATTERN.test(row.aaguid)
      )
    )
    || !Number.isFinite(Date.parse(row.created_at_iso))
    || (
      row.last_used_at_iso !== null
      && !Number.isFinite(Date.parse(row.last_used_at_iso))
    )
  ) {
    throw new TypeError('D1 returned invalid WebAuthn credential data.');
  }
  return {
    id: row.id,
    display_name: row.display_name,
    rp_id: row.rp_id,
    transports: parseTransports(row.transports),
    credential_device_type: row.credential_device_type,
    backed_up: Boolean(row.backed_up),
    attestation_format: row.attestation_format,
    aaguid: formatStoredAaguid(row.aaguid),
    created_at_iso: row.created_at_iso,
    last_used_at_iso: row.last_used_at_iso,
  };
}

function toStoredCredential(
  row: WebAuthnCredentialRow,
): StoredWebAuthnCredential {
  const transports = parseTransports(row.transports);
  return {
    rowId: row.id,
    externalId: row.credential_id,
    userId: row.user_id,
    rpId: row.rp_id,
    oldCounter: row.signature_counter,
    credential: {
      id: row.credential_id,
      publicKey: isoBase64URL.toBuffer(row.public_key),
      counter: row.signature_counter,
      ...(transports.length > 0 ? { transports } : {}),
    },
  };
}

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('AUTH_WEBAUTHN_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: {
      resource: 'DB',
      action,
    },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('AUTH_WEBAUTHN_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: {
      resource: 'DB',
      action,
    },
  });
}

export async function listUserWebAuthnCredentials(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
}): Promise<WebAuthnCredentialSummary[]> {
  try {
    const result = await input.db.prepare(`
      SELECT credential.*
      FROM user_webauthn_credentials credential
      JOIN users current_user ON current_user.id = credential.user_id
      WHERE credential.user_id = ?
        AND current_user.auth_revision = ?
        AND current_user.status = 'active'
      ORDER BY credential.created_at_iso ASC, credential.id ASC
      LIMIT ?
    `).bind(
      input.userId,
      input.authRevision,
      MAX_WEBAUTHN_CREDENTIALS,
    ).all<WebAuthnCredentialRow>();
    return (result.results ?? []).map(toSummary);
  } catch (error) {
    throw queryFailure(error, 'list_webauthn_credentials');
  }
}

export async function listWebAuthnAuthenticationCredentials(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  rpId: string;
}): Promise<Array<{
  id: string;
  transports?: WebAuthnTransport[];
}>> {
  try {
    const result = await input.db.prepare(`
      SELECT credential_id, transports
      FROM user_webauthn_credentials credential
      JOIN users current_user ON current_user.id = credential.user_id
      WHERE credential.user_id = ?
        AND credential.rp_id = ?
        AND current_user.auth_revision = ?
        AND current_user.status = 'active'
      ORDER BY credential.created_at_iso ASC, credential.id ASC
      LIMIT ?
    `).bind(
      input.userId,
      input.rpId,
      input.authRevision,
      MAX_WEBAUTHN_CREDENTIALS,
    ).all<{ credential_id: string; transports: string }>();
    return (result.results ?? []).map((row) => {
      const transports = parseTransports(row.transports);
      return {
        id: row.credential_id,
        ...(transports.length > 0 ? { transports } : {}),
      };
    });
  } catch (error) {
    throw queryFailure(error, 'list_webauthn_authentication_credentials');
  }
}

export async function getStoredWebAuthnCredential(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  rpId: string;
  credentialId: string;
}): Promise<StoredWebAuthnCredential | null> {
  try {
    const row = await input.db.prepare(`
      SELECT credential.*
      FROM user_webauthn_credentials credential
      JOIN users current_user ON current_user.id = credential.user_id
      WHERE credential.user_id = ?
        AND credential.credential_id = ?
        AND credential.rp_id = ?
        AND current_user.auth_revision = ?
        AND current_user.status = 'active'
      LIMIT 1
    `).bind(
      input.userId,
      input.credentialId,
      input.rpId,
      input.authRevision,
    ).first<WebAuthnCredentialRow>();
    if (!row) return null;
    return toStoredCredential(row);
  } catch (error) {
    throw queryFailure(error, 'read_webauthn_credential');
  }
}

export async function getStoredPasswordlessWebAuthnCredential(input: {
  db: D1Database;
  rpId: string;
  credentialId: string;
}): Promise<StoredPasswordlessWebAuthnCredential | null> {
  try {
    const row = await input.db.prepare(`
      SELECT credential.*, current_user.auth_revision
      FROM user_webauthn_credentials credential
      JOIN users current_user ON current_user.id = credential.user_id
      WHERE credential.credential_id = ?
        AND credential.rp_id = ?
        AND current_user.status = 'active'
      LIMIT 1
    `).bind(
      input.credentialId,
      input.rpId,
    ).first<PasswordlessWebAuthnCredentialRow>();
    if (!row) return null;
    if (!/^[0-9a-f]{32}$/u.test(row.auth_revision)) {
      throw new TypeError('D1 returned an invalid WebAuthn auth revision.');
    }
    return {
      ...toStoredCredential(row),
      authRevision: row.auth_revision,
    };
  } catch (error) {
    throw queryFailure(error, 'read_passwordless_webauthn_credential');
  }
}

export async function createWebAuthnDiscoveryChallenge(input: {
  db: D1Database;
  challenge: string;
  origin: string;
  rpId: string;
  now?: Date;
  ttlSeconds?: number;
  createId?: () => string;
}): Promise<{ token: string; expiresAtIso: string }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? 300) * 1000,
  );
  const id = (input.createId ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        DELETE FROM webauthn_discovery_challenges
        WHERE id IN (
          SELECT id
          FROM webauthn_discovery_challenges
          WHERE expires_at_iso <= ?
            OR consumed_by IS NOT NULL
          ORDER BY expires_at_iso ASC, id ASC
          LIMIT 100
        )
      `).bind(nowIso),
      input.db.prepare(`
        INSERT INTO webauthn_discovery_challenges (
          id,
          challenge,
          origin,
          rp_id,
          consumed_by,
          created_at_iso,
          expires_at_iso
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).bind(
        id,
        input.challenge,
        input.origin,
        input.rpId,
        nowIso,
        expiresAt.toISOString(),
      ),
    ]);
    if (readChanges(results[1]) !== 1) {
      throw new TypeError('D1 did not create a WebAuthn discovery challenge.');
    }
    return { token: id, expiresAtIso: expiresAt.toISOString() };
  } catch (error) {
    throw writeFailure(error, 'create_webauthn_discovery_challenge');
  }
}

export async function getWebAuthnDiscoveryChallenge(input: {
  db: D1Database;
  token: string;
  now?: Date;
}): Promise<StoredWebAuthnDiscoveryChallenge | null> {
  try {
    const row = await input.db.prepare(`
      SELECT id, challenge, origin, rp_id, created_at_iso, expires_at_iso
      FROM webauthn_discovery_challenges
      WHERE id = ?
        AND consumed_by IS NULL
        AND expires_at_iso > ?
      LIMIT 1
    `).bind(
      input.token,
      (input.now ?? new Date()).toISOString(),
    ).first<WebAuthnDiscoveryChallengeRow>();
    if (!row) return null;
    return {
      id: row.id,
      challenge: row.challenge,
      origin: row.origin,
      rpId: row.rp_id,
      createdAtIso: row.created_at_iso,
      expiresAtIso: row.expires_at_iso,
    };
  } catch (error) {
    throw queryFailure(error, 'read_webauthn_discovery_challenge');
  }
}

export async function createWebAuthnChallenge(input: {
  db: D1Database;
  userId: string;
  sessionId?: string;
  authRevision: string;
  purpose: WebAuthnChallengePurpose;
  operation?: string;
  targetId?: string;
  challenge: string;
  origin: string;
  rpId: string;
  now?: Date;
  ttlSeconds?: number;
  createId?: () => string;
}): Promise<{ token: string; expiresAtIso: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? 300) * 1000,
  );
  const id = (input.createId ?? createOpaqueId)();
  try {
    const result = await input.db.prepare(`
      INSERT INTO webauthn_challenges (
        id,
        user_id,
        session_id,
        auth_revision,
        purpose,
        operation,
        target_id,
        challenge,
        origin,
        rp_id,
        created_at_iso,
        expires_at_iso,
        consumed_by
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
      FROM users current_user
      WHERE current_user.id = ?
        AND current_user.auth_revision = ?
        AND current_user.status = 'active'
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
            FROM sessions current_session
            WHERE current_session.id = ?
              AND current_session.user_id = current_user.id
              AND current_session.auth_revision = current_user.auth_revision
          )
        )
    `).bind(
      id,
      input.userId,
      input.sessionId ?? null,
      input.authRevision,
      input.purpose,
      input.operation ?? null,
      input.targetId ?? null,
      input.challenge,
      input.origin,
      input.rpId,
      now.toISOString(),
      expiresAt.toISOString(),
      input.userId,
      input.authRevision,
      input.sessionId ?? null,
      input.sessionId ?? null,
    ).run();
    if (readChanges(result) !== 1) {
      throw new TypeError(
        'D1 did not create a WebAuthn challenge for an eligible account.',
      );
    }
    return { token: id, expiresAtIso: expiresAt.toISOString() };
  } catch (error) {
    throw writeFailure(error, 'create_webauthn_challenge');
  }
}

export async function getWebAuthnChallenge(input: {
  db: D1Database;
  token: string;
  userId: string;
  authRevision: string;
  purpose: WebAuthnChallengePurpose;
  sessionId?: string;
  operation?: string;
  targetId?: string;
  now?: Date;
}): Promise<StoredWebAuthnChallenge | null> {
  try {
    const row = await input.db.prepare(`
      SELECT
        id,
        user_id,
        session_id,
        auth_revision,
        purpose,
        operation,
        target_id,
        challenge,
        origin,
        rp_id,
        created_at_iso,
        expires_at_iso
      FROM webauthn_challenges
      WHERE id = ?
        AND user_id = ?
        AND auth_revision = ?
        AND purpose = ?
        AND session_id IS ?
        AND operation IS ?
        AND target_id IS ?
        AND consumed_by IS NULL
        AND expires_at_iso > ?
      LIMIT 1
    `).bind(
      input.token,
      input.userId,
      input.authRevision,
      input.purpose,
      input.sessionId ?? null,
      input.operation ?? null,
      input.targetId ?? null,
      (input.now ?? new Date()).toISOString(),
    ).first<WebAuthnChallengeRow>();
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      authRevision: row.auth_revision,
      purpose: row.purpose,
      operation: row.operation,
      targetId: row.target_id,
      challenge: row.challenge,
      origin: row.origin,
      rpId: row.rp_id,
      createdAtIso: row.created_at_iso,
      expiresAtIso: row.expires_at_iso,
    };
  } catch (error) {
    throw queryFailure(error, 'read_webauthn_challenge');
  }
}

export async function completeWebAuthnAuthentication(input: {
  db: D1Database;
  challenge: StoredWebAuthnChallenge;
  credential: StoredWebAuthnCredential;
  newCounter: number;
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  now?: Date;
  createAttemptId?: () => string;
}): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const attemptId = (input.createAttemptId ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE webauthn_challenges
        SET consumed_by = ?
        WHERE id = ?
          AND user_id = ?
          AND auth_revision = ?
          AND purpose = ?
          AND session_id IS ?
          AND operation IS ?
          AND target_id IS ?
          AND challenge = ?
          AND origin = ?
          AND rp_id = ?
          AND consumed_by IS NULL
          AND expires_at_iso > ?
      `).bind(
        attemptId,
        input.challenge.id,
        input.challenge.userId,
        input.challenge.authRevision,
        input.challenge.purpose,
        input.challenge.sessionId,
        input.challenge.operation,
        input.challenge.targetId,
        input.challenge.challenge,
        input.challenge.origin,
        input.challenge.rpId,
        nowIso,
      ),
      input.db.prepare(`
        UPDATE user_webauthn_credentials
        SET
          signature_counter = ?,
          credential_device_type = ?,
          backed_up = ?,
          updated_at_iso = ?,
          last_used_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND credential_id = ?
          AND rp_id = ?
          AND signature_counter = ?
          AND EXISTS (
            SELECT 1
            FROM webauthn_challenges consumed
            WHERE consumed.id = ?
              AND consumed.consumed_by = ?
          )
      `).bind(
        input.newCounter,
        input.credentialDeviceType,
        input.credentialBackedUp ? 1 : 0,
        nowIso,
        nowIso,
        input.credential.rowId,
        input.credential.userId,
        input.credential.externalId,
        input.credential.rpId,
        input.credential.oldCounter,
        input.challenge.id,
        attemptId,
      ),
      input.db.prepare(`
        DELETE FROM webauthn_challenges
        WHERE id = ?
          AND consumed_by = ?
      `).bind(input.challenge.id, attemptId),
    ]);
    return readChanges(results[0]) === 1
      && readChanges(results[1]) === 1
      && readChanges(results[2]) === 1;
  } catch (error) {
    throw writeFailure(error, 'complete_webauthn_authentication');
  }
}

export async function completePasswordlessWebAuthnAuthentication(input: {
  db: D1Database;
  challenge: StoredWebAuthnDiscoveryChallenge;
  credential: StoredPasswordlessWebAuthnCredential;
  newCounter: number;
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  now?: Date;
  createAttemptId?: () => string;
}): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const attemptId = (input.createAttemptId ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE webauthn_discovery_challenges
        SET consumed_by = ?
        WHERE id = ?
          AND challenge = ?
          AND origin = ?
          AND rp_id = ?
          AND consumed_by IS NULL
          AND expires_at_iso > ?
      `).bind(
        attemptId,
        input.challenge.id,
        input.challenge.challenge,
        input.challenge.origin,
        input.challenge.rpId,
        nowIso,
      ),
      input.db.prepare(`
        UPDATE user_webauthn_credentials
        SET
          signature_counter = ?,
          credential_device_type = ?,
          backed_up = ?,
          updated_at_iso = ?,
          last_used_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND credential_id = ?
          AND rp_id = ?
          AND signature_counter = ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            WHERE current_user.id = user_webauthn_credentials.user_id
              AND current_user.status = 'active'
              AND current_user.auth_revision = ?
          )
          AND EXISTS (
            SELECT 1
            FROM webauthn_discovery_challenges consumed
            WHERE consumed.id = ?
              AND consumed.consumed_by = ?
          )
      `).bind(
        input.newCounter,
        input.credentialDeviceType,
        input.credentialBackedUp ? 1 : 0,
        nowIso,
        nowIso,
        input.credential.rowId,
        input.credential.userId,
        input.credential.externalId,
        input.credential.rpId,
        input.credential.oldCounter,
        input.credential.authRevision,
        input.challenge.id,
        attemptId,
      ),
      input.db.prepare(`
        DELETE FROM webauthn_discovery_challenges
        WHERE id = ?
          AND consumed_by = ?
      `).bind(input.challenge.id, attemptId),
    ]);
    return readChanges(results[0]) === 1
      && readChanges(results[1]) === 1
      && readChanges(results[2]) === 1;
  } catch (error) {
    throw writeFailure(
      error,
      'complete_passwordless_webauthn_authentication',
    );
  }
}

export type RegisterWebAuthnCredentialResult =
  | { kind: 'completed'; credential: WebAuthnCredentialSummary }
  | { kind: 'challenge_invalid' }
  | { kind: 'limit_reached' }
  | { kind: 'name_conflict' }
  | { kind: 'credential_conflict' };

export async function registerWebAuthnCredential(input: {
  db: D1Database;
  challenge: StoredWebAuthnChallenge;
  userId: string;
  authRevision: string;
  displayName: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: WebAuthnTransport[];
  credentialDeviceType: CredentialDeviceType;
  credentialBackedUp: boolean;
  attestationFormat: AttestationFormat;
  aaguid?: string;
  now?: Date;
  createId?: () => string;
  createAttemptId?: () => string;
}): Promise<RegisterWebAuthnCredentialResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const rowId = (input.createId ?? createOpaqueId)();
  const attemptId = (input.createAttemptId ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE webauthn_challenges
        SET consumed_by = ?
        WHERE id = ?
          AND user_id = ?
          AND auth_revision = ?
          AND purpose = 'registration'
          AND challenge = ?
          AND origin = ?
          AND rp_id = ?
          AND consumed_by IS NULL
          AND expires_at_iso > ?
      `).bind(
        attemptId,
        input.challenge.id,
        input.userId,
        input.authRevision,
        input.challenge.challenge,
        input.challenge.origin,
        input.challenge.rpId,
        nowIso,
      ),
      input.db.prepare(`
        INSERT INTO user_webauthn_credentials (
          id,
          user_id,
          credential_id,
          public_key,
          signature_counter,
          display_name,
          rp_id,
          transports,
          credential_device_type,
          backed_up,
          attestation_format,
          aaguid,
          created_at_iso,
          updated_at_iso,
          last_used_at_iso
        )
        SELECT
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          NULL
        FROM webauthn_challenges consumed
        WHERE consumed.id = ?
          AND consumed.consumed_by = ?
          AND (
            SELECT COUNT(*)
            FROM user_webauthn_credentials existing
            WHERE existing.user_id = ?
          ) < ?
          AND NOT EXISTS (
            SELECT 1
            FROM user_webauthn_credentials existing
            WHERE existing.credential_id = ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM user_webauthn_credentials existing
            WHERE existing.user_id = ?
              AND existing.display_name = ? COLLATE NOCASE
          )
      `).bind(
        rowId,
        input.userId,
        input.credentialId,
        isoBase64URL.fromBuffer(new Uint8Array(input.publicKey)),
        input.counter,
        input.displayName,
        input.challenge.rpId,
        JSON.stringify([...new Set(input.transports)]),
        input.credentialDeviceType,
        input.credentialBackedUp ? 1 : 0,
        input.attestationFormat,
        normalizeAaguid(input.aaguid),
        nowIso,
        nowIso,
        input.challenge.id,
        attemptId,
        input.userId,
        MAX_WEBAUTHN_CREDENTIALS,
        input.credentialId,
        input.userId,
        input.displayName,
      ),
      input.db.prepare(`
        DELETE FROM webauthn_challenges
        WHERE id = ?
          AND consumed_by = ?
      `).bind(input.challenge.id, attemptId),
    ]);
    if (readChanges(results[0]) !== 1) {
      return { kind: 'challenge_invalid' };
    }
    if (readChanges(results[1]) === 1 && readChanges(results[2]) === 1) {
      const credential = await input.db.prepare(`
        SELECT *
        FROM user_webauthn_credentials
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `).bind(rowId, input.userId).first<WebAuthnCredentialRow>();
      if (!credential) {
        throw new TypeError(
          'D1 did not return the registered WebAuthn credential.',
        );
      }
      return { kind: 'completed', credential: toSummary(credential) };
    }

    const reason = await input.db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM user_webauthn_credentials
          WHERE user_id = ?
        ) AS credential_count,
        EXISTS (
          SELECT 1
          FROM user_webauthn_credentials
          WHERE credential_id = ?
        ) AS credential_conflict,
        EXISTS (
          SELECT 1
          FROM user_webauthn_credentials
          WHERE user_id = ?
            AND display_name = ? COLLATE NOCASE
        ) AS name_conflict
    `).bind(
      input.userId,
      input.credentialId,
      input.userId,
      input.displayName,
    ).first<{
      credential_count: number;
      credential_conflict: number;
      name_conflict: number;
    }>();
    if (!reason) throw new TypeError('D1 did not explain registration.');
    if (reason.credential_count >= MAX_WEBAUTHN_CREDENTIALS) {
      return { kind: 'limit_reached' };
    }
    if (reason.name_conflict) return { kind: 'name_conflict' };
    if (reason.credential_conflict) return { kind: 'credential_conflict' };
    throw new TypeError('D1 returned an incomplete WebAuthn registration.');
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'register_webauthn_credential');
  }
}

export async function renameWebAuthnCredential(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  credentialRowId: string;
  displayName: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; credential: WebAuthnCredentialSummary }
  | { kind: 'not_found' }
  | { kind: 'name_conflict' }
> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const result = await input.db.prepare(`
      UPDATE user_webauthn_credentials
      SET
        display_name = ?,
        updated_at_iso = ?
      WHERE id = ?
        AND user_id = ?
        AND EXISTS (
          SELECT 1
          FROM users current_user
          WHERE current_user.id = user_webauthn_credentials.user_id
            AND current_user.auth_revision = ?
            AND current_user.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM user_webauthn_credentials conflict
          WHERE conflict.user_id = user_webauthn_credentials.user_id
            AND conflict.id != user_webauthn_credentials.id
            AND conflict.display_name = ? COLLATE NOCASE
        )
      )
    `).bind(
      input.displayName,
      nowIso,
      input.credentialRowId,
      input.userId,
      input.authRevision,
      input.displayName,
    ).run();
    if (readChanges(result) === 1) {
      const row = await input.db.prepare(`
        SELECT *
        FROM user_webauthn_credentials
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).bind(
        input.credentialRowId,
        input.userId,
      ).first<WebAuthnCredentialRow>();
      if (!row) throw new TypeError('Renamed credential is unavailable.');
      return { kind: 'completed', credential: toSummary(row) };
    }
    const reason = await input.db.prepare(`
      SELECT
        EXISTS (
          SELECT 1
          FROM user_webauthn_credentials
          WHERE id = ? AND user_id = ?
        ) AS credential_exists,
        EXISTS (
          SELECT 1
          FROM user_webauthn_credentials
          WHERE user_id = ?
            AND id != ?
            AND display_name = ? COLLATE NOCASE
        ) AS name_conflict
    `).bind(
      input.credentialRowId,
      input.userId,
      input.userId,
      input.credentialRowId,
      input.displayName,
    ).first<{ credential_exists: number; name_conflict: number }>();
    return reason?.name_conflict
      ? { kind: 'name_conflict' }
      : { kind: 'not_found' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'rename_webauthn_credential');
  }
}

export async function removeWebAuthnCredential(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  currentSessionId: string;
  credentialRowId: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<
  | { kind: 'completed'; revokedSessions: number }
  | { kind: 'not_found' }
  | { kind: 'challenge_invalid' }
> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextRevision = (input.createRevision ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE user_webauthn_credentials
        SET updated_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            JOIN sessions current_session
              ON current_session.user_id = current_user.id
            WHERE current_user.id = user_webauthn_credentials.user_id
              AND current_user.auth_revision = ?
              AND current_user.status = 'active'
              AND current_session.id = ?
              AND current_session.auth_revision = ?
          )
      `).bind(
        nowIso,
        input.credentialRowId,
        input.userId,
        input.authRevision,
        input.currentSessionId,
        input.authRevision,
      ),
      input.db.prepare(`
        UPDATE users
        SET auth_revision = ?, updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM user_webauthn_credentials marker
            WHERE marker.id = ?
              AND marker.user_id = users.id
              AND marker.updated_at_iso = ?
          )
      `).bind(
        nextRevision,
        nowIso,
        input.userId,
        input.authRevision,
        input.credentialRowId,
        nowIso,
      ),
      input.db.prepare(`
        UPDATE sessions
        SET auth_revision = ?, mfa_verified_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND auth_revision = ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            WHERE current_user.id = sessions.user_id
              AND current_user.auth_revision = ?
          )
      `).bind(
        nextRevision,
        nowIso,
        input.currentSessionId,
        input.userId,
        input.authRevision,
        nextRevision,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND id != ?
          AND EXISTS (
            SELECT 1
            FROM sessions current_session
            JOIN users current_user
              ON current_user.id = current_session.user_id
            WHERE current_session.id = ?
              AND current_session.user_id = sessions.user_id
              AND current_session.auth_revision = ?
              AND current_user.auth_revision = ?
          )
      `).bind(
        input.userId,
        input.currentSessionId,
        input.currentSessionId,
        nextRevision,
        nextRevision,
      ),
      input.db.prepare(`
        INSERT INTO user_webauthn_credentials (
          id,
          user_id,
          credential_id,
          public_key,
          signature_counter,
          display_name,
          rp_id,
          transports,
          credential_device_type,
          backed_up,
          attestation_format,
          aaguid,
          created_at_iso,
          updated_at_iso,
          last_used_at_iso
        )
        SELECT
          marker.id,
          marker.user_id,
          marker.credential_id,
          marker.public_key,
          marker.signature_counter,
          marker.display_name,
          marker.rp_id,
          marker.transports,
          marker.credential_device_type,
          marker.backed_up,
          marker.attestation_format,
          marker.aaguid,
          marker.created_at_iso,
          marker.updated_at_iso,
          marker.last_used_at_iso
        FROM user_webauthn_credentials marker
        WHERE marker.id = ?
          AND marker.user_id = ?
          AND marker.updated_at_iso = ?
          AND NOT EXISTS (
            SELECT 1
            FROM users current_user
            JOIN sessions current_session
              ON current_session.user_id = current_user.id
            WHERE current_user.id = marker.user_id
              AND current_user.auth_revision = ?
              AND current_session.id = ?
              AND current_session.auth_revision = ?
          )
      `).bind(
        input.credentialRowId,
        input.userId,
        nowIso,
        nextRevision,
        input.currentSessionId,
        nextRevision,
      ),
      input.db.prepare(`
        DELETE FROM user_webauthn_credentials
        WHERE id = ?
          AND user_id = ?
          AND updated_at_iso = ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            JOIN sessions current_session
              ON current_session.user_id = current_user.id
            WHERE current_user.id = user_webauthn_credentials.user_id
              AND current_user.auth_revision = ?
              AND current_session.id = ?
              AND current_session.auth_revision = ?
          )
      `).bind(
        input.credentialRowId,
        input.userId,
        nowIso,
        nextRevision,
        input.currentSessionId,
        nextRevision,
      ),
    ]);
    if (readChanges(results[0]) !== 1) {
      const exists = await input.db.prepare(`
        SELECT 1 AS found
        FROM user_webauthn_credentials
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).bind(
        input.credentialRowId,
        input.userId,
      ).first<{ found: number }>();
      return exists ? { kind: 'challenge_invalid' } : { kind: 'not_found' };
    }
    if (
      readChanges(results[1]) !== 1
      || readChanges(results[2]) !== 1
      || readChanges(results[5]) !== 1
    ) {
      throw new TypeError(
        'D1 returned an incomplete WebAuthn credential removal result.',
      );
    }
    return {
      kind: 'completed',
      revokedSessions: readChanges(results[3]),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'remove_webauthn_credential');
  }
}

export async function garbageCollectWebAuthnChallenges(input: {
  db: D1Database;
  now?: Date;
}): Promise<{ deletedRows: number; cutoffAtIso: string }> {
  const cutoffAtIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        DELETE FROM webauthn_challenges
        WHERE expires_at_iso <= ?
          OR consumed_by IS NOT NULL
      `).bind(cutoffAtIso),
      input.db.prepare(`
        DELETE FROM webauthn_discovery_challenges
        WHERE expires_at_iso <= ?
          OR consumed_by IS NOT NULL
      `).bind(cutoffAtIso),
    ]);
    return {
      deletedRows: readChanges(results[0]) + readChanges(results[1]),
      cutoffAtIso,
    };
  } catch (error) {
    throw writeFailure(error, 'garbage_collect_webauthn_challenges');
  }
}
