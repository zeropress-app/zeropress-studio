import { describe, expect, it } from 'vitest';
import { contentBulkDeleteRequestSchema, contentBulkDeleteSuccessSchema } from './content-bulk-delete';

describe('bounded content deletion contract', () => {
  it('accepts only explicit, unique, revision-guarded selections of up to ten documents', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: index.toString(16).repeat(32), expected_revision: 'a'.repeat(32),
    }));
    expect(contentBulkDeleteRequestSchema.safeParse({ items }).success).toBe(true);
    for (const request of [
      { items: [] }, { items: [...items, { id: 'f'.repeat(32), expected_revision: 'a'.repeat(32) }] },
      { items: [items[0], items[0]] }, { items: [{ id: items[0].id }] },
      { items, all: true },
    ]) expect(contentBulkDeleteRequestSchema.safeParse(request).success).toBe(false);
    expect(contentBulkDeleteSuccessSchema.safeParse({ success: true, data: {
      results: [{ id: items[0].id, outcome: 'deleted' }],
      summary: { requested: 1, updated: 0, unchanged: 0, conflict: 0, skipped: 1 },
    } }).success).toBe(false);
  });
});
