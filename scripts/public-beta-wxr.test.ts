// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePreviewData } from '@zeropress/preview-data-validator';
import { parseWxrCoreImportFile } from '../client/src/wxr/wxr-core-parser';
import type { WxrCoreImportChunkRequest } from '../contracts/wxr-import';
import { importWxrCoreChunk } from '../worker/src/imports/wxr-core-import-repository';
import { importWxrCommentChunk } from '../worker/src/imports/wxr-comment-import-repository';
import { drainCommentTargetProjectionOutbox } from '../worker/src/comments/target-projection-outbox';
import { generatePreviewDataExport } from '../worker/src/preview-data/projection';
import { sqliteD1 } from '../worker/src/test-helpers/sqlite-d1';
import type { Env } from '../worker/src/types';
import { incompatibleHtml, publicBetaWxr } from './fixtures/public-beta-wxr';

function sourceFile() {
  const bytes = new TextEncoder().encode(publicBetaWxr);
  return {
    name: 'public-beta.xml', size: bytes.length,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Cross tag, CDATA and Korean/emoji UTF-8 boundaries.
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      });
    },
  } as File;
}

function rows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}

describe('public beta representative WXR to Preview Data', () => {
  it.each(['external', 'r2'] as const)('imports %s media twice without duplicate or revision drift', async (mediaStrategy) => {
    const studio = new DatabaseSync(':memory:');
    const edge = new DatabaseSync(':memory:');
    try {
      studio.exec('PRAGMA foreign_keys = ON');
      edge.exec('PRAGMA foreign_keys = ON');
      studio.exec(readFileSync(resolve('database/install/001_baseline.sql'), 'utf8'));
      edge.exec(readFileSync(resolve('database/edge/install/001_edge_baseline.sql'), 'utf8'));
      edge.exec(readFileSync(resolve('database/edge/install/002_edge_seed.sql'), 'utf8'));
      studio.exec(`
        INSERT INTO studio_settings (key, value, type, updated_at_iso)
          VALUES ('edge_integration_mode', 'enabled', 'string', '2026-09-04T00:00:00Z'),
            ('private_fixture_credential', 'PRIVATE_PROVIDER_CREDENTIAL', 'string', '2026-09-04T00:00:00Z');
        INSERT INTO site_settings (key, value, type, updated_at_iso)
          VALUES ('site_media_origin', 'https://media.example.test', 'string', '2026-09-04T00:00:00Z'),
            ('site_media_delivery_mode', 'none', 'string', '2026-09-04T00:00:00Z'),
            ('site_media_revision', '${'c'.repeat(32)}', 'string', '2026-09-04T00:00:00Z');
        INSERT INTO users (id, email, password_hash, name, created_at_iso, updated_at_iso)
          VALUES ('${'a'.repeat(32)}', 'private-user@example.test', 'PRIVATE_PASSWORD_HASH',
            'PRIVATE_USER_NAME', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
        INSERT INTO user_mfa_factors (id, user_id, factor_type, secret_ciphertext, secret_iv, created_at_iso, verified_at_iso)
          VALUES ('${'b'.repeat(32)}', '${'a'.repeat(32)}', 'totp', 'PRIVATE_MFA_CIPHERTEXT',
            'PRIVATE_MFA_NONCE', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
        INSERT INTO sessions (id, user_id, secret_digest, auth_revision, ip_address,
          created_at_iso, last_seen_at_iso, idle_expires_at_iso, absolute_expires_at_iso, mfa_verified_at_iso)
          VALUES ('${'d'.repeat(32)}', '${'a'.repeat(32)}', '${'e'.repeat(64)}', '${'f'.repeat(32)}',
            '192.0.2.99', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z',
            '2026-09-04T01:00:00Z', '2026-09-04T02:00:00Z', '2026-09-04T00:00:00Z');
      `);
      edge.exec(`
        INSERT INTO forms (id, slug, title) VALUES ('private-form', 'private-form', 'Private form');
        INSERT INTO form_submissions (id, form_id, summary, submitted_at)
          VALUES ('private-submission', 'private-form', 'PRIVATE_MAIL_BODY', '2026-09-04T00:00:00Z');
      `);
      const db = sqliteD1(studio);
      const edgeDb = sqliteD1(edge);
      const options = { mediaStrategy, mediaFrom: 'https://fixture.example.test/uploads/' };
      const plan = await parseWxrCoreImportFile(sourceFile(), options);
      expect(plan.rows.posts.map(({ editor_mode }) => editor_mode)).toEqual(['visual', 'source']);
      expect(plan.rows.posts[1]?.content).toBe(incompatibleHtml);
      expect(plan.rows.pages.map(({ public_id }) => public_id)).toEqual([21, 22]);
      expect(plan.rows.media).toHaveLength(1);
      expect(plan.rows.menus).toHaveLength(1);
      expect(plan.rows.comments).toHaveLength(1);

      const importPlan = async (repeat: boolean) => {
        for (const phase of ['authors', 'categories', 'tags', 'media', 'posts', 'pages', 'menus'] as const) {
          const result = await importWxrCoreChunk({
            db, request: { phase, rows: plan.rows[phase] } as WxrCoreImportChunkRequest,
          });
          expect(result.summary.failures).toEqual([]);
          expect(result.summary.failed).toBe(0);
          if (repeat) {
            expect(result.summary.created).toBe(0);
            expect(result.summary.updated).toBe(0);
            expect(result.summary.unchanged).toBe(plan.rows[phase].length);
          }
        }
        const drained = await drainCommentTargetProjectionOutbox({
          env: { DB: db, EDGE_DB: edgeDb } as Env, limit: 25,
        });
        expect(drained.remainingEvents).toBe(0);
        if (repeat) expect(drained.processedEvents).toBe(0);
        const comments = await importWxrCommentChunk({
          edgeDb, request: { phase: 'comments', rows: plan.rows.comments },
        });
        expect(comments.summary.failures).toEqual([]);
        expect(comments.summary[repeat ? 'unchanged' : 'created']).toBe(1);
      };
      await importPlan(false);
      const tables = ['authors', 'categories', 'tags', 'media', 'posts', 'pages', 'menus', 'post_categories', 'post_tags'];
      const before = tables.map((table) => rows(studio, table));
      const targetsBefore = rows(edge, 'edge_comment_targets');
      const commentsBefore = rows(edge, 'comments');
      const reparsed = await parseWxrCoreImportFile(sourceFile(), options);
      expect(reparsed).toEqual(plan);
      await importPlan(true);
      expect(tables.map((table) => rows(studio, table))).toEqual(before);
      expect(rows(edge, 'edge_comment_targets')).toEqual(targetsBefore);
      expect(rows(edge, 'comments')).toEqual(commentsBefore);
      expect(studio.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(edge.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const output = await generatePreviewDataExport({ db, edgeDb });
      expect(validatePreviewData(output.preview_data).ok).toBe(true);
      expect(output.preview_data.content.posts).toHaveLength(2);
      expect(output.preview_data.content.pages).toHaveLength(2);
      const json = JSON.stringify(output);
      for (const privateValue of [
        'PRIVATE_PASSWORD_HASH', 'PRIVATE_USER_NAME', 'private-user@example.test',
        'PRIVATE_MFA_CIPHERTEXT', 'PRIVATE_MFA_NONCE', 'PRIVATE_COMMENT_BODY',
        'PRIVATE_COMMENT_AUTHOR', 'private-comment@example.test',
        'PRIVATE_PROVIDER_CREDENTIAL', 'PRIVATE_MAIL_BODY', '192.0.2.99', 'e'.repeat(64),
      ]) expect(json).not.toContain(privateValue);
    } finally {
      studio.close();
      edge.close();
    }
  });
});
