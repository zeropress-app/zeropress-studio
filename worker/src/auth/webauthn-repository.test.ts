import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WebAuthnTransport } from '../../../contracts/webauthn';
import {
  completePasswordlessWebAuthnAuthentication,
  completeWebAuthnAuthentication,
  createWebAuthnDiscoveryChallenge,
  createWebAuthnChallenge,
  garbageCollectWebAuthnChallenges,
  getStoredPasswordlessWebAuthnCredential,
  getStoredWebAuthnCredential,
  getWebAuthnDiscoveryChallenge,
  getWebAuthnChallenge,
  listUserWebAuthnCredentials,
  listWebAuthnAuthenticationCredentials,
  registerWebAuthnCredential,
  removeWebAuthnCredential,
  renameWebAuthnCredential,
} from './webauthn-repository';

type SqliteRunResult = {
  changes: number | bigint;
};

class SqliteD1Statement {
  readonly sql: string;
  readonly params: unknown[];
  readonly database: DatabaseSync;

  constructor(
    database: DatabaseSync,
    sql: string,
    params: unknown[] = [],
  ) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async run(): Promise<D1Result<unknown>> {
    const statement = this.database.prepare(this.sql);
    const result = (
      statement.run as (...params: unknown[]) => SqliteRunResult
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    const statement = this.database.prepare(this.sql);
    return (
      statement.get as (...params: unknown[]) => T | undefined
    )(...this.params) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const statement = this.database.prepare(this.sql);
    const results = (
      statement.all as (...params: unknown[]) => T[]
    )(...this.params);
    return {
      success: true,
      results,
      meta: {},
    } as unknown as D1Result<T>;
  }
}

function createTestDatabase(): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, d1 };
}

