import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { contentSearchIndexRebuildMutationSuccessSchema, type ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import type { ResolvedSession } from '../auth/session-repository';
import { createContentSearchIndexRoutes } from '../content-search/routes';
import { ContentSearchRebuildError } from '../content-search/rebuild';
import { createOperationsRoutes } from '../operations/routes';
import { createAuthDatabase } from '../test-helpers/auth-database';
import type { StudioHonoEnvironment } from '../types';
import { auditMiddleware } from './service';
import { listAuditLogs, readAuditLogEvents } from './repository';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('groups one rebuild while preserving its progress and rejecting replayed steps', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  const { db, sqlite } = createAuthDatabase();
  let clock = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date(clock).toISOString();
  sqlite.prepare("INSERT INTO content_search_index_state (id, state, reason, updated_at_iso) VALUES (1, 'rebuild_required', 'manual_rebuild', ?)").run(now);
  sqlite.prepare("INSERT INTO authors (id, display_name, revision, created_at_iso, updated_at_iso) VALUES ('author', 'Synthetic author', ?, ?, ?)").run('a'.repeat(32), now, now);
  for (let id = 1; id <= 6; id++) {
    sqlite.prepare(`INSERT INTO posts (id, public_id, title, slug, content, document_type, excerpt, status, author_id, revision, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, '<p>Synthetic content</p>', 'html', '', 'draft', 'author', ?, ?, ?)`)
      .run(id.toString(16).padStart(32, '0'), id, `Post ${id}`, `post-${id}`, 'b'.repeat(32), now, now);
  }
  sqlite.prepare(`INSERT INTO pages (id, public_id, title, slug, content, document_type, excerpt, status, revision, created_at_iso, updated_at_iso)
    VALUES (?, 1, 'Synthetic page', 'synthetic-page', '<p>Synthetic content</p>', 'html', '', 'draft', ?, ?, ?)`)
    .run('e'.repeat(32), 'f'.repeat(32), now, now);
  const csrf = 'c'.repeat(43);
  const session = { user: { id: 'a'.repeat(32), name: 'Synthetic administrator', email: 'admin@example.test', roles: ['admin'] }, session: { id: 'b'.repeat(32) }, csrfToken: csrf, authRevision: 'c'.repeat(32) } as ResolvedSession;
  const app = new Hono<StudioHonoEnvironment>();
  app.use('*', auditMiddleware);
  app.route('/', createContentSearchIndexRoutes({ resolveSession: async () => session,
    restoreInProgress: async () => false, reconciliationInProgress: async () => false,
  }));
  const env = { DB: db, STUDIO_AUTH_SECRET: 'synthetic-test-secret-'.repeat(4) } as StudioHonoEnvironment['Bindings'];
  const post = (path: string, body: unknown) => {
    vi.setSystemTime(clock += 1000);
    return app.fetch(new Request(`https://studio.test${path}`, {
    method: 'POST', headers: { Origin: 'https://studio.test', 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': csrf }, body: JSON.stringify(body),
  }), env);
  };
  const first = await post('/rebuild/start', {});
  expect(first.status).toBe(200);
  let status: ContentSearchIndexStatus = contentSearchIndexRebuildMutationSuccessSchema.parse(await first.json()).data.content_search_index;
  expect((await post('/rebuild/start', {})).status).toBe(409);
  let steps = 0;
  while (status.state === 'in_progress') {
    const request = { operation_id: status.operation_id, expected_phase: status.phase,
      expected_post_public_id_cursor: status.post_public_id_cursor, expected_page_public_id_cursor: status.page_public_id_cursor };
    const response = await post('/rebuild/step', request);
    expect(response.status).toBe(200);
    status = contentSearchIndexRebuildMutationSuccessSchema.parse(await response.json()).data.content_search_index;
    steps++;
    expect((await post('/rebuild/step', request)).status).toBe(409);
  }
  const rows = sqlite.prepare('SELECT id, action, category, outcome, target_type, target_id, target_label, metadata_json FROM audit_logs ORDER BY rowid').all();
  const metadata = rows.map(row => JSON.parse(String(row.metadata_json)));
  expect(status).toMatchObject({ state: 'ready', processed_posts: 6, processed_pages: 1 });
  expect(steps).toBe(4);
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map(row => row.id)).size).toBe(5);
  expect(new Set(metadata.map(row => row.operation_id)).size).toBe(1);
  expect(metadata.map(row => row.stage)).toEqual(['started', 'step', 'step', 'step', 'completed']);
  expect(metadata.map(row => row.processed_posts)).toEqual([0, 5, 6, 6, 6]);
  expect(metadata.map(row => row.search_phase)).toEqual(['posts', 'posts', 'posts', 'pages', 'verify']);
  expect(metadata.at(-1)).toMatchObject({ total_posts: 6, total_pages: 1, processed_pages: 1 });
  const list = await listAuditLogs(db, {});
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({ event_count: 5, target: { type: 'database', id: 'studio' }, metadata: { stage: 'completed' } });
  expect((await readAuditLogEvents(db, list.items[0].id))?.items).toHaveLength(5);
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM post_search_fts').get()).toEqual({ count: 6 });
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM page_search_fts').get()).toEqual({ count: 1 });
});

it('records a failed Operations verification with its caller and original initiator', async () => {
  const { db } = createAuthDatabase();
  const initiator = { userId: 'a'.repeat(32), userEmail: 'original@example.test' };
  const app = new Hono<StudioHonoEnvironment>();
  app.use('*', auditMiddleware);
  app.route('/', createOperationsRoutes({
    readContentSearchRebuildInitiator: async () => initiator,
    applyContentSearchIndexRebuildStep: async () => { throw new ContentSearchRebuildError('integrity_failed', 'Synthetic mismatch'); },
  }));
  const token = 'synthetic-operations-token-'.repeat(3);
  const response = await app.fetch(new Request('https://studio.test/content-search-index/rebuild/step', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation_id: 'b'.repeat(32), expected_phase: 'verify', expected_post_public_id_cursor: 6, expected_page_public_id_cursor: 1 }),
  }), { DB: db, STUDIO_SITE_MODE: 'maintenance', STUDIO_AUTH_SECRET: 'synthetic-secret-'.repeat(4),
    STUDIO_OPERATIONS_ALLOWED_IPS: '192.0.2.1', STUDIO_OPERATIONS_TOKEN: token } as StudioHonoEnvironment['Bindings']);
  expect(response.status).toBe(409);
  const list = await listAuditLogs(db, {});
  expect(list.items).toMatchObject([{
    outcome: 'failed', actor: { kind: 'operations' },
    metadata: { operation_id: 'b'.repeat(32), stage: 'step', search_phase: 'verify',
      initiator: { id: initiator.userId, email: initiator.userEmail }, error_code: 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE' },
  }]);
});
