import { describe, expect, it } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createSessionTokenMaterial,
  digestSessionSecret,
} from './session-crypto';
import {
  issueUserSession,
  listUserSessions,
  MAX_CONCURRENT_SESSIONS,
  resolveUserSession,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  SESSION_IDLE_TTL_MS,
} from './session-repository';

const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const unavailableNetworkMetadata = {
  asn: null,
  asOrganization: null,
  countryCode: null,
} as const;

type CapturedStatement = {
  sql: string;
  params: unknown[];
  bind(...params: unknown[]): CapturedStatement;
};

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function issueDatabase(insertChanges = 1) {
  const batches: CapturedStatement[][] = [];
  const database = {
    prepare(sql: string) {
      const statement: CapturedStatement = {
        sql: normalizedSql(sql),
        params: [],
        bind(...params: unknown[]) {
          return { ...statement, params };
        },
      };
      return statement;
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      return statements.map((_, index) => ({
        success: true,
        results: [],
        meta: { changes: index === 3 ? insertChanges : 0 },
      }));
    },
  } as unknown as D1Database;
  return { database, batches };
}

async function fixedToken() {
  return createSessionTokenMaterial((length) =>
    new Uint8Array(length).fill(length)
  );
}

describe('session repository', () => {
  it('issues a 12-hour/7-day session and trims older rows before insert', async () => {
    const capture = issueDatabase();
    const now = new Date('2026-07-31T00:00:00.000Z');
    const result = await issueUserSession({
      db: capture.database,
      userId,
      authRevision,
      ipAddress: '2001:db8::1234',
      userAgent: ' Test Browser ',
      networkMetadata: {
        asn: 13335,
        asOrganization: 'Cloudflare, Inc.',
        countryCode: 'KR',
      },
      now,
      createToken: fixedToken,
    });

    expect(result).toMatchObject({
      kind: 'issued',
      value: {
        session: {
          created_at_iso: now.toISOString(),
          last_seen_at_iso: now.toISOString(),
          idle_expires_at_iso: new Date(
            now.getTime() + SESSION_IDLE_TTL_MS,
          ).toISOString(),
          absolute_expires_at_iso: new Date(
            now.getTime() + SESSION_ABSOLUTE_TTL_MS,
          ).toISOString(),
          network: {
            ip_address: '2001:db8::1234',
            asn: 13335,
            as_organization: 'Cloudflare, Inc.',
            country_code: 'KR',
          },
        },
      },
    });
    expect(capture.batches).toHaveLength(1);
    expect(capture.batches[0]).toHaveLength(4);
    expect(capture.batches[0][0]?.sql).toContain(
      'DELETE FROM sessions WHERE idle_expires_at_iso <= ?',
    );
    expect(capture.batches[0][0]?.params).toEqual([now.toISOString()]);
    expect(capture.batches[0][1]?.sql).toContain(
      'DELETE FROM sessions WHERE absolute_expires_at_iso <= ?',
    );
    expect(capture.batches[0][1]?.params).toEqual([now.toISOString()]);
    expect(capture.batches[0][2]?.params).toEqual([
      userId,
      userId,
      MAX_CONCURRENT_SESSIONS - 1,
    ]);
    expect(capture.batches[0][3]?.params).toEqual(expect.arrayContaining([
      '2001:db8::1234',
      'Test Browser',
      13335,
      'Cloudflare, Inc.',
      'KR',
      new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString(),
      new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString(),
      userId,
      authRevision,
    ]));
    expect(capture.batches[0][3]?.sql.match(/\?/gu)).toHaveLength(
      capture.batches[0][3]?.params.length,
    );
  });

  it('does not issue a session after the account auth revision changes', async () => {
    await expect(issueUserSession({
      db: issueDatabase(0).database,
      userId,
      authRevision,
      ipAddress: '192.0.2.10',
      networkMetadata: unavailableNetworkMetadata,
      createToken: fixedToken,
    })).resolves.toEqual({ kind: 'account_changed' });
  });

  it('resolves current roles and full IP while throttling activity writes', async () => {
    const token = await fixedToken();
    const now = new Date('2026-07-31T00:04:00.000Z');
    const row = {
      id: token.id,
      user_id: userId,
      secret_digest: token.secretDigest,
      session_auth_revision: authRevision,
      ip_address: '203.0.113.41',
      user_agent: 'Browser',
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'US',
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: '2026-07-31T00:00:00.000Z',
      idle_expires_at_iso: '2026-07-31T12:00:00.000Z',
      absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
      mfa_verified_at_iso: '2026-07-31T00:00:00.000Z',
      email: 'admin@example.com',
      name: 'Studio Owner',
      user_status: 'active',
      current_auth_revision: authRevision,
      roles: 'admin,editor',
      site_title: 'Editorial Magazine',
      site_url: 'https://example.com',
    };
    let runCount = 0;
    const database = {
      prepare(_sql: string) {
        return {
          bind() {
            return {
              async first() {
                return row;
              },
              async run() {
                runCount += 1;
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveUserSession({
      db: database,
      cookieValue: token.cookieValue,
      now,
    })).resolves.toMatchObject({
      user: {
        id: userId,
        roles: ['admin', 'editor'],
      },
      session: {
        network: {
          ip_address: '203.0.113.41',
          asn: 13335,
          as_organization: 'Cloudflare, Inc.',
          country_code: 'US',
        },
        last_seen_at_iso: '2026-07-31T00:00:00.000Z',
      },
      csrfToken: token.csrfToken,
      siteTitle: 'Editorial Magazine',
      siteUrl: 'https://example.com',
      authRevision,
      mfaVerifiedAtIso: '2026-07-31T00:00:00.000Z',
    });
    expect(runCount).toBe(0);
  });

  it('renews idle activity after five minutes without exceeding absolute expiry', async () => {
    const token = await fixedToken();
    const absoluteExpiresAt = '2026-08-07T00:00:00.000Z';
    const now = new Date('2026-08-06T23:59:00.000Z');
    const row = {
      id: token.id,
      user_id: userId,
      secret_digest: token.secretDigest,
      session_auth_revision: authRevision,
      ip_address: '203.0.113.41',
      user_agent: 'Browser',
      asn: null,
      as_organization: null,
      country_code: null,
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: new Date(
        now.getTime() - SESSION_ACTIVITY_WRITE_INTERVAL_MS,
      ).toISOString(),
      idle_expires_at_iso: '2026-08-06T23:59:30.000Z',
      absolute_expires_at_iso: absoluteExpiresAt,
      mfa_verified_at_iso: '2026-07-31T00:00:00.000Z',
      email: 'admin@example.com',
      name: 'Studio Owner',
      user_status: 'active',
      current_auth_revision: authRevision,
      roles: 'admin',
      site_title: '   ',
      site_url: 'javascript:alert(1)',
    };
    let updateParams: unknown[] | null = null;
    const database = {
      prepare(sql: string) {
        const normalized = normalizedSql(sql);
        return {
          bind(...params: unknown[]) {
            return {
              async first() {
                return row;
              },
              async run() {
                if (normalized.startsWith('UPDATE sessions')) {
                  updateParams = params;
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveUserSession({
      db: database,
      cookieValue: token.cookieValue,
      now,
    })).resolves.toMatchObject({
      siteTitle: '',
      siteUrl: '',
      session: {
        last_seen_at_iso: now.toISOString(),
        idle_expires_at_iso: absoluteExpiresAt,
        absolute_expires_at_iso: absoluteExpiresAt,
      },
    });
    expect(updateParams).toEqual([
      now.toISOString(),
      absoluteExpiresAt,
      token.id,
      token.secretDigest,
      now.toISOString(),
      now.toISOString(),
    ]);
  });

  it('fails closed and deletes a session at its idle expiry boundary', async () => {
    const token = await fixedToken();
    const now = new Date('2026-07-31T12:00:00.000Z');
    const statements: string[] = [];
    const database = {
      prepare(sql: string) {
        const normalized = normalizedSql(sql);
        statements.push(normalized);
        return {
          bind() {
            return {
              async first() {
                return {
                  id: token.id,
                  user_id: userId,
                  secret_digest: token.secretDigest,
                  session_auth_revision: authRevision,
                  ip_address: '192.0.2.10',
                  user_agent: null,
                  asn: null,
                  as_organization: null,
                  country_code: null,
                  created_at_iso: '2026-07-31T00:00:00.000Z',
                  last_seen_at_iso: '2026-07-31T00:00:00.000Z',
                  idle_expires_at_iso: now.toISOString(),
                  absolute_expires_at_iso:
                    '2026-08-07T00:00:00.000Z',
                  mfa_verified_at_iso: '2026-07-31T00:00:00.000Z',
                  email: 'admin@example.com',
                  name: 'Studio Owner',
                  user_status: 'active',
                  current_auth_revision: authRevision,
                  roles: 'admin',
                };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveUserSession({
      db: database,
      cookieValue: token.cookieValue,
      now,
    })).resolves.toBeNull();
    expect(statements).toContain('DELETE FROM sessions WHERE id = ?');
  });

  it('fails closed and deletes a session after auth revision changes', async () => {
    const token = await fixedToken();
    const statements: string[] = [];
    const database = {
      prepare(sql: string) {
        statements.push(normalizedSql(sql));
        return {
          bind() {
            return {
              async first() {
                return {
                  id: token.id,
                  user_id: userId,
                  secret_digest: await digestSessionSecret(token.secret),
                  session_auth_revision: authRevision,
                  ip_address: '192.0.2.10',
                  user_agent: null,
                  asn: null,
                  as_organization: null,
                  country_code: null,
                  created_at_iso: '2026-07-31T00:00:00.000Z',
                  last_seen_at_iso: '2026-07-31T00:00:00.000Z',
                  idle_expires_at_iso: '2026-07-31T12:00:00.000Z',
                  absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
                  mfa_verified_at_iso: '2026-07-31T00:00:00.000Z',
                  email: 'admin@example.com',
                  name: 'Studio Owner',
                  user_status: 'active',
                  current_auth_revision: '0'.repeat(32),
                  roles: 'admin',
                };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveUserSession({
      db: database,
      cookieValue: token.cookieValue,
      now: new Date('2026-07-31T01:00:00.000Z'),
    })).resolves.toBeNull();
    expect(statements.some((sql) =>
      sql === 'DELETE FROM sessions WHERE id = ?'
    )).toBe(true);
  });

  it('classifies D1 issue failures without exposing session material', async () => {
    const database = {
      prepare() {
        return { bind() { return this; } };
      },
      async batch() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    const promise = issueUserSession({
      db: database,
      userId,
      authRevision,
      ipAddress: '192.0.2.10',
      networkMetadata: unavailableNetworkMetadata,
      createToken: fixedToken,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'AUTH_SESSION_DATABASE_WRITE_FAILED',
      operationalMetadata: {
        resource: 'DB',
        action: 'issue_session',
      },
    } satisfies Partial<StudioOperationalError>);
  });

  it('lists only active sessions with current-session and network metadata', async () => {
    const currentSessionId = '00112233445566778899aabbccddeeff';
    const otherSessionId = 'ffeeddccbbaa99887766554433221100';
    const now = new Date('2026-07-31T01:00:00.000Z');
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const database = {
      prepare(sql: string) {
        capturedSql = normalizedSql(sql);
        return {
          bind(...params: unknown[]) {
            capturedParams = params;
            return {
              async all() {
                return {
                  success: true,
                  results: [
                    {
                      id: currentSessionId,
                      ip_address: '203.0.113.10',
                      user_agent: 'Current Browser',
                      asn: 13335,
                      as_organization: 'Cloudflare, Inc.',
                      country_code: 'KR',
                      created_at_iso: '2026-07-31T00:00:00.000Z',
                      last_seen_at_iso: '2026-07-31T00:10:00.000Z',
                      idle_expires_at_iso: '2026-07-31T12:10:00.000Z',
                      absolute_expires_at_iso:
                        '2026-08-07T00:00:00.000Z',
                    },
                    {
                      id: otherSessionId,
                      ip_address: '192.0.2.20',
                      user_agent: null,
                      asn: null,
                      as_organization: null,
                      country_code: null,
                      created_at_iso: '2026-07-30T00:00:00.000Z',
                      last_seen_at_iso: '2026-07-30T12:00:00.000Z',
                      idle_expires_at_iso: '2026-07-31T02:00:00.000Z',
                      absolute_expires_at_iso:
                        '2026-08-06T00:00:00.000Z',
                    },
                  ],
                  meta: {},
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(listUserSessions({
      db: database,
      userId,
      currentSessionId,
      now,
    })).resolves.toEqual([
      {
        id: currentSessionId,
        is_current: true,
        created_at_iso: '2026-07-31T00:00:00.000Z',
        last_seen_at_iso: '2026-07-31T00:10:00.000Z',
        idle_expires_at_iso: '2026-07-31T12:10:00.000Z',
        absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
        user_agent: 'Current Browser',
        network: {
          ip_address: '203.0.113.10',
          asn: 13335,
          as_organization: 'Cloudflare, Inc.',
          country_code: 'KR',
        },
      },
      expect.objectContaining({
        id: otherSessionId,
        is_current: false,
      }),
    ]);
    expect(capturedSql).toContain('idle_expires_at_iso > ?');
    expect(capturedSql).toContain('absolute_expires_at_iso > ?');
    expect(capturedSql).toContain('LIMIT ?');
    expect(capturedParams).toEqual([
      userId,
      now.toISOString(),
      now.toISOString(),
      MAX_CONCURRENT_SESSIONS,
    ]);
  });

  it('revokes every other session while preserving the current row', async () => {
    const currentSessionId = '00112233445566778899aabbccddeeff';
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const database = {
      prepare(sql: string) {
        capturedSql = normalizedSql(sql);
        return {
          bind(...params: unknown[]) {
            capturedParams = params;
            return {
              async run() {
                return { success: true, meta: { changes: 4 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(revokeOtherUserSessions({
      db: database,
      userId,
      currentSessionId,
    })).resolves.toBe(4);
    expect(capturedSql).toBe(
      'DELETE FROM sessions WHERE user_id = ? AND id != ?',
    );
    expect(capturedParams).toEqual([userId, currentSessionId]);
  });

  it('classifies session-list and other-session D1 failures separately', async () => {
    const listDatabase = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error('D1 list unavailable');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(listUserSessions({
      db: listDatabase,
      userId,
      currentSessionId: '00112233445566778899aabbccddeeff',
    })).rejects.toMatchObject({
      code: 'AUTH_SESSION_DATABASE_QUERY_FAILED',
      operationalMetadata: {
        resource: 'DB',
        action: 'list_sessions',
      },
    } satisfies Partial<StudioOperationalError>);

    const writeDatabase = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error('D1 write unavailable');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(revokeOtherUserSessions({
      db: writeDatabase,
      userId,
      currentSessionId: '00112233445566778899aabbccddeeff',
    })).rejects.toMatchObject({
      code: 'AUTH_SESSION_DATABASE_WRITE_FAILED',
      operationalMetadata: {
        resource: 'DB',
        action: 'revoke_other_sessions',
      },
    } satisfies Partial<StudioOperationalError>);
  });

  it('revokes all sessions for a user through the role-change helper', async () => {
    let capturedParams: unknown[] = [];
    const database = {
      prepare(sql: string) {
        expect(normalizedSql(sql)).toBe(
          'DELETE FROM sessions WHERE user_id = ?',
        );
        return {
          bind(...params: unknown[]) {
            capturedParams = params;
            return {
              async run() {
                return { success: true, meta: { changes: 5 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(revokeAllUserSessions({
      db: database,
      userId,
    })).resolves.toBe(5);
    expect(capturedParams).toEqual([userId]);
  });
});
