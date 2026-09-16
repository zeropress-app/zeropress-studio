import {
  CONTENT_REVISION_RETENTION_LIMIT,
  CONTENT_SNAPSHOT_VERSION,
} from '../../../contracts/content-snapshots';
import {
  contentRevisionListSchema,
  contentRevisionSummarySchema,
  type ContentRevisionList,
} from '../../../contracts/content-revisions';
import {
  postContentSnapshotSchema,
  type PostContentSnapshot,
} from '../../../contracts/post-autosaves';
import {
  postRevisionDocumentSchema,
  type PostRevisionDocument,
} from '../../../contracts/post-revisions';
import {
  pageContentSnapshotSchema,
  type PageContentSnapshot,
} from '../../../contracts/page-autosaves';
import {
  pageRevisionDocumentSchema,
  type PageRevisionDocument,
} from '../../../contracts/page-revisions';
import type { Post } from '../../../contracts/posts';
import type { Page } from '../../../contracts/pages';
import { StudioOperationalError } from '../lib/operational-error';

type ContentKind = 'post' | 'page';
type ContentSnapshot = PostContentSnapshot | PageContentSnapshot;

type RevisionRow = {
  revision_id: unknown;
  snapshot_version?: unknown;
  snapshot_json?: unknown;
  snapshot_sha256?: unknown;
  saved_at_iso: unknown;
  title?: unknown;
  status?: unknown;
};

type PreparedRevision = {
  revisionId: string;
  savedAtIso: string;
  snapshot: ContentSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
};

const CONFIG = {
  post: {
    table: 'post_revisions',
    targetTable: 'posts',
    targetColumn: 'post_id',
    queryFailureCode: 'POST_MANAGEMENT_DATABASE_QUERY_FAILED',
    writeFailureCode: 'POST_MANAGEMENT_DATABASE_WRITE_FAILED',
    dataInvalidCode: 'POST_MANAGEMENT_DATA_INVALID',
    snapshotSchema: postContentSnapshotSchema,
    documentSchema: postRevisionDocumentSchema,
  },
  page: {
    table: 'page_revisions',
    targetTable: 'pages',
    targetColumn: 'page_id',
    queryFailureCode: 'PAGE_MANAGEMENT_DATABASE_QUERY_FAILED',
    writeFailureCode: 'PAGE_MANAGEMENT_DATABASE_WRITE_FAILED',
    dataInvalidCode: 'PAGE_MANAGEMENT_DATA_INVALID',
    snapshotSchema: pageContentSnapshotSchema,
    documentSchema: pageRevisionDocumentSchema,
  },
} as const;

function metadata(kind: ContentKind, action: string) {
  return { resource: 'DB', action, content_type: kind };
}

async function snapshotDigest(snapshotJson: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotJson),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function pageParentReference(page: Page) {
  if (!page.parent) return null;
  const segments = page.path.split('/');
  segments.pop();
  return {
    id: page.parent.id,
    title: page.parent.title,
    slug: page.parent.slug,
    path: segments.join('/'),
  };
}

export function postSnapshotFromCanonical(post: Post): PostContentSnapshot {
  return postContentSnapshotSchema.parse({
    version: CONTENT_SNAPSHOT_VERSION,
    content_type: 'post',
    draft: {
      title: post.title,
      slug: post.slug,
      content: post.content,
      document_type: post.document_type,
      editor_mode: post.editor_mode,
      editor_profile: post.editor_profile,
      excerpt: post.excerpt,
      status: post.status,
      author_id: post.author.id,
      category_ids: post.categories.map((item) => item.id),
      tag_ids: post.tags.map((item) => item.id),
      discoverability: post.discoverability,
      allow_comments: post.allow_comments,
      featured_image_id: post.featured_image?.id ?? null,
    },
    references: {
      author: post.author,
      categories: post.categories,
      tags: post.tags,
      featured_image: post.featured_image,
    },
  });
}

export function pageSnapshotFromCanonical(page: Page): PageContentSnapshot {
  return pageContentSnapshotSchema.parse({
    version: CONTENT_SNAPSHOT_VERSION,
    content_type: 'page',
    draft: {
      parent_id: page.parent?.id ?? null,
      title: page.title,
      slug: page.slug,
      content: page.content,
      document_type: page.document_type,
      editor_mode: page.editor_mode,
      editor_profile: page.editor_profile,
      excerpt: page.excerpt,
      status: page.status,
      discoverability: page.discoverability,
      allow_comments: page.allow_comments,
      featured_image_id: page.featured_image?.id ?? null,
    },
    references: {
      parent: pageParentReference(page),
      featured_image: page.featured_image,
    },
  });
}

