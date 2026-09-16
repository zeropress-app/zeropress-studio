import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach } from 'vitest';
import { sqliteD1, type SqliteD1Hooks } from './sqlite-d1';

const baseline = readFileSync(
  new URL('../../../database/install/001_baseline.sql', import.meta.url), 'utf8',
);
const opened: DatabaseSync[] = [];
const wrapped = new WeakMap<D1Database, D1Database>();

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

export function createAuthDatabase(hooks: SqliteD1Hooks = {}) {
  const sqlite = new DatabaseSync(':memory:');
  opened.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  return { sqlite, db: sqliteD1(sqlite, hooks) };
}

// Existing route tests stub unrelated repositories. Keep those stubs while
// executing the real rate-limit SQL, including transactional reservations.
export function withAuthRateLimits(database: D1Database): D1Database {
  const existing = wrapped.get(database);
  if (existing) return existing;
  const { db } = createAuthDatabase();
  const result = {
    ...database,
    prepare(sql: string) {
      return sql.includes('auth_rate_limits') ? db.prepare(sql) : database.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      return statements.every((statement) => (
        (statement as unknown as { sql?: string }).sql?.includes('auth_rate_limits')
      )) ? db.batch(statements) : database.batch(statements);
    },
  } as D1Database;
  wrapped.set(database, result);
  return result;
}
