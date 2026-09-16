import { describe, expect, it } from 'vitest';
import {
  splitSqlStatements,
  SqlStatementSyntaxError,
} from './sql-statements';

describe('SQLite statement tokenizer', () => {
  it('preserves complete trigger bodies with CASE and internal semicolons', () => {
    const statements = splitSqlStatements(`
      -- leading artifact comment
      CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT);
      CREATE TRIGGER media_guard
      BEFORE UPDATE ON media
      BEGIN
        SELECT CASE WHEN NEW.kind = 'bad;kind'
          THEN RAISE(ABORT, 'bad -- value') END;
        SELECT 1;
      END;
      INSERT INTO media VALUES ('one;two', 'image');
    `);

    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('CREATE TRIGGER media_guard');
    expect(statements[1]).toContain("RAISE(ABORT, 'bad -- value') END;");
    expect(statements[1]).toContain('SELECT 1;');
    expect(statements[1]).toMatch(/END$/u);
    expect(statements[2]).toContain("'one;two'");
  });

  it('discards line and block comments without joining adjacent tokens', () => {
    const statements = splitSqlStatements(`
      CREATE /* comment */ TABLE example (id INTEGER);
      INSERT INTO example -- comment
      VALUES (1);
    `).map((statement) => statement.replace(/\s+/gu, ' '));

    expect(statements).toEqual([
      'CREATE  TABLE example (id INTEGER)',
      'INSERT INTO example  VALUES (1)',
    ].map((statement) => statement.replace(/\s+/gu, ' ')));
  });

  it('accepts a final statement without a trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('rejects incomplete lexical and trigger states', () => {
    expect(() => splitSqlStatements("SELECT 'broken"))
      .toThrow(SqlStatementSyntaxError);
    expect(() => splitSqlStatements('SELECT 1 /* broken'))
      .toThrow(SqlStatementSyntaxError);
    expect(() => splitSqlStatements(`
      CREATE TRIGGER broken AFTER INSERT ON sample BEGIN SELECT 1;
    `)).toThrow(SqlStatementSyntaxError);
  });
});
