import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cancelManagedUserInvitation,
  completeUserSetup,
  createManagedUserInvitation,
  deleteInactiveManagedUserAccount,
  getEligibleUserSetup,
  inspectManagedUserDeletionImpact,
  listManagedUsers,
  prepareUserSetup,
  reissueManagedUserInvitation,
  resetManagedUserAccess,
  updateManagedUserName,
  updateManagedUserRole,
  updateManagedUserStatus,
} from './user-repository';

type SqliteRunResult = { changes: number | bigint };
type SqliteChangeCountRow = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async run(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/i.test(this.sql)) return this.all();
    const statement = this.database.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = (statement.all as (
        ...params: unknown[]
      ) => Record<string, unknown>[])(...this.params);
      // D1 meta.changes follows total-change semantics and can include
      // cascades. Deliberately keep it independent from the direct rows
      // identified by RETURNING so this test double catches regressions.
      const changeRow = this.database.prepare(`
        SELECT total_changes() AS changes
      `).get() as SqliteChangeCountRow;
      return {
        success: true,
        results,
        meta: { changes: Number(changeRow.changes) },
      } as unknown as D1Result<unknown>;
    }
    const result = (
      statement.run as (
        ...params: unknown[]
      ) => SqliteRunResult
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (
      this.database.prepare(this.sql).get as (
        ...params: unknown[]
      ) => T | undefined
    )(...this.params) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (
        ...params: unknown[]
      ) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }
}

