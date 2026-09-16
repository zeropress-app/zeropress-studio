import { createPageRequestSchema, type Page } from '../../../contracts/pages';
import { createPostRequestSchema, type Post } from '../../../contracts/posts';
import {
  normalizePageContentSnapshot,
} from '../../../contracts/page-autosaves';
import {
  normalizePostContentSnapshot,
} from '../../../contracts/post-autosaves';
import {
  createPage,
  getPage,
} from '../pages/page-repository';
import {
  createPost,
  getPost,
  type PostAuthorScope,
} from '../posts/post-repository';
import {
  readPageAutosave,
  readPostAutosave,
} from './repository';

export type PostAutosavePromotionResult =
  | { kind: 'completed'; post: Post }
  | { kind: 'not_found' }
  | { kind: 'not_ready' }
  | { kind: 'author_scope_changed' };

export type PageAutosavePromotionResult =
  | { kind: 'completed'; page: Page }
  | { kind: 'not_found' }
  | { kind: 'not_ready' };

export async function promotePostAutosave(input: {
  db: D1Database;
  userId: string;
  draftId: string;
  authorScope?: PostAuthorScope;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<PostAutosavePromotionResult> {
  const autosave = await readPostAutosave({
    db: input.db,
    userId: input.userId,
    locator: { draftId: input.draftId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!autosave) return { kind: 'not_found' };
  const snapshot = normalizePostContentSnapshot(autosave.snapshot);
  if (
    input.authorScope
    && snapshot.draft.author_id !== input.authorScope.authorId
  ) return { kind: 'author_scope_changed' };
  if (autosave.target_id !== null) {
    const post = await getPost({
      db: input.db,
      id: autosave.target_id,
      ...(input.authorScope
        ? { authorId: input.authorScope.authorId }
        : {}),
    });
    return post ? { kind: 'completed', post } : { kind: 'not_ready' };
  }
  if (snapshot.draft.status !== 'draft') {
    return { kind: 'not_ready' };
  }
  const authored = createPostRequestSchema.safeParse({
    ...snapshot.draft,
    autosave_draft_id: autosave.draft_id,
  });
  if (!authored.success) return { kind: 'not_ready' };
  const created = await createPost({
    db: input.db,
    authored: authored.data,
    autosaveUserId: input.userId,
    bindAutosaveSnapshotSha256: autosave.snapshot_sha256,
    ...(input.authorScope ? { authorScope: input.authorScope } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.createId ? { createId: input.createId } : {}),
    ...(input.createRevision
      ? { createRevision: input.createRevision }
      : {}),
  });
  if (created.kind === 'completed') return created;
  if (created.kind === 'author_scope_changed') return created;
  if (created.kind !== 'autosave_conflict') return { kind: 'not_ready' };

  // A concurrent promotion may have completed first. Re-read the mutable
  // autosave to make this endpoint idempotent without creating another Draft.
  const latest = await readPostAutosave({
    db: input.db,
    userId: input.userId,
    locator: { draftId: input.draftId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!latest?.target_id) return { kind: 'not_ready' };
  const post = await getPost({
    db: input.db,
    id: latest.target_id,
    ...(input.authorScope ? { authorId: input.authorScope.authorId } : {}),
  });
  return post ? { kind: 'completed', post } : { kind: 'not_ready' };
}

export async function promotePageAutosave(input: {
  db: D1Database;
  userId: string;
  draftId: string;
  now?: Date;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<PageAutosavePromotionResult> {
  const autosave = await readPageAutosave({
    db: input.db,
    userId: input.userId,
    locator: { draftId: input.draftId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!autosave) return { kind: 'not_found' };
  const snapshot = normalizePageContentSnapshot(autosave.snapshot);
  if (autosave.target_id !== null) {
    const page = await getPage({ db: input.db, id: autosave.target_id });
    return page ? { kind: 'completed', page } : { kind: 'not_ready' };
  }
  if (snapshot.draft.status !== 'draft') {
    return { kind: 'not_ready' };
  }
  const authored = createPageRequestSchema.safeParse({
    ...snapshot.draft,
    autosave_draft_id: autosave.draft_id,
  });
  if (!authored.success) return { kind: 'not_ready' };
  const created = await createPage({
    db: input.db,
    authored: authored.data,
    autosaveUserId: input.userId,
    bindAutosaveSnapshotSha256: autosave.snapshot_sha256,
    ...(input.now ? { now: input.now } : {}),
    ...(input.createId ? { createId: input.createId } : {}),
    ...(input.createRevision
      ? { createRevision: input.createRevision }
      : {}),
  });
  if (created.kind === 'completed') return created;
  if (created.kind !== 'autosave_conflict') return { kind: 'not_ready' };

  const latest = await readPageAutosave({
    db: input.db,
    userId: input.userId,
    locator: { draftId: input.draftId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!latest?.target_id) return { kind: 'not_ready' };
  const page = await getPage({ db: input.db, id: latest.target_id });
  return page ? { kind: 'completed', page } : { kind: 'not_ready' };
}
