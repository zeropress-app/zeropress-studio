export class SqlStatementSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlStatementSyntaxError';
  }
}

type QuoteState = 'single' | 'double' | 'backtick' | 'bracket' | null;
type TriggerBlock = 'begin' | 'case';

function isWordCharacter(value: string): boolean {
  return /[A-Za-z0-9_]/u.test(value);
}

function isCreateTriggerPrefix(tokens: readonly string[]): boolean {
  if (tokens[0] !== 'CREATE') return false;
  let index = 1;
  if (tokens[index] === 'TEMP' || tokens[index] === 'TEMPORARY') {
    index += 1;
  }
  return tokens[index] === 'TRIGGER';
}

/**
 * Split a reviewed SQLite artifact into complete statements.
 *
 * This is deliberately a tokenizer rather than `String.split(';')`: SQLite
 * trigger bodies contain statement terminators between `BEGIN` and `END`, and
 * authored text may contain semicolons or comment markers inside quoted
 * values. Comments are discarded and are therefore suitable for artifact
 * metadata which must never be passed to D1 as executable SQL.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let word = '';
  let quote: QuoteState = null;
  let lineComment = false;
  let blockComment = false;
  let createTrigger = false;
  let tokens: string[] = [];
  const triggerBlocks: TriggerBlock[] = [];

  const appendSpace = () => {
    if (current.length > 0 && !/\s$/u.test(current)) current += ' ';
  };

  const flushWord = () => {
    if (word.length === 0) return;
    const token = word.toUpperCase();
    if (tokens.length < 4) {
      tokens.push(token);
      createTrigger = isCreateTriggerPrefix(tokens);
    }
    if (createTrigger) {
      if (token === 'BEGIN') {
        triggerBlocks.push('begin');
      } else if (token === 'CASE') {
        triggerBlocks.push('case');
      } else if (token === 'END' && triggerBlocks.length > 0) {
        triggerBlocks.pop();
      }
    }
    word = '';
  };

  const finishStatement = () => {
    flushWord();
    const statement = current.trim();
    if (statement.length > 0) statements.push(statement);
    current = '';
    tokens = [];
    createTrigger = false;
    triggerBlocks.length = 0;
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        appendSpace();
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
        appendSpace();
      }
      continue;
    }

    if (quote !== null) {
      current += character;
      const closingCharacter = quote === 'single'
        ? "'"
        : quote === 'double'
          ? '"'
          : quote === 'backtick'
            ? '`'
            : ']';
      if (character !== closingCharacter) continue;
      if (next === closingCharacter && quote !== 'bracket') {
        current += next;
        index += 1;
        continue;
      }
      quote = null;
      continue;
    }

    if (character === '-' && next === '-') {
      flushWord();
      lineComment = true;
      index += 1;
      appendSpace();
      continue;
    }
    if (character === '/' && next === '*') {
      flushWord();
      blockComment = true;
      index += 1;
      appendSpace();
      continue;
    }

    if (
      character === "'"
      || character === '"'
      || character === '`'
      || character === '['
    ) {
      flushWord();
      quote = character === "'"
        ? 'single'
        : character === '"'
          ? 'double'
          : character === '`'
            ? 'backtick'
            : 'bracket';
      current += character;
      continue;
    }

    if (isWordCharacter(character)) {
      word += character;
      current += character;
      continue;
    }

    flushWord();
    if (character === ';') {
      if (createTrigger && triggerBlocks.length > 0) {
        current += character;
      } else {
        finishStatement();
      }
      continue;
    }
    current += character;
  }

  if (blockComment) {
    throw new SqlStatementSyntaxError('SQL contains an unterminated block comment.');
  }
  if (quote !== null) {
    throw new SqlStatementSyntaxError('SQL contains an unterminated quoted value or identifier.');
  }
  flushWord();
  if (createTrigger && triggerBlocks.length > 0) {
    throw new SqlStatementSyntaxError('SQL contains an unterminated trigger body.');
  }
  finishStatement();
  return statements;
}
