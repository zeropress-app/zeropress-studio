import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATABASE_UPGRADE_CONFIRMATION } from '../../../contracts/database-upgrade';
import { normalizePageContentSnapshot } from '../../../contracts/page-autosaves';
import { normalizePostContentSnapshot } from '../../../contracts/post-autosaves';
import { readPostAutosave, readPageAutosave } from '../content-autosaves/repository';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { STUDIO_SCHEMA_UPGRADE_ARTIFACTS } from './schema-upgrade-artifacts';
import { applyNextStudioSchemaUpgrade, startStudioSchemaUpgrade } from './schema-upgrade-runner';

const now = '2026-09-25T00:00:00.000Z';
const userId = '1'.repeat(32);
const postId = '2'.repeat(32);
const parentId = '3'.repeat(32);
const pageId = '4'.repeat(32);
const draftId = '5'.repeat(32);
const revision = '6'.repeat(32);
const category = '7'.repeat(32);
const tag = '8'.repeat(32);
const html = '<p class="original">Saved <strong>HTML</strong>\n  spacing</p>';

function oldDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../audit/fixtures/schema-1.sql', import.meta.url), 'utf8'));
  sqlite.exec(STUDIO_SCHEMA_UPGRADE_ARTIFACTS[0].sql);
  sqlite.prepare("INSERT INTO zeropress_schema_state (id,schema_version,lifecycle_state,updated_at_iso) VALUES (1,2,'ready',?)").run(now);
  sqlite.prepare("INSERT INTO users (id,email,password_hash,name,created_at_iso,updated_at_iso) VALUES (?,'owner@example.test','synthetic','Owner',?,?)").run(userId, now, now);
  sqlite.prepare("INSERT INTO authors (id,user_id,display_name,created_at_iso,updated_at_iso) VALUES ('owner',?,'Owner',?,?)").run(userId, now, now);
  sqlite.prepare(`INSERT INTO posts (id,public_id,title,slug,content,document_type,status,author_id,revision,created_at_iso,updated_at_iso,editor_mode,editor_profile)
    VALUES (?,10,'Post','post',?,'html','draft','owner',?, ?,?,'visual','tiptap-v1')`).run(postId, html, revision, now, now);
  for (const [id, parent, publicId, slug] of [[parentId, null, 10, 'parent'], [pageId, parentId, 11, 'child']] as const) {
    sqlite.prepare(`INSERT INTO pages (id,public_id,parent_id,title,slug,content,document_type,status,revision,created_at_iso,updated_at_iso,editor_mode,editor_profile)
      VALUES (?,?,?,'Page',?,?,'html','draft',?,?,?,'visual','tiptap-v1')`).run(id, publicId, parent, slug, html, revision, now, now);
  }
  sqlite.prepare("INSERT INTO categories (id,name,slug,created_at_iso,updated_at_iso) VALUES (?,'Category','category',?,?)").run(category, now, now);
  sqlite.prepare("INSERT INTO tags (id,name,slug,created_at_iso,updated_at_iso) VALUES (?,'Tag','tag',?,?)").run(tag, now, now);
  sqlite.prepare('INSERT INTO post_categories VALUES (?,?)').run(postId, category);
  sqlite.prepare('INSERT INTO post_tags VALUES (?,?,0)').run(postId, tag);
  const snapshot = JSON.stringify({ version: 2, content_type: 'post', draft: {
    title: 'Draft', slug: '', content: html, document_type: 'html', editor_mode: 'visual', editor_profile: 'tiptap-v1',
    excerpt: '', status: 'draft', author_id: 'owner', category_ids: [], tag_ids: [], discoverability: 'default',
    allow_comments: true, featured_image_id: null,
  }, references: { author: { id: 'owner', display_name: 'Owner' }, categories: [], tags: [], featured_image: null } });
  const pageSnapshot = JSON.stringify({ version: 2, content_type: 'page', draft: {
    parent_id: null, title: 'Page draft', slug: '', content: html, document_type: 'html',
    editor_mode: 'visual', editor_profile: 'tiptap-v1', excerpt: '', status: 'draft',
    discoverability: 'default', allow_comments: true, featured_image_id: null,
  }, references: { parent: null, featured_image: null } });
  const snapshots = { post: snapshot, page: pageSnapshot };
  const digests = Object.fromEntries(Object.entries(snapshots).map(([key, json]) =>
    [key, createHash('sha256').update(json).digest('hex')]));
  for (const [kind, id] of [['post', postId], ['page', pageId]] as const) {
    const snapshot = snapshots[kind];
    const digest = digests[kind];
    sqlite.prepare(`INSERT INTO ${kind}_autosaves (user_id,draft_id,${kind}_id,base_revision,snapshot_version,snapshot_json,snapshot_sha256,created_at_iso,updated_at_iso)
      VALUES (?,?,?,?,2,?,?,?,?)`).run(userId, draftId, id, revision, snapshot, digest, now, now);
    sqlite.prepare(`INSERT INTO ${kind}_revisions VALUES (?,?,2,?,?,?,?)`).run(id, revision, snapshot, digest, now, now);
  }
  return { sqlite, snapshot, snapshots, digests };
}

