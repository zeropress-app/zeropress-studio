import { describe, expect, it } from 'vitest';
import {
  CONTENT_AUTOSAVE_DEBOUNCE_MS,
  CONTENT_AUTOSAVE_MAX_WAIT_MS,
  CONTENT_AUTOSAVE_MIN_WRITE_INTERVAL_MS,
  CONTENT_AUTOSAVE_TTL_SECONDS,
  CONTENT_REVISION_RETENTION_LIMIT,
} from './content-snapshots';
import {
  normalizePostContentSnapshot,
  postAutosaveDocumentSchema,
  postContentSnapshotSchema,
  putPostAutosaveRequestSchema,
} from './post-autosaves';
import {
  normalizePageContentSnapshot,
  pageAutosaveDocumentSchema,
  pageContentSnapshotSchema,
  putPageAutosaveRequestSchema,
} from './page-autosaves';

const EMPTY_POST_SNAPSHOT = {
  version: 2,
  content_type: 'post',
  draft: {
    title: '',
    slug: '',
    content: '',
    document_type: 'markdown',
    editor_mode: 'source',
    editor_profile: null,
    excerpt: '',
    status: 'draft',
    author_id: '',
    category_ids: [],
    tag_ids: [],
    discoverability: 'default',
    allow_comments: true,
    featured_image_id: null,
  },
  references: {
    author: null,
    categories: [],
    tags: [],
    featured_image: null,
  },
} as const;

const EMPTY_PAGE_SNAPSHOT = {
  version: 2,
  content_type: 'page',
  draft: {
    parent_id: null,
    title: '',
    slug: '',
    content: '',
    document_type: 'markdown',
    editor_mode: 'source',
    editor_profile: null,
    excerpt: '',
    status: 'draft',
    discoverability: 'default',
    allow_comments: false,
    featured_image_id: null,
  },
  references: { parent: null, featured_image: null },
} as const;

describe('common content snapshot contract', () => {
  it('keeps reviewed autosave and future revision policy in code constants', () => {
    expect(CONTENT_AUTOSAVE_DEBOUNCE_MS).toBe(15_000);
    expect(CONTENT_AUTOSAVE_MAX_WAIT_MS).toBe(60_000);
    expect(CONTENT_AUTOSAVE_MIN_WRITE_INTERVAL_MS).toBe(30_000);
    expect(CONTENT_AUTOSAVE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(CONTENT_REVISION_RETENTION_LIMIT).toBe(20);
  });

  it('accepts incomplete editor state while preserving a strict envelope', () => {
    expect(postContentSnapshotSchema.safeParse(EMPTY_POST_SNAPSHOT).success)
      .toBe(true);
    expect(pageContentSnapshotSchema.safeParse(EMPTY_PAGE_SNAPSHOT).success)
      .toBe(true);
    expect(postContentSnapshotSchema.safeParse({
      ...EMPTY_POST_SNAPSHOT,
      unexpected: true,
    }).success).toBe(false);
  });

  it('reads v1 snapshots as safe source state while new writes require v2', () => {
    const legacyPost = {
      ...EMPTY_POST_SNAPSHOT,
      version: 1 as const,
      draft: Object.fromEntries(Object.entries(EMPTY_POST_SNAPSHOT.draft)
        .filter(([key]) => !['editor_mode', 'editor_profile'].includes(key))),
    };
    const legacyPage = {
      ...EMPTY_PAGE_SNAPSHOT,
      version: 1 as const,
      draft: Object.fromEntries(Object.entries(EMPTY_PAGE_SNAPSHOT.draft)
        .filter(([key]) => !['editor_mode', 'editor_profile'].includes(key))),
    };
    const parsedPost = postContentSnapshotSchema.parse(legacyPost);
    const parsedPage = pageContentSnapshotSchema.parse(legacyPage);
    expect(normalizePostContentSnapshot(parsedPost)).toMatchObject({
      version: 2,
      draft: { editor_mode: 'source', editor_profile: null },
    });
    expect(normalizePageContentSnapshot(parsedPage)).toMatchObject({
      version: 2,
      draft: { editor_mode: 'source', editor_profile: null },
    });
    expect(putPostAutosaveRequestSchema.safeParse({
      draft_id: '2'.repeat(32),
      target_id: null,
      base_revision: null,
      snapshot: legacyPost,
    }).success).toBe(false);
    expect(putPageAutosaveRequestSchema.safeParse({
      draft_id: '2'.repeat(32),
      target_id: null,
      base_revision: null,
      snapshot: legacyPage,
    }).success).toBe(false);
  });

  it('requires presentation references to match authored relation IDs', () => {
    expect(postContentSnapshotSchema.safeParse({
      ...EMPTY_POST_SNAPSHOT,
      draft: { ...EMPTY_POST_SNAPSHOT.draft, author_id: 'site-owner' },
    }).success).toBe(false);
    expect(pageContentSnapshotSchema.safeParse({
      ...EMPTY_PAGE_SNAPSHOT,
      draft: { ...EMPTY_PAGE_SNAPSHOT.draft, parent_id: '1'.repeat(32) },
    }).success).toBe(false);
  });

  it('requires target and base revision together and permits new drafts', () => {
    expect(putPostAutosaveRequestSchema.safeParse({
      draft_id: '2'.repeat(32),
      target_id: null,
      base_revision: null,
      snapshot: EMPTY_POST_SNAPSHOT,
    }).success).toBe(true);
    expect(putPageAutosaveRequestSchema.safeParse({
      draft_id: '2'.repeat(32),
      target_id: '3'.repeat(32),
      base_revision: null,
      snapshot: EMPTY_PAGE_SNAPSHOT,
    }).success).toBe(false);
  });

  it('expires only unbound snapshots and retains target-bound recovery state', () => {
    const common = {
      draft_id: '2'.repeat(32),
      snapshot_sha256: '4'.repeat(64),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:01:00.000Z',
    };
    expect(postAutosaveDocumentSchema.safeParse({
      ...common,
      target_id: null,
      base_revision: null,
      snapshot: EMPTY_POST_SNAPSHOT,
      expires_at_iso: '2026-08-08T00:01:00.000Z',
    }).success).toBe(true);
    expect(pageAutosaveDocumentSchema.safeParse({
      ...common,
      target_id: '3'.repeat(32),
      base_revision: '5'.repeat(32),
      snapshot: EMPTY_PAGE_SNAPSHOT,
      expires_at_iso: null,
    }).success).toBe(true);
    expect(postAutosaveDocumentSchema.safeParse({
      ...common,
      target_id: '3'.repeat(32),
      base_revision: '5'.repeat(32),
      snapshot: EMPTY_POST_SNAPSHOT,
      expires_at_iso: '2026-08-08T00:01:00.000Z',
    }).success).toBe(false);
  });
});
