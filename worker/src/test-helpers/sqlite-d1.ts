import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type SqliteRunResult = { changes: number | bigint };

export type SqliteD1Hooks = {
  failSqlOnce?: string;
  throwAfterCommitOnce?: boolean;
  executedStatements?: number;
  batches?: number;
};

export class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly hooks: SqliteD1Hooks,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, this.hooks, params);
  }

  private checkFailure() {
    if (this.hooks.failSqlOnce && this.sql.includes(this.hooks.failSqlOnce)) {
      this.hooks.failSqlOnce = undefined;
      throw new Error('Injected D1 statement failure');
    }
  }

  private recordExecution() {
    this.hooks.executedStatements = (this.hooks.executedStatements ?? 0) + 1;
  }

  async run(): Promise<D1Result<unknown>> {
    this.recordExecution();
    this.checkFailure();
    const result = (
      this.database.prepare(this.sql).run as (
        ...params: SQLInputValue[]
      ) => SqliteRunResult
    )(...this.params as SQLInputValue[]);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    this.recordExecution();
    this.checkFailure();
    const results = (
      this.database.prepare(this.sql).all as unknown as (
        ...params: SQLInputValue[]
      ) => T[]
    )(...this.params as SQLInputValue[]);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    this.recordExecution();
    this.checkFailure();
    const row = (
      this.database.prepare(this.sql).get as unknown as (
        ...params: SQLInputValue[]
      ) => T | undefined
    )(...this.params as SQLInputValue[]);
    return row ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:SELECT|WITH|PRAGMA)\b/iu.test(this.sql)
      || /\bRETURNING\b/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

export function sqliteD1(
  database: DatabaseSync,
  hooks: SqliteD1Hooks = {},
): D1Database {
  // A D1 connection serializes transactions. Parallel repository reads may
  // issue several batches; do not model those as nested SQLite transactions.
  let pendingBatch = Promise.resolve();
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql, hooks);
    },
    async batch(statements: SqliteD1Statement[]) {
      const previousBatch = pendingBatch;
      let releaseBatch!: () => void;
      pendingBatch = new Promise<void>((resolve) => { releaseBatch = resolve; });
      await previousBatch;
      try {
        hooks.batches = (hooks.batches ?? 0) + 1;
        database.exec('BEGIN IMMEDIATE');
        try {
          const results: D1Result<unknown>[] = [];
          for (const statement of statements) {
            results.push(await statement.execute());
          }
          database.exec('COMMIT');
          if (hooks.throwAfterCommitOnce) {
            hooks.throwAfterCommitOnce = false;
            throw new Error('Injected D1 response loss after commit');
          }
          return results;
        } catch (error) {
          if (database.isTransaction) database.exec('ROLLBACK');
          throw error;
        }
      } finally {
        releaseBatch();
      }
    },
  } as unknown as D1Database;
}