function createTestDatabase() {
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

const NOW = new Date('2026-08-01T00:00:00.000Z');
const ADMIN_ID = '1'.repeat(32);
const ADMIN_REVISION = '2'.repeat(32);
const DEFAULT_LIST_QUERY = {
  search: '',
  role: 'all',
  status: 'all',
  page: 1,
  per_page: 50,
} as const;

function seedRolesAndAdministrator(database: DatabaseSync) {
  const nowIso = NOW.toISOString();
  const insertRole = database.prepare(`
    INSERT INTO roles (
      key, name, description, is_system, created_at_iso, updated_at_iso
    ) VALUES (?, ?, '', 1, ?, ?)
  `);
  for (const role of ['admin', 'editor', 'author']) {
    insertRole.run(role, role, nowIso, nowIso);
  }
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(
    ADMIN_ID,
    'owner@example.com',
    'admin-password-hash',
    ADMIN_REVISION,
    'Studio Owner',
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO user_roles (user_id, role_key, created_at_iso)
    VALUES (?, 'admin', ?)
  `).run(ADMIN_ID, nowIso);
}

describe('user management D1 repository', () => {
  it('returns the optional linked public Author identity', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES ('Studio-Owner', ?, 'Studio Owner', ?, ?, ?)
    `).run(
      ADMIN_ID,
      '3'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await expect(listManagedUsers({
      db: d1,
      query: DEFAULT_LIST_QUERY,
      now: NOW,
    })).resolves.toMatchObject({
      items: [{
        id: ADMIN_ID,
        author: { id: 'Studio-Owner', display_name: 'Studio Owner' },
      }],
      pagination: {
        page: 1,
        per_page: 50,
        total: 1,
        total_pages: 1,
      },
      status_counts: { all: 1, pending: 0, active: 1, inactive: 0 },
      summary: {
        total: 1,
        pending: 0,
        active: 1,
        inactive: 0,
        administrators: 1,
      },
    });
  });

  it('searches name and email, filters roles and statuses, and paginates deterministically', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const insertUser = database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, ?, 'password-hash', ?, ?, ?, 1, ?, ?)
    `);
    const insertRole = database.prepare(`
      INSERT INTO user_roles (user_id, role_key, created_at_iso)
      VALUES (?, ?, ?)
    `);
    const users = [
      {
        id: '3'.repeat(32),
        email: 'beta.author@example.com',
        name: 'Beta Writer',
        status: 'pending',
        role: 'author',
        created: '2026-08-02T00:00:00.000Z',
      },
      {
        id: '4'.repeat(32),
        email: 'gamma.author@example.com',
        name: 'Gamma Writer',
        status: 'inactive',
        role: 'author',
        created: '2026-08-03T00:00:00.000Z',
      },
      {
        id: '5'.repeat(32),
        email: 'site.editor@example.com',
        name: 'Site Editor',
        status: 'active',
        role: 'editor',
        created: '2026-08-04T00:00:00.000Z',
      },
    ] as const;
    for (const user of users) {
      insertUser.run(
        user.id,
        user.email,
        user.id,
        user.name,
        user.status,
        user.created,
        user.created,
      );
      insertRole.run(user.id, user.role, user.created);
    }

    const pageOne = await listManagedUsers({
      db: d1,
      query: {
        search: 'AUTHOR@EXAMPLE',
        role: 'author',
        status: 'all',
        page: 1,
        per_page: 1,
      },
      now: NOW,
    });
    expect(pageOne.items.map((user) => user.id)).toEqual(['4'.repeat(32)]);
    expect(pageOne.pagination).toEqual({
      page: 1,
      per_page: 1,
      total: 2,
      total_pages: 2,
    });
    expect(pageOne.status_counts).toEqual({
      all: 2,
      pending: 1,
      active: 0,
      inactive: 1,
    });
    expect(pageOne.summary).toEqual({
      total: 4,
      pending: 1,
      active: 2,
      inactive: 1,
      administrators: 1,
    });

    const pageTwo = await listManagedUsers({
      db: d1,
      query: {
        search: 'writer',
        role: 'author',
        status: 'all',
        page: 2,
        per_page: 1,
      },
      now: NOW,
    });
    expect(pageTwo.items.map((user) => user.id)).toEqual(['3'.repeat(32)]);

    const pending = await listManagedUsers({
      db: d1,
      query: {
        search: '',
        role: 'author',
        status: 'pending',
        page: 1,
        per_page: 50,
      },
      now: NOW,
    });
    expect(pending.items.map((user) => user.name)).toEqual(['Beta Writer']);
    expect(pending.pagination.total).toBe(1);
    expect(pending.status_counts).toEqual({
      all: 2,
      pending: 1,
      active: 0,
      inactive: 1,
    });
    expect(pending.summary).toEqual(pageOne.summary);
  });

  it('renames only the private account under optimistic concurrency', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES ('Studio-Owner', ?, 'Public Studio Owner', ?, ?, ?)
    `).run(
      ADMIN_ID,
      '3'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    const changedAt = new Date('2026-08-01T00:01:00.000Z');

    await expect(updateManagedUserName({
      db: d1,
      userId: ADMIN_ID,
      name: 'Editorial Owner',
      expectedUpdatedAtIso: NOW.toISOString(),
      now: changedAt,
    })).resolves.toMatchObject({
      kind: 'completed',
      user: {
        name: 'Editorial Owner',
        author: { display_name: 'Public Studio Owner' },
        updated_at_iso: changedAt.toISOString(),
      },
    });
    expect(database.prepare(`
      SELECT name, auth_revision, updated_at_iso FROM users WHERE id = ?
    `).get(ADMIN_ID)).toEqual({
      name: 'Editorial Owner',
      auth_revision: ADMIN_REVISION,
      updated_at_iso: changedAt.toISOString(),
    });
    expect(database.prepare(`
      SELECT display_name FROM authors WHERE user_id = ?
    `).get(ADMIN_ID)).toEqual({ display_name: 'Public Studio Owner' });

    await expect(updateManagedUserName({
      db: d1,
      userId: ADMIN_ID,
      name: 'Stale Rename',
      expectedUpdatedAtIso: NOW.toISOString(),
      now: new Date('2026-08-01T00:02:00.000Z'),
    })).resolves.toEqual({ kind: 'state_conflict' });
  });

  it('keeps an invited user pending until password and mandatory MFA commit together', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const setupTokenId = '3'.repeat(32);
    const digest = '4'.repeat(64);
    const created = await createManagedUserInvitation({
      db: d1,
      administratorId: ADMIN_ID,
      email: 'author@example.com',
      name: 'Invited Author',
      role: 'author',
      pendingPasswordHash: 'valid-placeholder-hash',
      setupTokenId,
      secretDigest: digest,
      now: NOW,
      expiresAt: new Date('2026-08-02T00:00:00.000Z'),
      createUserId: () => '5'.repeat(32),
    });
    expect(created).toMatchObject({
      kind: 'completed',
      user: {
        status: 'pending',
        role: 'author',
        setup: { purpose: 'invitation', status: 'pending' },
      },
    });
    await expect(getEligibleUserSetup({
      db: d1,
      setupTokenId,
      secretDigest: digest,
      now: NOW,
    })).resolves.toMatchObject({
      userId: '5'.repeat(32),
      role: 'author',
    });

    const setupNonce = '6'.repeat(32);
    const prepared = await prepareUserSetup({
      db: d1,
      setupTokenId,
      secretDigest: digest,
      pendingPasswordHash: '$argon2id$accepted-password-hash',
      setupNonce,
      now: NOW,
    });
    expect(prepared).not.toBeNull();
    await expect(completeUserSetup({
      db: d1,
      setupTokenId,
      userId: '5'.repeat(32),
      authRevision: prepared!.authRevision,
      setupNonce,
      encryptedTotpSecret: {
        ciphertext: 'encrypted-secret-value',
        iv: '0123456789abcdef',
      },
      lastUsedStep: 123,
      now: NOW,
      nextAuthRevision: '7'.repeat(32),
      createFactorId: () => '8'.repeat(32),
    })).resolves.toBe('completed');
    expect(database.prepare(`
      SELECT status, password_hash, auth_revision
      FROM users WHERE id = ?
    `).get('5'.repeat(32))).toEqual({
      status: 'active',
      password_hash: '$argon2id$accepted-password-hash',
      auth_revision: '7'.repeat(32),
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM user_mfa_factors
      WHERE user_id = ?
    `).get('5'.repeat(32))).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT consumed_at_iso, pending_password_hash, setup_nonce
      FROM user_setup_tokens WHERE id = ?
    `).get(setupTokenId)).toEqual({
      consumed_at_iso: NOW.toISOString(),
      pending_password_hash: null,
      setup_nonce: null,
    });
    await expect(completeUserSetup({
      db: d1,
      setupTokenId,
      userId: '5'.repeat(32),
      authRevision: prepared!.authRevision,
      setupNonce,
      encryptedTotpSecret: {
        ciphertext: 'encrypted-secret-value',
        iv: '0123456789abcdef',
      },
      lastUsedStep: 123,
      now: NOW,
      nextAuthRevision: '9'.repeat(32),
    })).resolves.toBe('setup_invalid');
  });

  it('distinguishes unchanged role and status requests without rotating authentication', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    await expect(updateManagedUserRole({
      db: d1, userId: ADMIN_ID, role: 'admin', nextAuthRevision: '3'.repeat(32), now: NOW,
    })).resolves.toMatchObject({ kind: 'completed', changed: false, revokedSessions: 0 });
    await expect(updateManagedUserStatus({
      db: d1, userId: ADMIN_ID, status: 'active', nextAuthRevision: '4'.repeat(32), now: NOW,
    })).resolves.toMatchObject({ kind: 'completed', changed: false, revokedSessions: 0 });
    expect(database.prepare('SELECT auth_revision FROM users WHERE id = ?').get(ADMIN_ID))
      .toEqual({ auth_revision: ADMIN_REVISION });
  });

  it('protects the last active administrator and revokes sessions on a real role change', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    await expect(updateManagedUserRole({
      db: d1,
      userId: ADMIN_ID,
      role: 'editor',
      nextAuthRevision: '3'.repeat(32),
      now: NOW,
    })).resolves.toEqual({ kind: 'last_admin' });

    const nowIso = NOW.toISOString();
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
    `).run(
      '4'.repeat(32),
      'second@example.com',
      'password-hash',
      '5'.repeat(32),
      'Second Admin',
      nowIso,
      nowIso,
    );
    database.prepare(`
      INSERT INTO user_roles (user_id, role_key, created_at_iso)
      VALUES (?, 'admin', ?)
    `).run('4'.repeat(32), nowIso);
    database.prepare(`
      INSERT INTO sessions (
        id, user_id, secret_digest, auth_revision, ip_address,
        created_at_iso, last_seen_at_iso, idle_expires_at_iso,
        absolute_expires_at_iso, mfa_verified_at_iso
      ) VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, ?, ?, ?)
    `).run(
      '6'.repeat(32),
      ADMIN_ID,
      '7'.repeat(64),
      ADMIN_REVISION,
      nowIso,
      nowIso,
      '2026-08-01T12:00:00.000Z',
      '2026-08-08T00:00:00.000Z',
      nowIso,
    );
    const changed = await updateManagedUserRole({
      db: d1,
      userId: ADMIN_ID,
      role: 'editor',
      nextAuthRevision: '8'.repeat(32),
      now: NOW,
    });
    expect(changed).toMatchObject({
      kind: 'completed',
      user: { role: 'editor' },
      changed: true,
      revokedSessions: 1,
    });
  });

  it('cancels and safely reissues a factorless invitation', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const created = await createManagedUserInvitation({
      db: d1,
      administratorId: ADMIN_ID,
      email: 'editor@example.com',
      name: 'Invited Editor',
      role: 'editor',
      pendingPasswordHash: 'valid-placeholder-hash',
      setupTokenId: '3'.repeat(32),
      secretDigest: '4'.repeat(64),
      now: NOW,
      expiresAt: new Date('2026-08-02T00:00:00.000Z'),
      createUserId: () => '5'.repeat(32),
    });
    expect(created.kind).toBe('completed');
    await expect(updateManagedUserStatus({
      db: d1,
      userId: '5'.repeat(32),
      status: 'inactive',
      nextAuthRevision: '6'.repeat(32),
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      user: { status: 'inactive', setup: null },
    });
    await expect(reissueManagedUserInvitation({
      db: d1,
      administratorId: ADMIN_ID,
      userId: '5'.repeat(32),
      setupTokenId: '7'.repeat(32),
      secretDigest: '8'.repeat(64),
      expiresAt: new Date('2026-08-02T12:00:00.000Z'),
      nextAuthRevision: '9'.repeat(32),
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      user: {
        status: 'pending',
        setup: { purpose: 'invitation', status: 'pending' },
      },
    });
  });

  it('revokes every sign-in credential and issues one credential-recovery setup', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const nowIso = NOW.toISOString();
    const targetId = '4'.repeat(32);
    const targetRevision = '5'.repeat(32);
    const sessionId = '7'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
    `).run(
      targetId,
      'author@example.com',
      '$argon2id$current-password',
      targetRevision,
      'Site Author',
      nowIso,
      nowIso,
    );
    database.prepare(`
      INSERT INTO user_roles (user_id, role_key, created_at_iso)
      VALUES (?, 'author', ?)
    `).run(targetId, nowIso);
    database.prepare(`
      INSERT INTO user_mfa_factors (
        id, user_id, factor_type, secret_ciphertext, secret_iv,
        last_used_step, created_at_iso, verified_at_iso
      ) VALUES (?, ?, 'totp', ?, ?, 123, ?, ?)
    `).run(
      '6'.repeat(32),
      targetId,
      'encrypted-secret-value',
      'initialization-vector',
      nowIso,
      nowIso,
    );
    database.prepare(`
      INSERT INTO sessions (
        id, user_id, secret_digest, auth_revision, ip_address,
        created_at_iso, last_seen_at_iso, idle_expires_at_iso,
        absolute_expires_at_iso, mfa_verified_at_iso
      ) VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      targetId,
      'd'.repeat(64),
      targetRevision,
      nowIso,
      nowIso,
      '2026-08-01T12:00:00.000Z',
      '2026-08-08T00:00:00.000Z',
      nowIso,
    );
    database.prepare(`
      INSERT INTO user_webauthn_credentials (
        id, user_id, credential_id, public_key, signature_counter,
        display_name, rp_id, transports, credential_device_type,
        backed_up, attestation_format, created_at_iso, updated_at_iso
      ) VALUES (?, ?, 'credential_A', 'AQID', 0, 'MacBook',
        'studio.local', '["internal"]', 'multiDevice', 1, 'none', ?, ?)
    `).run('8'.repeat(32), targetId, nowIso, nowIso);
    database.prepare(`
      INSERT INTO webauthn_challenges (
        id, user_id, session_id, auth_revision, purpose, operation,
        target_id, challenge, origin, rp_id, created_at_iso,
        expires_at_iso
      ) VALUES (?, ?, ?, ?, 'management_step_up', 'change_password',
        NULL, ?, 'https://studio.local', 'studio.local', ?, ?)
    `).run(
      '9'.repeat(32),
      targetId,
      sessionId,
      targetRevision,
      'challenge_value_with_at_least_32_chars',
      nowIso,
      '2026-08-01T00:05:00.000Z',
    );

    await expect(resetManagedUserAccess({
      db: d1,
      administratorId: ADMIN_ID,
      userId: targetId,
      setupTokenId: 'a'.repeat(32),
      secretDigest: 'b'.repeat(64),
      expiresAt: new Date('2026-08-01T01:00:00.000Z'),
      nextAuthRevision: 'e'.repeat(32),
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      revokedSessions: 1,
      reissued: false,
      user: {
        status: 'pending',
        role: 'author',
        setup: {
          purpose: 'credential_recovery',
          status: 'pending',
        },
        mfa: {
          totp_configured: false,
          webauthn_credentials: 0,
        },
      },
    });
    for (const table of [
      'sessions',
      'user_mfa_factors',
      'user_webauthn_credentials',
      'webauthn_challenges',
    ]) {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`,
      ).get(targetId)).toEqual({ count: 0 });
    }
    expect(database.prepare(`
      SELECT purpose, created_by, secret_digest, expires_at_iso
      FROM user_setup_tokens WHERE user_id = ?
    `).get(targetId)).toEqual({
      purpose: 'credential_recovery',
      created_by: ADMIN_ID,
      secret_digest: 'b'.repeat(64),
      expires_at_iso: '2026-08-01T01:00:00.000Z',
    });
  });

  it('does not reset the last active administrator', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    await expect(resetManagedUserAccess({
      db: d1,
      administratorId: ADMIN_ID,
      userId: ADMIN_ID,
      setupTokenId: 'a'.repeat(32),
      secretDigest: 'b'.repeat(64),
      expiresAt: new Date('2026-08-01T01:00:00.000Z'),
      nextAuthRevision: 'e'.repeat(32),
      now: NOW,
    })).resolves.toEqual({ kind: 'last_admin' });
    expect(database.prepare(`
      SELECT status, auth_revision FROM users WHERE id = ?
    `).get(ADMIN_ID)).toEqual({
      status: 'active',
      auth_revision: ADMIN_REVISION,
    });
  });

  it('cancels only a factorless invitation when D1 reports cascade changes and preserves its public Author identity', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const userId = '3'.repeat(32);
    await createManagedUserInvitation({
      db: d1,
      administratorId: ADMIN_ID,
      email: 'invited@example.com',
      name: 'Invited Author',
      role: 'author',
      pendingPasswordHash: 'valid-placeholder-hash',
      setupTokenId: '4'.repeat(32),
      secretDigest: '5'.repeat(64),
      now: NOW,
      expiresAt: new Date('2026-08-02T00:00:00.000Z'),
      createUserId: () => userId,
    });
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES ('Invited-Author', ?, 'Invited Author', ?, ?, ?)
    `).run(
      userId,
      '6'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    await expect(inspectManagedUserDeletionImpact({
      db: d1,
      userId,
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      impact: {
        operation: 'cancel_invitation',
        effects: {
          post_autosaves: 0,
          page_autosaves: 0,
          media_upload_intents: 0,
        },
      },
    });
    await expect(cancelManagedUserInvitation({
      db: d1,
      administratorId: ADMIN_ID,
      userId,
      confirmationEmail: 'invited@example.com',
      now: NOW,
      createRevision: () => '7'.repeat(32),
    })).resolves.toEqual({ kind: 'completed', deletedName: 'Invited Author', deletedEmail: 'invited@example.com' });

    expect(database.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?')
      .get(userId)).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT user_id, revision, updated_at_iso
      FROM authors WHERE id = 'Invited-Author'
    `).get()).toEqual({
      user_id: null,
      revision: '7'.repeat(32),
      updated_at_iso: NOW.toISOString(),
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM user_setup_tokens WHERE user_id = ?
    `).get(userId)).toEqual({ count: 0 });
  });

  it('deletes an inactive account atomically while preserving public content and queuing pending R2 cleanup', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const nowIso = NOW.toISOString();
    const userId = '3'.repeat(32);
    const authorId = 'Former-Author';
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, 'former@example.com', 'password-hash', ?,
        'Former Author', 'inactive', 1, ?, ?)
    `).run(userId, '4'.repeat(32), nowIso, nowIso);
    database.prepare(`
      INSERT INTO user_roles (user_id, role_key, created_at_iso)
      VALUES (?, 'author', ?)
    `).run(userId, nowIso);
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, 'Former Author', ?, ?, ?)
    `).run(authorId, userId, '5'.repeat(32), nowIso, nowIso);
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, author_id, created_at_iso, updated_at_iso
      ) VALUES (?, 101, 'Preserved post', 'preserved-post', ?, ?, ?)
    `).run('6'.repeat(32), authorId, nowIso, nowIso);
    for (const table of ['post_autosaves', 'page_autosaves']) {
      database.prepare(`
        INSERT INTO ${table} (
          user_id, draft_id, snapshot_version, snapshot_json,
          snapshot_sha256, created_at_iso, updated_at_iso, expires_at_iso
        ) VALUES (?, ?, 1, '{}', ?, ?, ?, ?)
      `).run(
        userId,
        table === 'post_autosaves' ? '7'.repeat(32) : '8'.repeat(32),
        '9'.repeat(64),
        nowIso,
        nowIso,
        '2026-08-02T00:00:00.000Z',
      );
    }
    const storageKey = `uploads/2026/08/${'a'.repeat(32)}.pdf`;
    database.prepare(`
      INSERT INTO media_upload_intents (
        id, media_id, user_id, filename, kind, mime_type, extension,
        signature, disposition, storage_key, size_bytes, width, height,
        duration_ms, alt, created_at_iso, expires_at_iso
      ) VALUES (?, ?, ?, 'document.pdf', 'document', 'application/pdf',
        'pdf', 'pdf', 'attachment', ?, 1024, NULL, NULL, NULL, '', ?, ?)
    `).run(
      'b'.repeat(32),
      'a'.repeat(32),
      userId,
      storageKey,
      nowIso,
      '2026-08-02T00:00:00.000Z',
    );

    await expect(inspectManagedUserDeletionImpact({
      db: d1,
      userId,
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      impact: {
        operation: 'delete_account',
        effects: {
          post_autosaves: 1,
          page_autosaves: 1,
          media_upload_intents: 1,
        },
      },
    });
    await expect(deleteInactiveManagedUserAccount({
      db: d1,
      administratorId: ADMIN_ID,
      userId,
      confirmationEmail: 'former@example.com',
      now: NOW,
      createRevision: () => 'c'.repeat(32),
    })).resolves.toEqual({ kind: 'completed', deletedName: 'Former Author', deletedEmail: 'former@example.com' });

    for (const table of [
      'users',
      'post_autosaves',
      'page_autosaves',
      'media_upload_intents',
    ]) {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${
          table === 'users' ? 'id' : 'user_id'
        } = ?`,
      ).get(userId)).toEqual({ count: 0 });
    }
    expect(database.prepare(`
      SELECT user_id, revision FROM authors WHERE id = ?
    `).get(authorId)).toEqual({
      user_id: null,
      revision: 'c'.repeat(32),
    });
    expect(database.prepare(`
      SELECT author_id FROM posts WHERE id = ?
    `).get('6'.repeat(32))).toEqual({ author_id: authorId });
    expect(database.prepare(`
      SELECT storage_key, attempt_count FROM media_object_deletions
      WHERE storage_key = ?
    `).get(storageKey)).toEqual({ storage_key: storageKey, attempt_count: 0 });
  });

  it('does not mutate an active account or accept a mismatched confirmation email', async () => {
    const { database, d1 } = createTestDatabase();
    seedRolesAndAdministrator(database);
    const nowIso = NOW.toISOString();
    const userId = '3'.repeat(32);
    database.prepare(`
      INSERT INTO users (
        id, email, password_hash, auth_revision, name, status,
        email_verified, created_at_iso, updated_at_iso
      ) VALUES (?, 'active@example.com', 'password-hash', ?,
        'Active User', 'active', 1, ?, ?)
    `).run(userId, '4'.repeat(32), nowIso, nowIso);
    database.prepare(`
      INSERT INTO user_roles (user_id, role_key, created_at_iso)
      VALUES (?, 'author', ?)
    `).run(userId, nowIso);

    await expect(deleteInactiveManagedUserAccount({
      db: d1,
      administratorId: ADMIN_ID,
      userId,
      confirmationEmail: 'active@example.com',
      now: NOW,
    })).resolves.toEqual({ kind: 'account_not_inactive' });
    database.prepare(`
      UPDATE users SET status = 'inactive' WHERE id = ?
    `).run(userId);
    await expect(deleteInactiveManagedUserAccount({
      db: d1,
      administratorId: ADMIN_ID,
      userId,
      confirmationEmail: 'wrong@example.com',
      now: NOW,
    })).resolves.toEqual({ kind: 'confirmation_mismatch' });
    expect(database.prepare('SELECT status FROM users WHERE id = ?')
      .get(userId)).toEqual({ status: 'inactive' });
    await expect(deleteInactiveManagedUserAccount({
      db: d1,
      administratorId: ADMIN_ID,
      userId: ADMIN_ID,
      confirmationEmail: 'owner@example.com',
      now: NOW,
    })).resolves.toEqual({ kind: 'current_user' });
  });
});