async function prepareRevision(input: {
  revisionId: string;
  savedAtIso: string;
  snapshot: ContentSnapshot;
}): Promise<PreparedRevision> {
  const snapshotJson = JSON.stringify(input.snapshot);
  return {
    ...input,
    snapshotJson,
    snapshotSha256: await snapshotDigest(snapshotJson),
  };
}

export function preparePostRevision(post: Post) {
  return prepareRevision({
    revisionId: post.revision,
    savedAtIso: post.updated_at_iso,
    snapshot: postSnapshotFromCanonical(post),
  });
}

export function preparePageRevision(page: Page) {
  return prepareRevision({
    revisionId: page.revision,
    savedAtIso: page.updated_at_iso,
    snapshot: pageSnapshotFromCanonical(page),
  });
}

function archiveRevisionStatements(input: {
  db: D1Database;
  kind: ContentKind;
  targetId: string;
  guardRevision: string;
  archivedAtIso: string;
  prepared: PreparedRevision;
}): D1PreparedStatement[] {
  const config = CONFIG[input.kind];
  return [
    input.db.prepare(`
      INSERT INTO ${config.table} (
        ${config.targetColumn}, revision_id, snapshot_version, snapshot_json,
        snapshot_sha256, saved_at_iso, archived_at_iso
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ${config.targetTable} WHERE id = ? AND revision = ?
      )
    `).bind(
      input.targetId,
      input.prepared.revisionId,
      CONTENT_SNAPSHOT_VERSION,
      input.prepared.snapshotJson,
      input.prepared.snapshotSha256,
      input.prepared.savedAtIso,
      input.archivedAtIso,
      input.targetId,
      input.guardRevision,
    ),
    input.db.prepare(`
      DELETE FROM ${config.table}
      WHERE ${config.targetColumn} = ?
        AND revision_id IN (
          SELECT revision_id
          FROM ${config.table}
          WHERE ${config.targetColumn} = ?
          ORDER BY archived_at_iso DESC, revision_id DESC
          LIMIT -1 OFFSET ${CONTENT_REVISION_RETENTION_LIMIT}
        )
        AND EXISTS (
          SELECT 1 FROM ${config.targetTable} WHERE id = ? AND revision = ?
        )
    `).bind(
      input.targetId,
      input.targetId,
      input.targetId,
      input.guardRevision,
    ),
  ];
}

export function archivePostRevisionStatements(input: {
  db: D1Database;
  postId: string;
  guardRevision: string;
  archivedAtIso: string;
  prepared: PreparedRevision;
}) {
  return archiveRevisionStatements({
    db: input.db,
    kind: 'post',
    targetId: input.postId,
    guardRevision: input.guardRevision,
    archivedAtIso: input.archivedAtIso,
    prepared: input.prepared,
  });
}

export function archivePageRevisionStatements(input: {
  db: D1Database;
  pageId: string;
  guardRevision: string;
  archivedAtIso: string;
  prepared: PreparedRevision;
}) {
  return archiveRevisionStatements({
    db: input.db,
    kind: 'page',
    targetId: input.pageId,
    guardRevision: input.guardRevision,
    archivedAtIso: input.archivedAtIso,
    prepared: input.prepared,
  });
}

async function listRevisions(input: {
  db: D1Database;
  kind: ContentKind;
  targetId: string;
  currentRevision: string;
  currentSavedAtIso: string;
  currentTitle: string;
  currentStatus: 'draft' | 'published' | 'trash';
}): Promise<ContentRevisionList> {
  const config = CONFIG[input.kind];
  let result: D1Result<RevisionRow>;
  try {
    result = await input.db.prepare(`
      SELECT revision_id, saved_at_iso,
             json_extract(snapshot_json, '$.draft.title') AS title,
             json_extract(snapshot_json, '$.draft.status') AS status
      FROM ${config.table}
      WHERE ${config.targetColumn} = ?
      ORDER BY archived_at_iso DESC, revision_id DESC
      LIMIT ${CONTENT_REVISION_RETENTION_LIMIT}
    `).bind(input.targetId).all<RevisionRow>();
  } catch (cause) {
    throw new StudioOperationalError(config.queryFailureCode, {
      cause,
      metadata: metadata(input.kind, 'list_content_revisions'),
    });
  }
  try {
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned an invalid revision list.');
    }
    const historical = result.results.map((row) => (
      contentRevisionSummarySchema.parse({
        revision_id: row.revision_id,
        saved_at_iso: row.saved_at_iso,
        current: false,
        title: row.title,
        status: row.status,
      })
    ));
    return contentRevisionListSchema.parse({
      current_revision: input.currentRevision,
      items: [{
        revision_id: input.currentRevision,
        saved_at_iso: input.currentSavedAtIso,
        current: true,
        title: input.currentTitle,
        status: input.currentStatus,
      }, ...historical],
    });
  } catch (cause) {
    throw new StudioOperationalError(config.dataInvalidCode, {
      cause,
      metadata: metadata(input.kind, 'list_content_revisions'),
    });
  }
}

