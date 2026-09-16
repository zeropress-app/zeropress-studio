import { describe, expect, it } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import { garbageCollectExpiredSessions } from './session-garbage-collector';

type CapturedStatement = {
  sql: string;
  params: unknown[];
  bind(...params: unknown[]): CapturedStatement;
};

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

describe('expired session garbage collection', () => {
  it('uses separate indexed expiry predicates and reports deleted rows', async () => {
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
        return [
          { success: true, meta: { changes: 3 } },
          { success: true, meta: { changes: 2 } },
        ];
      },
    } as unknown as D1Database;
    const now = new Date('2026-07-31T18:23:00.000Z');

    await expect(garbageCollectExpiredSessions({
      db: database,
      now,
    })).resolves.toEqual({
      cutoff_at_iso: now.toISOString(),
      deleted_rows: 5,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]).toMatchObject({
      sql: 'DELETE FROM sessions WHERE idle_expires_at_iso <= ?',
      params: [now.toISOString()],
    });
    expect(batches[0]?.[1]).toMatchObject({
      sql: 'DELETE FROM sessions WHERE absolute_expires_at_iso <= ?',
      params: [now.toISOString()],
    });
  });

  it('classifies D1 cleanup failures for the scheduled handler', async () => {
    const database = {
      prepare() {
        return { bind() { return this; } };
      },
      async batch() {
        throw new Error('D1 cleanup unavailable');
      },
    } as unknown as D1Database;

    await expect(garbageCollectExpiredSessions({
      db: database,
    })).rejects.toMatchObject({
      code: 'AUTH_SESSION_GARBAGE_COLLECTION_FAILED',
      operationalMetadata: {
        resource: 'DB',
        action: 'garbage_collect_sessions',
      },
    } satisfies Partial<StudioOperationalError>);
  });
});
