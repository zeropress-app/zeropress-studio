import { describe, expect, it, vi } from 'vitest';
import {
  getMfaManagementStatus,
  replaceManagedTotp,
  verifyMfaManagementPassword,
} from './mfa-management-repository';

const userId = '0123456789abcdef0123456789abcdef';
const sessionId = '00112233445566778899aabbccddeeff';
const authRevision = 'fedcba9876543210fedcba9876543210';
const nextRevision = 'aabbccddeeff00112233445566778899';
const now = new Date('2026-07-31T12:00:00.000Z');
type CapturedStatement = {
  sql: string;
  params: unknown[];
};

function statement(
  sql: string,
  firstValue: unknown = null,
): CapturedStatement & {
  bind: (...params: unknown[]) => unknown;
  first: () => Promise<unknown>;
} {
  return {
    sql,
    params: [],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first() {
      return firstValue;
    },
  };
}

function mutationDatabase(input: {
  firstChanges?: number;
  revokedSessions?: number;
  capture: CapturedStatement[][];
}): D1Database {
  return {
    prepare(sql: string) {
      return statement(sql);
    },
    async batch(statements: CapturedStatement[]) {
      input.capture.push(statements);
      return statements.map((statement, index) => ({
        success: true,
        meta: {
          changes: index === 0
            ? (input.firstChanges ?? 1)
            : statement.sql.includes('DELETE FROM sessions')
              ? (input.revokedSessions ?? 0)
              : statement.sql.includes(
                'INSERT INTO user_mfa_factors',
              )
                ? 0
                : 1,
        },
      }));
    },
  } as unknown as D1Database;
}

describe('MFA management repository', () => {
  it('reads one configured TOTP factor', async () => {
    const database = {
      prepare(sql: string) {
        expect(sql).toContain("factor.factor_type = 'totp'");
        return statement(sql, {
          configured_at_iso: '2026-07-30T12:00:00.000Z',
        });
      },
    } as unknown as D1Database;

    await expect(getMfaManagementStatus({
      db: database,
      userId,
      authRevision,
    })).resolves.toEqual({
      configuredAtIso: '2026-07-30T12:00:00.000Z',
    });
  });

  it('re-confirms the password only for the active current revision', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(true);
    const database = {
      prepare(sql: string) {
        expect(sql).toContain('auth_revision = ?');
        expect(sql).toContain("status = 'active'");
        return statement(sql, { password_hash: 'stored-hash' });
      },
    } as unknown as D1Database;

    await expect(verifyMfaManagementPassword({
      db: database,
      userId,
      authRevision,
      password: 'current password',
      verifyPassword,
    })).resolves.toBe(true);
    expect(verifyPassword).toHaveBeenCalledWith(
      'current password',
      'stored-hash',
    );
  });

  it('replaces TOTP while preserving only the current session', async () => {
    const batches: CapturedStatement[][] = [];
    const result = await replaceManagedTotp({
      db: mutationDatabase({
        capture: batches,
        revokedSessions: 3,
      }),
      userId,
      currentSessionId: sessionId,
      authRevision,
      encryptedTotpSecret: {
        ciphertext: 'replacement-ciphertext',
        iv: 'replacement-initialization-vector',
      },
      lastUsedStep: 12345,
      now,
      createRevision: () => nextRevision,
    });

    expect(result).toEqual({ kind: 'completed', revokedSessions: 3 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0]?.[0]?.sql).toContain(
      'UPDATE user_mfa_factors',
    );
    expect(batches[0]?.at(-4)?.sql).toContain('UPDATE users');
    expect(batches[0]?.at(-3)?.sql).toContain('UPDATE sessions');
    expect(batches[0]?.at(-2)?.sql).toContain('id != ?');
    expect(batches[0]?.at(-1)?.sql).toContain(
      'INSERT INTO user_mfa_factors',
    );
    expect(batches[0]?.at(-3)?.params).toContain(nextRevision);
  });

  it('rejects a stale session/revision before reporting completion', async () => {
    const batches: CapturedStatement[][] = [];
    await expect(replaceManagedTotp({
      db: mutationDatabase({
        capture: batches,
        firstChanges: 0,
      }),
      userId,
      currentSessionId: sessionId,
      authRevision,
      encryptedTotpSecret: {
        ciphertext: 'replacement-ciphertext',
        iv: 'replacement-initialization-vector',
      },
      lastUsedStep: 12345,
      now,
      createRevision: () => nextRevision,
    })).resolves.toEqual({ kind: 'challenge_invalid' });
  });
});
