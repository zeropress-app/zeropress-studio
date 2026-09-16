import { describe, expect, it } from 'vitest';
import {
  contentSearchMatchSchema,
  ContentSearchQueryInvalidError,
  parseContentSearchQuery,
} from './content-search';

describe('Studio content-search query contract', () => {
  it('preserves meaningful punctuation and separates presentation punctuation', () => {
    expect(parseContentSearchQuery(
      'Ubuntu 24.04 LTS 에서 웹서버(NGINX + PHP-FPM + MySQL) 구성하기',
    ).tokens.map(({ value }) => value)).toEqual([
      'Ubuntu',
      '24.04',
      'LTS',
      '에서',
      '웹서버',
      'NGINX',
      'PHP-FPM',
      'MySQL',
      '구성하기',
    ]);
    expect(parseContentSearchQuery('C++ C# foo_bar foo.bar foo-bar').tokens)
      .toEqual(expect.arrayContaining([
        { value: 'C++', codePointLength: 3 },
        { value: 'C#', codePointLength: 2 },
        { value: 'foo_bar', codePointLength: 7 },
        { value: 'foo.bar', codePointLength: 7 },
        { value: 'foo-bar', codePointLength: 7 },
      ]));
  });

  it('quotes every long token instead of exposing FTS syntax', () => {
    const plan = parseContentSearchQuery(
      'AND OR NEAR title:alpha "quoted" wild* literal',
    );
    expect(plan.tokens.map(({ value }) => value)).toEqual([
      'AND', 'OR', 'NEAR', 'title', 'alpha', 'quoted', 'wild', 'literal',
    ]);
    expect(plan.matchExpression).toBe(
      '"AND" AND "NEAR" AND "title" AND "alpha" AND '
      + '"quoted" AND "wild" AND "literal"',
    );
    expect(plan.shortTokens).toContain('OR');
  });

  it('deduplicates case-insensitively and keeps every distinct query token', () => {
    const many = Array.from({ length: 24 }, (_, index) => `token${index}`);
    const plan = parseContentSearchQuery(`Alpha alpha ALPHA ${many.join(' ')}`);
    expect(plan.tokens.map(({ value }) => value)).toEqual(['Alpha', ...many]);
    expect(plan.matchExpression?.split(' AND ')).toHaveLength(25);
  });

  it('separates one- and two-code-point terms from FTS terms', () => {
    expect(parseContentSearchQuery('웹 서버 search')).toMatchObject({
      shortTokens: ['웹', '서버'],
      longTokens: ['search'],
      matchExpression: '"search"',
    });
  });

  it('uses the full 200 UTF-16-code-unit boundary and rejects empty semantics', () => {
    expect(parseContentSearchQuery('a'.repeat(200)).tokens[0]?.value)
      .toHaveLength(200);
    expect(() => parseContentSearchQuery('a'.repeat(201)))
      .toThrow(ContentSearchQueryInvalidError);
    expect(() => parseContentSearchQuery(' (+/*) "" '))
      .toThrow(ContentSearchQueryInvalidError);
    expect(() => parseContentSearchQuery('\u0301\u0308'))
      .toThrow(ContentSearchQueryInvalidError);
  });

  it('accepts only bounded, ordered, non-overlapping plain-text highlights', () => {
    expect(contentSearchMatchSchema.safeParse({
      field: 'content',
      text: 'Apache PHP',
      highlights: [{ start: 0, end: 6 }, { start: 7, end: 10 }],
    }).success).toBe(true);
    expect(contentSearchMatchSchema.safeParse({
      field: 'content',
      text: 'Apache PHP',
      highlights: [{ start: 7, end: 10 }, { start: 0, end: 6 }],
    }).success).toBe(false);
    expect(contentSearchMatchSchema.safeParse({
      field: 'content',
      text: 'Apache',
      highlights: [{ start: 0, end: 7 }],
    }).success).toBe(false);
  });
});