async function upgrade(db: D1Database) {
  const started = await startStudioSchemaUpgrade({ db, initiator: { userId, userEmail: 'owner@example.test' },
    request: { administrator_email: 'owner@example.test', administrator_password: 'synthetic-password',
      backup_acknowledged: true, confirmation: DATABASE_UPGRADE_CONFIRMATION } });
  return applyNextStudioSchemaUpgrade({ db, request: { operation_id: started.operation_id,
    step_id: started.next_step.id, confirmation: DATABASE_UPGRADE_CONFIRMATION } });
}

describe('visual editor schema transition', () => {
  it('preserves authored bytes, page hierarchy, relations, and snapshot integrity', async () => {
    const { sqlite, snapshots, digests } = oldDatabase();
    try {
      const db = sqliteD1(sqlite);
      expect(await upgrade(db)).toMatchObject({ status: 'completed', current_schema_version: 3 });
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const table of ['posts', 'pages']) {
        for (const row of sqlite.prepare(`SELECT content,editor_mode,editor_profile FROM ${table}`).all()) {
          expect(row).toEqual({ content: html, editor_mode: 'source', editor_profile: null });
        }
      }
      expect(sqlite.prepare('SELECT parent_id FROM pages WHERE id=?').get(pageId)).toEqual({ parent_id: parentId });
      expect(sqlite.prepare('SELECT * FROM post_categories').all()).toEqual([{ post_id: postId, category_id: category }]);
      expect(sqlite.prepare('SELECT * FROM post_tags').all()).toEqual([{ post_id: postId, tag_id: tag, sort_order: 0 }]);
      for (const table of ['post_autosaves', 'page_autosaves', 'post_revisions', 'page_revisions']) {
        const kind = table.startsWith('post') ? 'post' : 'page';
        expect(sqlite.prepare(`SELECT snapshot_version,snapshot_json,snapshot_sha256 FROM ${table}`).get())
          .toEqual({ snapshot_version: 2, snapshot_json: snapshots[kind], snapshot_sha256: digests[kind] });
      }
      const saved = await readPostAutosave({ db, userId, locator: { draftId } });
      expect(saved?.snapshot.version).toBe(2);
      expect(normalizePostContentSnapshot(saved!.snapshot)).toMatchObject({ version: 3,
        draft: { content: html, editor_mode: 'source', editor_profile: null } });
      const pageSaved = await readPageAutosave({ db, userId, locator: { draftId } });
      expect(normalizePageContentSnapshot(pageSaved!.snapshot)).toMatchObject({ version: 3,
        draft: { content: html, editor_mode: 'source', editor_profile: null } });
      sqlite.prepare("UPDATE posts SET editor_mode='visual',editor_profile='suneditor-v1' WHERE id=?").run(postId);
      sqlite.prepare('UPDATE post_autosaves SET snapshot_version=3').run();
      // The rebuilt foreign keys must still cascade to the final table names.
      sqlite.prepare('DELETE FROM posts WHERE id=?').run(postId);
      expect(sqlite.prepare('SELECT count(*) AS n FROM post_revisions').get()).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM post_autosaves').get()).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('rolls back the complete table transition if copying a dependent table fails', async () => {
    const { sqlite, snapshot } = oldDatabase();
    try {
      const db = sqliteD1(sqlite, { failSqlOnce: 'INSERT INTO page_revisions_new' });
      await expect(upgrade(db)).rejects.toThrow();
      expect(sqlite.prepare('SELECT content,editor_profile FROM posts').get()).toEqual({ content: html, editor_profile: 'tiptap-v1' });
      expect(sqlite.prepare('SELECT snapshot_json FROM post_revisions').get()).toEqual({ snapshot_json: snapshot });
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