function seedUserAndSessions(database: DatabaseSync): {
  userId: string;
  authRevision: string;
  currentSessionId: string;
} {
  const userId = '1'.repeat(32);
  const authRevision = '2'.repeat(32);
  const currentSessionId = '3'.repeat(32);
  const now = '2026-07-31T12:00:00.000Z';
  database.prepare(`
    INSERT INTO users (
      id,
      email,
      password_hash,
      auth_revision,
      name,
      status,
      email_verified,
      created_at_iso,
      updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(
    userId,
    'owner@example.com',
    'password-hash',
    authRevision,
    'Studio Owner',
    now,
    now,
  );
  const insertSession = database.prepare(`
    INSERT INTO sessions (
      id,
      user_id,
      secret_digest,
      auth_revision,
      ip_address,
      created_at_iso,
      last_seen_at_iso,
      idle_expires_at_iso,
      absolute_expires_at_iso,
      mfa_verified_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run(
    currentSessionId,
    userId,
    '4'.repeat(64),
    authRevision,
    '127.0.0.1',
    now,
    now,
    '2026-08-01T00:00:00.000Z',
    '2026-08-07T12:00:00.000Z',
    now,
  );
  insertSession.run(
    '5'.repeat(32),
    userId,
    '6'.repeat(64),
    authRevision,
    '203.0.113.10',
    now,
    now,
    '2026-08-01T00:00:00.000Z',
    '2026-08-07T12:00:00.000Z',
    now,
  );
  return { userId, authRevision, currentSessionId };
}

describe('WebAuthn D1 repository', () => {
  it('registers, renames, authenticates once, and removes a credential', async () => {
    const { database, d1 } = createTestDatabase();
    const identity = seedUserAndSessions(database);
    const transports: WebAuthnTransport[] = [
      'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
    ];
    const now = new Date('2026-07-31T12:00:00.000Z');
    const registrationToken = '7'.repeat(32);
    const registrationChallenge = await createWebAuthnChallenge({
      db: d1,
      userId: identity.userId,
      sessionId: identity.currentSessionId,
      authRevision: identity.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      challenge: 'registration_challenge_value_1234567890',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now,
      createId: () => registrationToken,
    });
    const storedRegistrationChallenge = await getWebAuthnChallenge({
      db: d1,
      token: registrationChallenge.token,
      userId: identity.userId,
      sessionId: identity.currentSessionId,
      authRevision: identity.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      now,
    });
    expect(storedRegistrationChallenge).not.toBeNull();

    const registered = await registerWebAuthnCredential({
      db: d1,
      challenge: storedRegistrationChallenge!,
      userId: identity.userId,
      authRevision: identity.authRevision,
      displayName: 'MacBook Touch ID',
      credentialId: 'credential_id',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      attestationFormat: 'none',
      aaguid: '00000000-0000-0000-0000-000000000000',
      now,
      createId: () => '8'.repeat(32),
      createAttemptId: () => '9'.repeat(32),
    });
    expect(registered).toMatchObject({
      kind: 'completed',
      credential: {
        id: '8'.repeat(32),
        display_name: 'MacBook Touch ID',
        rp_id: 'studio.example.com',
        transports,
        backed_up: true,
        attestation_format: 'none',
        aaguid: null,
      },
    });
    await expect(getWebAuthnChallenge({
      db: d1,
      token: registrationChallenge.token,
      userId: identity.userId,
      sessionId: identity.currentSessionId,
      authRevision: identity.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      now,
    })).resolves.toBeNull();

    await expect(renameWebAuthnCredential({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      credentialRowId: '8'.repeat(32),
      displayName: 'Primary passkey',
      now,
    })).resolves.toMatchObject({
      kind: 'completed',
      credential: { display_name: 'Primary passkey' },
    });
    await expect(listUserWebAuthnCredentials({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
    })).resolves.toEqual([expect.objectContaining({ transports })]);
    await expect(listWebAuthnAuthenticationCredentials({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      rpId: 'studio.example.com',
    })).resolves.toEqual([{ id: 'credential_id', transports }]);

    const loginChallengeToken = 'a'.repeat(32);
    await createWebAuthnChallenge({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      purpose: 'login',
      challenge: 'authentication_challenge_value_123456',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now,
      createId: () => loginChallengeToken,
    });
    const loginChallenge = await getWebAuthnChallenge({
      db: d1,
      token: loginChallengeToken,
      userId: identity.userId,
      authRevision: identity.authRevision,
      purpose: 'login',
      now,
    });
    const storedCredential = await getStoredWebAuthnCredential({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      rpId: 'studio.example.com',
      credentialId: 'credential_id',
    });
    expect(loginChallenge).not.toBeNull();
    expect(storedCredential?.credential.publicKey)
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(storedCredential?.credential.transports).toEqual(transports);

    await expect(completeWebAuthnAuthentication({
      db: d1,
      challenge: loginChallenge!,
      credential: storedCredential!,
      newCounter: 1,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      now,
      createAttemptId: () => 'b'.repeat(32),
    })).resolves.toBe(true);
    await expect(completeWebAuthnAuthentication({
      db: d1,
      challenge: loginChallenge!,
      credential: storedCredential!,
      newCounter: 1,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      now,
      createAttemptId: () => 'c'.repeat(32),
    })).resolves.toBe(false);

    await expect(removeWebAuthnCredential({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      currentSessionId: identity.currentSessionId,
      credentialRowId: '8'.repeat(32),
      now,
      createRevision: () => 'd'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      revokedSessions: 1,
    });
    expect(database.prepare(`
      SELECT auth_revision FROM users WHERE id = ?
    `).get(identity.userId)).toEqual({
      auth_revision: 'd'.repeat(32),
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?
    `).get(identity.userId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM user_webauthn_credentials
      WHERE user_id = ?
    `).get(identity.userId)).toEqual({ count: 0 });
  });

  it('preserves a valid best-effort AAGUID and attestation format', async () => {
    const { database, d1 } = createTestDatabase();
    const identity = seedUserAndSessions(database);
    const now = new Date('2026-07-31T12:00:00.000Z');
    const challengeToken = 'e'.repeat(32);
    await createWebAuthnChallenge({
      db: d1,
      userId: identity.userId,
      sessionId: identity.currentSessionId,
      authRevision: identity.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      challenge: 'direct_attestation_challenge_value_12345',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now,
      createId: () => challengeToken,
    });
    const challenge = await getWebAuthnChallenge({
      db: d1,
      token: challengeToken,
      userId: identity.userId,
      sessionId: identity.currentSessionId,
      authRevision: identity.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      now,
    });

    await expect(registerWebAuthnCredential({
      db: d1,
      challenge: challenge!,
      userId: identity.userId,
      authRevision: identity.authRevision,
      displayName: 'Roaming security key',
      credentialId: 'direct_credential_id',
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 0,
      transports: ['usb'],
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      attestationFormat: 'packed',
      aaguid: '08987058-CADC-4B81-B6E1-30DE50DCBE96',
      now,
      createId: () => 'f'.repeat(32),
      createAttemptId: () => '0'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      credential: {
        attestation_format: 'packed',
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      },
    });
    expect(database.prepare(`
      SELECT aaguid
      FROM user_webauthn_credentials
      WHERE id = ?
    `).get('f'.repeat(32))).toEqual({
      aaguid: '08987058cadc4b81b6e130de50dcbe96',
    });
  });

  it('discovers an active credential and consumes its anonymous challenge once', async () => {
    const { database, d1 } = createTestDatabase();
    const identity = seedUserAndSessions(database);
    const now = new Date('2026-08-11T12:00:00.000Z');
    database.prepare(`
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
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'multiDevice', 1, 'none', NULL, ?, ?, NULL)
    `).run(
      'e'.repeat(32),
      identity.userId,
      'discoverable_credential',
      'AQID',
      'Primary passkey',
      'studio.example.com',
      '["internal"]',
      now.toISOString(),
      now.toISOString(),
    );

    const created = await createWebAuthnDiscoveryChallenge({
      db: d1,
      challenge: 'discovery_challenge_value_1234567890',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now,
      createId: () => 'f'.repeat(32),
    });
    const challenge = await getWebAuthnDiscoveryChallenge({
      db: d1,
      token: created.token,
      now,
    });
    const credential = await getStoredPasswordlessWebAuthnCredential({
      db: d1,
      rpId: 'studio.example.com',
      credentialId: 'discoverable_credential',
    });

    expect(challenge).not.toBeNull();
    expect(credential).toMatchObject({
      userId: identity.userId,
      authRevision: identity.authRevision,
      oldCounter: 1,
    });
    await expect(completePasswordlessWebAuthnAuthentication({
      db: d1,
      challenge: challenge!,
      credential: credential!,
      newCounter: 2,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      now,
      createAttemptId: () => '0'.repeat(32),
    })).resolves.toBe(true);
    await expect(completePasswordlessWebAuthnAuthentication({
      db: d1,
      challenge: challenge!,
      credential: credential!,
      newCounter: 2,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      now,
      createAttemptId: () => 'a'.repeat(32),
    })).resolves.toBe(false);
    await expect(getWebAuthnDiscoveryChallenge({
      db: d1,
      token: created.token,
      now,
    })).resolves.toBeNull();
    expect(database.prepare(`
      SELECT signature_counter, last_used_at_iso
      FROM user_webauthn_credentials
      WHERE id = ?
    `).get('e'.repeat(32))).toEqual({
      signature_counter: 2,
      last_used_at_iso: now.toISOString(),
    });
  });

  it('garbage collects both account-bound and discovery challenges', async () => {
    const { database, d1 } = createTestDatabase();
    const identity = seedUserAndSessions(database);
    const createdAt = new Date('2026-08-11T11:50:00.000Z');
    await createWebAuthnChallenge({
      db: d1,
      userId: identity.userId,
      authRevision: identity.authRevision,
      purpose: 'login',
      challenge: 'account_challenge_value_123456789012',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now: createdAt,
      ttlSeconds: 60,
      createId: () => 'b'.repeat(32),
    });
    await createWebAuthnDiscoveryChallenge({
      db: d1,
      challenge: 'discovery_challenge_value_1234567890',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      now: createdAt,
      ttlSeconds: 60,
      createId: () => 'c'.repeat(32),
    });

    await expect(garbageCollectWebAuthnChallenges({
      db: d1,
      now: new Date('2026-08-11T12:00:00.000Z'),
    })).resolves.toEqual({
      deletedRows: 2,
      cutoffAtIso: '2026-08-11T12:00:00.000Z',
    });
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM webauthn_challenges) AS account_count,
        (SELECT COUNT(*) FROM webauthn_discovery_challenges) AS discovery_count
    `).get()).toEqual({ account_count: 0, discovery_count: 0 });
  });
});
