import { describe, expect, it } from 'vitest';
import {
  COMMENT_BULK_MODERATION_MAX_ITEMS,
  commentBulkModerationDataSchema,
  commentBulkModerationRequestSchema,
  commentListQuerySchema,
  commentTargetOptionsQuerySchema,
  createStudioCommentRequestSchema,
  managedCommentSchema,
  updateCommentRequestSchema,
} from './comments';

const comment = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  target_type: 'post',
  target_public_id: 100_000_000_002,
  target: {
    type: 'post',
    id: '2'.repeat(32),
    public_id: 100_000_000_002,
    title: 'Hello',
    slug: 'hello',
  },
  parent_public_id: null,
  reply: { available: false, reason: 'not_approved' },
  author: {
    name: 'Reader',
    email: 'reader@example.com',
    kind: 'guest',
  },
  content_text: 'A comment',
  status: 'pending',
  ip_address: '203.0.113.1',
  user_agent: 'Example browser',
  created_at_iso: '2026-08-02T00:00:00.000Z',
  updated_at_iso: '2026-08-02T00:00:00.000Z',
};

describe('comment management contract', () => {
  it('accepts a target-aware management response and rejects mismatches', () => {
    expect(managedCommentSchema.safeParse(comment).success).toBe(true);
    expect(managedCommentSchema.safeParse({
      ...comment,
      author: { ...comment.author, email: '' },
    }).success).toBe(true);
    expect(managedCommentSchema.safeParse({
      ...comment,
      target: { ...comment.target, type: 'page' },
    }).success).toBe(false);
  });

  it('normalizes bounded list filters and requires a typed public ID', () => {
    expect(commentListQuerySchema.parse({})).toEqual({
      search: '',
      status: 'all',
      target_type: 'all',
      page: 1,
      per_page: 50,
    });
    expect(commentListQuerySchema.parse({
      target_type: 'page',
      target_public_id: '123',
    }).target_public_id).toBe(123);
    expect(commentListQuerySchema.safeParse({
      target_public_id: '123',
    }).success).toBe(false);
  });

  it('validates authoring targets, reply state, and bounded comment input', () => {
    expect(commentTargetOptionsQuerySchema.parse({
      target_type: 'page',
    })).toEqual({ target_type: 'page', search: '' });
    expect(createStudioCommentRequestSchema.parse({
      target_type: 'post',
      target_public_id: 123,
      parent_public_id: null,
      content_text: '  Studio comment  ',
    })).toEqual({
      target_type: 'post',
      target_public_id: 123,
      parent_public_id: null,
      content_text: 'Studio comment',
    });
    expect(createStudioCommentRequestSchema.safeParse({
      target_type: 'post',
      target_public_id: 123,
      parent_public_id: null,
      content_text: ' ',
    }).success).toBe(false);
    expect(managedCommentSchema.safeParse({
      ...comment,
      status: 'approved',
      reply: { available: true },
    }).success).toBe(true);
    expect(managedCommentSchema.safeParse({
      ...comment,
      reply: { available: true, reason: 'depth_limit' },
    }).success).toBe(false);
  });

  it.each([
    ['symbols', '© ® ™ ♥ ★ 😊', '© ® ™ ♥ ★ 😊'],
    ['emoji sequences', '👨‍👩‍👧‍👦 👍🏽 🇯🇵 1️⃣ #️⃣ *️⃣ ♥\uFE0E ♥\uFE0F', '👨‍👩‍👧‍👦 👍🏽 🇯🇵 1️⃣ #️⃣ *️⃣ ♥\uFE0E ♥\uFE0F'],
    ['Japanese', 'ところで、今日は忙しいのでこの業務を処理できません。', 'ところで、今日は忙しいのでこの業務を処理できません。'],
    ['plain text', '<b>text</b> & "quotes"', '<b>text</b> & "quotes"'],
    ['Unicode composition', 'e\u0301 Ａ ①', 'e\u0301 Ａ ①'],
    ['controls and whitespace', ' \u0000©😊\u0007\r\n \t👨‍👩‍👧‍👦 \r\n\r\n\r\n終\t\t了\u001B\u007F\u0085\u009F ', '©😊\n👨‍👩‍👧‍👦\n\n終 了'],
  ])('uses the same free-text policy for new comments, replies, and edits: %s', (_label, input, expected) => {
    for (const parentId of [null, comment.public_id]) {
      expect(createStudioCommentRequestSchema.parse({
        target_type: 'post', target_public_id: 123,
        parent_public_id: parentId, content_text: input,
      }).content_text).toBe(expected);
    }
    expect(updateCommentRequestSchema.parse({
      content_text: input, expected_updated_at_iso: comment.updated_at_iso,
    }).content_text).toBe(expected);
  });

  it('validates non-empty string content and its UTF-16 length after normalization', () => {
    const content = '😊'.repeat(2500);
    const create = (value: unknown) => createStudioCommentRequestSchema.safeParse({
      target_type: 'post', target_public_id: 123,
      parent_public_id: null, content_text: value,
    });
    const update = (value: unknown) => updateCommentRequestSchema.safeParse({
      content_text: value, expected_updated_at_iso: comment.updated_at_iso,
    });
    for (const parse of [create, update]) {
      expect(parse('😊').success).toBe(true);
      expect(parse('©').success).toBe(true);
      expect(parse(` \u0000${content} `)).toMatchObject({
        success: true, data: { content_text: content },
      });
      for (const invalid of [
        ' \u0000\u0007\u001B\u007F\u0085\u009F\t\r\n ',
        `${content}©`, 123, ['😊'], null,
      ]) {
        expect(parse(invalid).success).toBe(false);
      }
    }
  });

  it('requires optimistic concurrency and an actual mutation', () => {
    expect(updateCommentRequestSchema.safeParse({
      status: 'approved',
      expected_updated_at_iso: comment.updated_at_iso,
    }).success).toBe(true);
    expect(updateCommentRequestSchema.safeParse({
      expected_updated_at_iso: comment.updated_at_iso,
    }).success).toBe(false);
    expect(updateCommentRequestSchema.safeParse({
      content: 'legacy',
      expected_updated_at_iso: comment.updated_at_iso,
    }).success).toBe(false);
  });

  it('bounds revision-bound bulk moderation and verifies result summaries', () => {
    const item = {
      id: comment.id,
      expected_updated_at_iso: comment.updated_at_iso,
    };
    expect(commentBulkModerationRequestSchema.parse({
      operation: 'set_status',
      status: 'approved',
      items: [item],
    })).toEqual({
      operation: 'set_status',
      status: 'approved',
      items: [item],
    });
    expect(commentBulkModerationRequestSchema.safeParse({
      operation: 'delete_permanently',
      items: [item, item],
    }).success).toBe(false);
    expect(commentBulkModerationRequestSchema.safeParse({
      operation: 'set_status',
      status: 'pending',
      items: Array.from(
        { length: COMMENT_BULK_MODERATION_MAX_ITEMS + 1 },
        (_, index) => ({ ...item, id: `${index}`.padStart(32, 'a') }),
      ),
    }).success).toBe(false);

    expect(commentBulkModerationDataSchema.safeParse({
      operation: 'delete_permanently',
      results: [{ id: comment.id, outcome: 'updated', deleted_count: 3 }],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        deleted_comments: 3,
      },
    }).success).toBe(true);
    expect(commentBulkModerationDataSchema.safeParse({
      operation: 'delete_permanently',
      results: [{ id: comment.id, outcome: 'updated', deleted_count: 3 }],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        deleted_comments: 2,
      },
    }).success).toBe(false);
  });
});
