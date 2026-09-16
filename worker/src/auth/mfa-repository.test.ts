import { withAuthRateLimits } from '../test-helpers/auth-database';
import { describe, expect, it } from 'vitest';
import {
  createTotpCode,
  encryptTotpSecret,
} from './mfa-crypto';
import {
  completeMfaEnrollment,
  verifyUserTotp,
} from './mfa-repository';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const factorId = '00112233445566778899aabbccddeeff';
const now = new Date('2026-07-30T12:00:00.000Z');

type CapturedStatement = {
  sql: string;
  params: unknown[];
};

function statement(
  sql: string,
  handlers: {
    first?: (params: unknown[]) => unknown;
    run?: (params: unknown[]) => unknown;
  } = {},
) {
  let params: unknown[] = [];
  return {
    sql,
    params,
    bind(...nextParams: unknown[]) {
      params = nextParams;
      this.params = nextParams;
      return this;
    },
    async first() {
      return handlers.first?.(params) ?? null;
    },
    async run() {
      return handlers.run?.(params) ?? {
        success: true,
        meta: { changes: 0 },
      };
    },
  };
}

describe('Studio MFA repository', () => {
  it('stores one TOTP factor and rejects a second enrollment', async () => {
    const writes: CapturedStatement[] = [];
    let configured = false;
    const database = {
      prepare(sql: string) {
        if (sql.includes('SELECT') && sql.includes('factor_count')) {
          return statement(sql, {
            first: () => ({
              email: 'owner@example.com',
              factor_count: configured ? 1 : 0,
            }),
          });
        }
        if (sql.includes('INSERT INTO user_mfa_factors')) {
          const captured = statement(sql, {
            run: () => {
              writes.push(captured);
              const factorChanged = !configured;
              configured = true;
              return {
                success: true,
                meta: { changes: factorChanged ? 1 : 0 },
              };
            },
          });
          return captured;
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;

    await expect(completeMfaEnrollment({
      db: withAuthRateLimits(database),
      userId,
      authRevision,
      encryptedTotpSecret: {
        ciphertext: 'encrypted-totp-secret',
        iv: 'encrypted-secret-iv',
      },
      lastUsedStep: 123,
      now,
      createId: () => factorId,
    })).resolves.toEqual({ status: 'completed' });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain('INSERT INTO user_mfa_factors');
    expect(writes[0]?.params).toEqual([
      factorId,
      'encrypted-totp-secret',
      'encrypted-secret-iv',
      123,
      now.toISOString(),
      now.toISOString(),
      userId,
      authRevision,
    ]);
    await expect(completeMfaEnrollment({
      db: withAuthRateLimits(database),
      userId,
      authRevision,
      encryptedTotpSecret: {
        ciphertext: 'different',
        iv: 'different',
      },
      lastUsedStep: 124,
      now,
    })).resolves.toEqual({ status: 'already_configured' });
    expect(writes).toHaveLength(2);
  });

  it('rejects enrollment completion after the auth revision changes', async () => {
    const database = {
      prepare(sql: string) {
        if (sql.includes('SELECT') && sql.includes('factor_count')) {
          return statement(sql, {
            first: () => null,
          });
        }
        return statement(sql);
      },
      async batch(statements: CapturedStatement[]) {
        return statements.map(() => ({
          success: true,
          meta: { changes: 0 },
        }));
      },
    } as unknown as D1Database;

    await expect(completeMfaEnrollment({
      db: withAuthRateLimits(database),
      userId,
      authRevision,
      encryptedTotpSecret: {
        ciphertext: 'encrypted-totp-secret',
        iv: 'encrypted-secret-iv',
      },
      lastUsedStep: 123,
      now,
      createId: () => factorId,
    })).resolves.toEqual({ status: 'challenge_invalid' });
  });

  it('accepts a TOTP step once and rejects replay of the same code', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = await encryptTotpSecret(authSecret, totpSecret);
    const code = await createTotpCode({ secret: totpSecret, now });
    let lastUsedStep = -1;
    const database = {
      prepare(sql: string) {
        if (sql.includes('FROM user_mfa_factors f')) {
          expect(sql).toContain('f.id AS id');
          expect(sql).toContain(
            'f.secret_ciphertext AS secret_ciphertext',
          );
          expect(sql).toContain('f.secret_iv AS secret_iv');
          expect(sql).toContain(
            'f.last_used_step AS last_used_step',
          );
          return statement(sql, {
            first: () => ({
              id: factorId,
              secret_ciphertext: encrypted.ciphertext,
              secret_iv: encrypted.iv,
              last_used_step: lastUsedStep,
            }),
          });
        }
        if (sql.includes('UPDATE user_mfa_factors')) {
          return statement(sql, {
            run: (params) => {
              const nextStep = Number(params[0]);
              const expectedPreviousBound = Number(params[3]);
              const changed = nextStep === expectedPreviousBound
                && params[4] === authRevision
                && lastUsedStep < nextStep;
              if (changed) lastUsedStep = nextStep;
              return {
                success: true,
                meta: { changes: changed ? 1 : 0 },
              };
            },
          });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;

    await expect(verifyUserTotp({
      db: withAuthRateLimits(database),
      authSecret,
      userId,
      authRevision,
      code,
      now,
    })).resolves.toEqual({ status: 'verified' });
    await expect(verifyUserTotp({
      db: withAuthRateLimits(database),
      authSecret,
      userId,
      authRevision,
      code,
      now,
    })).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects a valid TOTP when the auth revision changes mid-request', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = await encryptTotpSecret(authSecret, totpSecret);
    const code = await createTotpCode({ secret: totpSecret, now });
    const database = {
      prepare(sql: string) {
        if (sql.includes('FROM user_mfa_factors f')) {
          return statement(sql, {
            first: () => ({
              id: factorId,
              secret_ciphertext: encrypted.ciphertext,
              secret_iv: encrypted.iv,
              last_used_step: -1,
            }),
          });
        }
        if (sql.includes('UPDATE user_mfa_factors')) {
          return statement(sql, {
            run: () => ({
              success: true,
              meta: { changes: 0 },
            }),
          });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;

    await expect(verifyUserTotp({
      db: withAuthRateLimits(database),
      authSecret,
      userId,
      authRevision,
      code,
      now,
    })).resolves.toEqual({ status: 'invalid' });
  });

  it('classifies a failed TOTP replay-protection write for operators', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = await encryptTotpSecret(authSecret, totpSecret);
    const code = await createTotpCode({ secret: totpSecret, now });
    const writeError = new Error('D1 write unavailable');
    const database = {
      prepare(sql: string) {
        if (sql.includes('FROM user_mfa_factors f')) {
          return statement(sql, {
            first: () => ({
              id: factorId,
              secret_ciphertext: encrypted.ciphertext,
              secret_iv: encrypted.iv,
              last_used_step: -1,
            }),
          });
        }
        if (sql.includes('UPDATE user_mfa_factors')) {
          return statement(sql, {
            run: () => {
              throw writeError;
            },
          });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;

    await expect(verifyUserTotp({
      db: withAuthRateLimits(database),
      authSecret,
      userId,
      authRevision,
      code,
      now,
    })).rejects.toMatchObject({
      code: 'AUTH_MFA_DATABASE_WRITE_FAILED',
      originalCause: writeError,
      operationalMetadata: {
        resource: 'DB',
        action: 'consume_totp_step',
      },
    });
  });

});
