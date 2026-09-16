import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import {
  bootstrapRecoveryAdministrator,
  inspectRecoveryAdministratorBootstrapAvailability,
  listRecoverableAdministrators,
  recoverAdministratorAccess,
} from './administrator-recovery';

const administratorId = '0123456789abcdef0123456789abcdef';

type CapturedStatement = {
  sql: string;
  params: unknown[];
};

function capturedStatement(sql: string) {
  const statement: CapturedStatement & {
    bind(...params: unknown[]): CapturedStatement;
  } = {
    sql,
    params: [],
    bind(...params: unknown[]) {
      return { sql, params };
    },
  };
  return statement;
}

describe('administrator recovery database operations', () => {
  it('lists only administrator-role accounts with MFA state', async () => {
    const database = {
      prepare(sql: string) {
        expect(sql).toContain("ur.role_key = 'admin'");
        expect(sql).toContain('FROM user_mfa_factors');
        return {
          async all() {
            return {
              success: true,
              results: [
                {
                  id: administratorId,
                  email: 'owner@example.com',
                  name: 'Studio Owner',
                  status: 'inactive',
                  mfa_configured: 1,
                },
              ],
              meta: {},
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      listRecoverableAdministrators(database),
    ).resolves.toEqual([
      {
        id: administratorId,
        email: 'owner@example.com',
        name: 'Studio Owner',
        status: 'inactive',
        mfa_configured: true,
      },
    ]);
  });

  it('fails bootstrap closed when the canonical administrator role is malformed', async () => {
    const database = {
      prepare(sql: string) {
        expect(sql).toContain('canonical_role_count');
        return {
          bind() {
            return {
              async first() {
                return {
                  canonical_role_count: 0,
                  administrator_count: 0,
                  email_count: 0,
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(inspectRecoveryAdministratorBootstrapAvailability({
      db: database,
      administratorEmail: 'owner@example.com',
    })).rejects.toMatchObject({
      code: 'ADMINISTRATOR_RECOVERY_DATABASE_QUERY_FAILED',
      operationalMetadata: {
        action: 'inspect_recovery_administrator_bootstrap',
      },
    });
  });

  it('distinguishes zero-admin bootstrap availability from email and administrator conflicts', async () => {
    const rows = [
      { canonical_role_count: 1, administrator_count: 0, email_count: 0 },
      { canonical_role_count: 1, administrator_count: 0, email_count: 1 },
      { canonical_role_count: 1, administrator_count: 1, email_count: 0 },
    ];
    const database = {
      prepare(sql: string) {
        expect(sql).toContain('canonical_role_count');
        return {
          bind() {
            return {
              async first() {
                return rows.shift();
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(inspectRecoveryAdministratorBootstrapAvailability({
      db: database,
      administratorEmail: 'new@example.com',
    })).resolves.toBe('available');
    await expect(inspectRecoveryAdministratorBootstrapAvailability({
      db: database,
      administratorEmail: 'existing@example.com',
    })).resolves.toBe('email_conflict');
    await expect(inspectRecoveryAdministratorBootstrapAvailability({
      db: database,
      administratorEmail: 'new@example.com',
    })).resolves.toBe('administrator_exists');
  });

  it('atomically creates one recovery administrator with mandatory MFA', async () => {
    const batches: CapturedStatement[][] = [];
    const generatedIds = [
      '11111111111111111111111111111111',
      '22222222222222222222222222222222',
    ];
    const database = {
      prepare(sql: string) {
        if (sql.includes('canonical_role_count')) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    canonical_role_count: 1,
                    administrator_count: 0,
                    email_count: 0,
                  };
                },
              };
            },
          };
        }
        if (sql.includes('AS user_count')) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    user_count: 1,
                    factor_count: 1,
                    role_count: 1,
                    administrator_count: 1,
                  };
                },
              };
            },
          };
        }
        return capturedStatement(sql);
      },
      async batch(statements: CapturedStatement[]) {
        batches.push(statements);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await expect(bootstrapRecoveryAdministrator({
      db: database,
      administratorName: 'Recovery Owner',
      administratorEmail: 'owner@example.com',
      passwordHash: '$argon2id$recovery-bootstrap',
      encryptedTotpSecret: {
        ciphertext: 'ciphertext-value-long-enough',
        iv: 'initialization-vector',
      },
      lastUsedStep: 123,
      now: new Date('2026-08-13T00:00:00.000Z'),
      createId: () => generatedIds.shift() ?? '',
    })).resolves.toEqual({
      state: 'created',
      administratorId: '11111111111111111111111111111111',
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0][0]?.sql).toContain('INSERT INTO users');
    expect(batches[0][0]?.sql).toContain("ur.role_key = 'admin'");
    expect(batches[0][1]?.sql).toContain('INSERT INTO user_mfa_factors');
    expect(batches[0][2]?.sql).toContain('INSERT INTO user_roles');
    expect(batches[0][2]?.sql).toContain("SELECT u.id, 'admin'");
  });

  it('converges after a lost D1 batch response and preserves existing users and Authors', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec('PRAGMA foreign_keys = ON');
      sqlite.exec(readFileSync(
        new URL('../../../database/install/001_baseline.sql', import.meta.url),
        'utf8',
      ));
      const nowIso = '2026-08-13T00:00:00.000Z';
      sqlite.prepare(`
        INSERT INTO roles (
          key, name, description, is_system, created_at_iso, updated_at_iso
        ) VALUES ('admin', 'Administrator',
          'Full Studio administration access.', 1, ?, ?)
      `).run(nowIso, nowIso);
      sqlite.prepare(`
        INSERT INTO users (
          id, email, password_hash, name, status, email_verified,
          created_at_iso, updated_at_iso
        ) VALUES (?, 'writer@example.com', 'existing-password',
          'Existing Writer', 'active', 1, ?, ?)
      `).run('3'.repeat(32), nowIso, nowIso);
      sqlite.prepare(`
        INSERT INTO authors (
          id, user_id, display_name, revision, created_at_iso, updated_at_iso
        ) VALUES ('orphan-author', NULL, 'Former Owner', ?, ?, ?)
      `).run('4'.repeat(32), nowIso, nowIso);
      const hooks = { throwAfterCommitOnce: true };

      await expect(bootstrapRecoveryAdministrator({
        db: sqliteD1(sqlite, hooks),
        administratorName: 'Recovery Owner',
        administratorEmail: 'owner@example.com',
        passwordHash: '$argon2id$recovery-bootstrap',
        encryptedTotpSecret: {
          ciphertext: 'ciphertext-value-long-enough',
          iv: 'initialization-vector',
        },
        lastUsedStep: 123,
        now: new Date(nowIso),
        createId: (() => {
          const ids = ['1'.repeat(32), '2'.repeat(32)];
          return () => ids.shift() ?? '';
        })(),
      })).resolves.toEqual({
        state: 'created',
        administratorId: '1'.repeat(32),
      });

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get())
        .toEqual({ count: 2 });
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM user_roles
        WHERE role_key = 'admin'
      `).get()).toEqual({ count: 1 });
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM user_mfa_factors
        WHERE user_id = ?
      `).get('1'.repeat(32))).toEqual({ count: 1 });
      expect(sqlite.prepare(`
        SELECT user_id
        FROM authors
        WHERE id = 'orphan-author'
      `).get()).toEqual({ user_id: null });

      await expect(inspectRecoveryAdministratorBootstrapAvailability({
        db: sqliteD1(sqlite),
        administratorEmail: 'another@example.com',
      })).resolves.toBe('administrator_exists');
    } finally {
      sqlite.close();
    }
  });

  it('atomically rotates credentials, unlocks the account, and resets MFA', async () => {
    const batches: CapturedStatement[][] = [];
    const database = {
      prepare: capturedStatement,
      async batch(statements: CapturedStatement[]) {
        batches.push(statements);
        return statements.map((_, index) => ({
          success: true,
          meta: { changes: index === 0 ? 1 : 10 },
        }));
      },
    } as unknown as D1Database;

    await expect(recoverAdministratorAccess({
      db: database,
      administratorId,
      passwordHash: '$argon2id$recovered-password-hash',
      resetMfa: true,
      now: new Date('2026-07-30T12:00:00.000Z'),
    })).resolves.toBe(true);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0][0]?.sql).toContain('UPDATE users');
    expect(batches[0][0]?.sql).toContain(
      'auth_revision = lower(hex(randomblob(16)))',
    );
    expect(batches[0][0]?.sql).toContain("status = 'active'");
    expect(batches[0][0]?.sql).toContain('failed_login_attempts = 0');
    expect(batches[0][0]?.sql).toContain('locked_until = NULL');
    expect(batches[0][0]?.sql).toContain("ur.role_key = 'admin'");
    expect(batches[0][0]?.params).toEqual([
      '$argon2id$recovered-password-hash',
      '2026-07-30T12:00:00.000Z',
      administratorId,
    ]);
    expect(batches[0][1]?.sql).toContain('DELETE FROM sessions');
    expect(batches[0][1]?.params).toEqual([
      administratorId,
      administratorId,
    ]);
    expect(batches[0][2]?.sql).toContain(
      'DELETE FROM webauthn_challenges',
    );
    expect(batches[0][3]?.sql).toContain(
      'DELETE FROM user_webauthn_credentials',
    );
    expect(batches[0][4]?.sql).toContain(
      'DELETE FROM user_mfa_factors',
    );
  });

  it('can preserve MFA and reports a stale or non-admin target', async () => {
    const batches: CapturedStatement[][] = [];
    const database = {
      prepare: capturedStatement,
      async batch(statements: CapturedStatement[]) {
        batches.push(statements);
        return [{
          success: true,
          meta: { changes: 0 },
        }];
      },
    } as unknown as D1Database;

    await expect(recoverAdministratorAccess({
      db: database,
      administratorId,
      passwordHash: '$argon2id$recovered-password-hash',
      resetMfa: false,
    })).resolves.toBe(false);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0]?.sql).not.toContain('user_mfa_factors');
    expect(batches[0][1]?.sql).toContain('DELETE FROM sessions');
  });
});