async function readRevision(input: {
  db: D1Database;
  kind: ContentKind;
  targetId: string;
  revisionId: string;
  currentRevision: string;
  currentSavedAtIso: string;
  currentTitle: string;
  currentStatus: 'draft' | 'published' | 'trash';
  currentSnapshot: ContentSnapshot;
}): Promise<PostRevisionDocument | PageRevisionDocument | null> {
  const config = CONFIG[input.kind];
  if (input.revisionId === input.currentRevision) {
    const snapshotJson = JSON.stringify(input.currentSnapshot);
    const document = {
      revision_id: input.currentRevision,
      saved_at_iso: input.currentSavedAtIso,
      current: true,
      title: input.currentTitle,
      status: input.currentStatus,
      snapshot: input.currentSnapshot,
      snapshot_sha256: await snapshotDigest(snapshotJson),
    };
    return config.documentSchema.parse(document) as
      PostRevisionDocument | PageRevisionDocument;
  }
  let row: RevisionRow | null;
  try {
    row = await input.db.prepare(`
      SELECT revision_id, snapshot_version, snapshot_json, snapshot_sha256,
             saved_at_iso
      FROM ${config.table}
      WHERE ${config.targetColumn} = ? AND revision_id = ?
      LIMIT 1
    `).bind(input.targetId, input.revisionId).first<RevisionRow>();
  } catch (cause) {
    throw new StudioOperationalError(config.queryFailureCode, {
      cause,
      metadata: metadata(input.kind, 'read_content_revision'),
    });
  }
  if (!row) return null;
  try {
    if (typeof row.snapshot_json !== 'string') {
      throw new TypeError('Stored revision JSON is invalid.');
    }
    const snapshot = config.snapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (
      (row.snapshot_version !== 1 && row.snapshot_version !== 2)
      || (snapshot as { version?: unknown }).version !== row.snapshot_version
      || await snapshotDigest(row.snapshot_json) !== row.snapshot_sha256
    ) throw new TypeError('Stored revision integrity metadata does not match.');
    return config.documentSchema.parse({
      revision_id: row.revision_id,
      saved_at_iso: row.saved_at_iso,
      current: false,
      title: snapshot.draft.title,
      status: snapshot.draft.status,
      snapshot,
      snapshot_sha256: row.snapshot_sha256,
    }) as PostRevisionDocument | PageRevisionDocument;
  } catch (cause) {
    throw new StudioOperationalError(config.dataInvalidCode, {
      cause,
      metadata: metadata(input.kind, 'read_content_revision'),
    });
  }
}

export function listPostRevisions(input: { db: D1Database; post: Post }) {
  return listRevisions({
    db: input.db,
    kind: 'post',
    targetId: input.post.id,
    currentRevision: input.post.revision,
    currentSavedAtIso: input.post.updated_at_iso,
    currentTitle: input.post.title,
    currentStatus: input.post.status,
  });
}

export function listPageRevisions(input: { db: D1Database; page: Page }) {
  return listRevisions({
    db: input.db,
    kind: 'page',
    targetId: input.page.id,
    currentRevision: input.page.revision,
    currentSavedAtIso: input.page.updated_at_iso,
    currentTitle: input.page.title,
    currentStatus: input.page.status,
  });
}

export async function readPostRevision(input: {
  db: D1Database; post: Post; revisionId: string;
}): Promise<PostRevisionDocument | null> {
  return await readRevision({
    db: input.db,
    kind: 'post',
    targetId: input.post.id,
    revisionId: input.revisionId,
    currentRevision: input.post.revision,
    currentSavedAtIso: input.post.updated_at_iso,
    currentTitle: input.post.title,
    currentStatus: input.post.status,
    currentSnapshot: postSnapshotFromCanonical(input.post),
  }) as PostRevisionDocument | null;
}

export async function readPageRevision(input: {
  db: D1Database; page: Page; revisionId: string;
}): Promise<PageRevisionDocument | null> {
  return await readRevision({
    db: input.db,
    kind: 'page',
    targetId: input.page.id,
    revisionId: input.revisionId,
    currentRevision: input.page.revision,
    currentSavedAtIso: input.page.updated_at_iso,
    currentTitle: input.page.title,
    currentStatus: input.page.status,
    currentSnapshot: pageSnapshotFromCanonical(input.page),
  }) as PageRevisionDocument | null;
}
