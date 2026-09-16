import { z } from 'zod';

export const CONTENT_SEARCH_QUERY_MAX_LENGTH = 200;
export const CONTENT_SEARCH_CONTEXT_MAX_LENGTH = 320;
export const CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS = 32;

export const contentSearchHighlightSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).strict().refine((value) => value.start < value.end);

export const contentSearchMatchSchema = z.object({
  field: z.enum(['excerpt', 'content']),
  text: z.string().max(CONTENT_SEARCH_CONTEXT_MAX_LENGTH),
  highlights: z.array(contentSearchHighlightSchema)
    .max(CONTENT_SEARCH_HIGHLIGHT_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  let previousEnd = 0;
  for (const [index, highlight] of value.highlights.entries()) {
    if (highlight.end > value.text.length) {
      context.addIssue({
        code: 'custom',
        path: ['highlights', index, 'end'],
        message: 'Search highlight extends beyond its text context.',
      });
    }
    if (highlight.start < previousEnd) {
      context.addIssue({
        code: 'custom',
        path: ['highlights', index, 'start'],
        message: 'Search highlights must be ordered and non-overlapping.',
      });
    }
    previousEnd = Math.max(previousEnd, highlight.end);
  }
});

export type ContentSearchMatch = z.infer<typeof contentSearchMatchSchema>;

export type ContentSearchToken = {
  value: string;
  codePointLength: number;
};

export type ContentSearchPlan = {
  tokens: ContentSearchToken[];
  longTokens: string[];
  shortTokens: string[];
  matchExpression: string | null;
};

const SEARCH_TOKEN_PATTERN = /[\p{L}\p{Nd}](?:[\p{L}\p{M}\p{Nd}]|[._-](?=[\p{L}\p{Nd}]))*(?:\+\+|#)?/gu;

export class ContentSearchQueryInvalidError extends Error {
  constructor() {
    super('Content search query contains no searchable token.');
    this.name = 'ContentSearchQueryInvalidError';
  }
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export function parseContentSearchQuery(value: string): ContentSearchPlan {
  const input = value.trim();
  if (input.length > CONTENT_SEARCH_QUERY_MAX_LENGTH) {
    throw new ContentSearchQueryInvalidError();
  }
  const tokens: ContentSearchToken[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(SEARCH_TOKEN_PATTERN)) {
    const token = match[0];
    const comparison = token.toLowerCase();
    if (seen.has(comparison)) continue;
    seen.add(comparison);
    tokens.push({
      value: token,
      codePointLength: Array.from(token).length,
    });
  }
  if (tokens.length === 0) throw new ContentSearchQueryInvalidError();
  const longTokens = tokens
    .filter((token) => token.codePointLength >= 3)
    .map((token) => token.value);
  const shortTokens = tokens
    .filter((token) => token.codePointLength < 3)
    .map((token) => token.value);
  return {
    tokens,
    longTokens,
    shortTokens,
    matchExpression: longTokens.length === 0
      ? null
      : longTokens.map(quoteFtsPhrase).join(' AND '),
  };
}
