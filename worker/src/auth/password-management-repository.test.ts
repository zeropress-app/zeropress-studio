import { describe, expect, it } from 'vitest';
import { changeUserPassword } from './password-management-repository';

type CapturedStatement = {
  sql: string;
  params: unknown[];
  bind: (...params: unknown[]) => CapturedStatement;
};

function statement(sql: string): CapturedStatement {
  return {
    sql,
    params: [],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
  };
}

function database(input: {
  userChanges: number;
  sessionChanges: number;
  capture: CapturedStatement[][];
}): D1Database {
  return {
    prepare(sql: string) {
      return statement(sql);
    },
    async batch(statements: CapturedStatement[]) {
      input.capture.push(statements);
      return [
        { success: true, meta: { changes: input.userChanges } },
        { success: true, meta: { changes: input.sessionChanges } },
      ];
    },
  } as unknown as D1Database;
}

describe('password management repository', () => {
  it('rotates the security revision and revokes every session in one batch', async () => {
    const batches: CapturedStatement[][] = [];
    const result = await changeUserPassword({
      db: database({ userChanges: 1, sessionChanges: 5, capture: batches }),
      userId: '1'.repeat(32),
      authRevision: '2'.repeat(32),
      passwordHash: '$argon2id$new-password',
      nextAuthRevision: '3'.repeat(32),
      now: new Date('2026-07-31T12:00:00.000Z'),
    });

    expect(result).toEqual({ kind: 'completed', revokedSessions: 5 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.sql).toContain('UPDATE users');
    expect(batches[0]?.[0]?.sql).toContain('auth_revision = ?');
    expect(batches[0]?.[1]?.sql).toContain('DELETE FROM sessions');
    expect(batches[0]?.[1]?.sql).not.toContain('id != ?');
  });

  it('rejects a stale account revision without reporting completion', async () => {
    const batches: CapturedStatement[][] = [];
    await expect(changeUserPassword({
      db: database({ userChanges: 0, sessionChanges: 0, capture: batches }),
      userId: '1'.repeat(32),
      authRevision: '2'.repeat(32),
      passwordHash: '$argon2id$new-password',
      nextAuthRevision: '3'.repeat(32),
    })).resolves.toEqual({ kind: 'challenge_invalid' });
  });
});
