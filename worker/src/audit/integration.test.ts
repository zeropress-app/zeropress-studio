import { createWxrCoreImportRoutes } from '../imports/wxr-core-import-routes';
import { createPublishingRoutes } from '../publishing/routes';
import { DOCUMENT, TOKEN, syntheticGithub, previewDocument, forbidPublishingNetwork } from '../publishing/test-support';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describe, expect, it, vi } from 'vitest';
import { createAuthDatabase } from '../test-helpers/auth-database';
import { auditMiddleware, auditSettings, recordAudit, setAuditActor } from './service';
import { finishAuthentication } from '../auth/auth-route-utils';
import { createAuthRoutes } from '../auth/routes';
import { pruneAuditLogs } from './repository';
import { parseAuditMetadata } from '../../../contracts/audit-logs';
import type { ResolvedSession } from '../auth/session-repository';
import type { StudioHonoEnvironment } from '../types';
import { applyDatabaseRestoreChunk, exportDatabaseBackup, finalizeDatabaseRestore, startDatabaseRestore } from '../operations/database-backup';
import { createDatabaseRestoreChunks, createDatabaseRestorePlan, inspectDatabaseBackupArtifact } from '../../../contracts/database-backup';
forbidPublishingNetwork();

const actor = { kind: 'user' as const, id: 'a'.repeat(32), name: 'Audit owner', email: 'audit@example.test' };
const secret = 'synthetic-auth-secret-'.repeat(4);
const session = { user: { id: actor.id, name: actor.name, email: actor.email, roles: ['admin'] },
  csrfToken: 'c'.repeat(43), session: { id: 'b'.repeat(32) } } as ResolvedSession;
function setup() {
  const { db, sqlite } = createAuthDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, password_hash, name, created_at_iso, updated_at_iso)
    VALUES (?, ?, 'hash', ?, '2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z')`).run(actor.id, actor.email, actor.name);
  const app = new Hono<StudioHonoEnvironment>(); app.use('*', auditMiddleware);
  const env = { DB: db, STUDIO_AUTH_SECRET: secret } as StudioHonoEnvironment['Bindings'];
  return { db, sqlite, app, env };
}
describe('audit operation integration', () => {
  it('restricts metadata to the fields allowed for each operation', () => {
    expect(parseAuditMetadata('settings_update', {
      fields: ['provider'], credential: 'removed', token: 'secret-sentinel',
      body: '<p>private content</p>', commit_sha: 'a'.repeat(40),
    })).toEqual({ fields: ['provider'], credential: 'removed' });
    expect(parseAuditMetadata('auth_login', { method: 'passkey', fields: ['provider'] }))
      .toEqual({ method: 'passkey' });
  });
  it.each(['totp', 'passkey'] as const)('records %s sign-in only after a session is actually issued', async (method) => {
    const { app, db, env } = setup();
    const issueSession = vi.fn().mockResolvedValueOnce({ kind: 'account_changed' }).mockResolvedValueOnce({
      kind: 'issued', value: { cookieValue: 'test-session-cookie', csrfToken: 'test' },
    });
    app.post('/sign-in', (c) => finishAuthentication({ c, issueSession, userId: actor.id, authRevision: 'd'.repeat(32), method }));
    expect((await app.request('/sign-in', { method: 'POST' }, env)).status).toBe(401);
    expect(await db.prepare('SELECT count(*) AS n FROM audit_logs').first()).toEqual({ n: 0 });
    expect((await app.request('/sign-in', { method: 'POST' }, env)).status).toBe(200);
    expect(await db.prepare('SELECT actor_name, actor_email, metadata_json FROM audit_logs').first()).toEqual({
      actor_name: actor.name, actor_email: actor.email, metadata_json: JSON.stringify({ method }),
    });
  });
  it('captures request.cf before body parsing reconstructs the request, and drops values outside the metadata allowlist', async () => {
    const { app, db, env } = setup();
    app.post('/settings', bodyLimit({ maxSize: 1024 }), async (c) => {
      await c.req.json(); setAuditActor(c, actor); auditSettings(c, 'mail', ['provider'], 'replaced');
      return c.json({ success: true });
    });
    const request = new Request('https://studio.test/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.4' }, body: JSON.stringify({ token: 'secret-sentinel' }) });
    Object.defineProperty(request, 'cf', { value: { country: 'KR', city: 'Synthetic city', asn: 64500 } });
    expect((await app.fetch(request, env)).status).toBe(200);
    const row = await db.prepare('SELECT country, city, asn, metadata_json FROM audit_logs').first();
    expect(row).toEqual({ country: 'KR', city: 'Synthetic city', asn: 64500, metadata_json: '{"fields":["provider"],"credential":"replaced"}' });
  });
  it('does not record rejected CSRF or anonymous logout and snapshots an explicit authenticated logout', async () => {
    const { app, env, db } = setup(); const revokeSession = vi.fn().mockResolvedValue(true);
    let authenticated = false;
    app.route('/auth', createAuthRoutes({ resolveSession: async () => authenticated ? session : null, revokeSession }));
    const request = (csrf: boolean) => new Request('https://studio.test/auth/logout', { method: 'POST',
      headers: { Origin: 'https://studio.test', 'Content-Type': 'application/json', ...(csrf ? { 'X-ZeroPress-CSRF': session.csrfToken } : {}) }, body: '{}' });
    expect((await app.fetch(request(false), env)).status).toBe(200);
    authenticated = true; expect((await app.fetch(request(false), env)).status).toBe(403);
    expect(await db.prepare('SELECT count(*) AS n FROM audit_logs').first()).toEqual({ n: 0 });
    expect((await app.fetch(request(true), env)).status).toBe(200);
    expect(await db.prepare('SELECT action, actor_name FROM audit_logs').first()).toEqual({ action: 'auth_logout', actor_name: actor.name });
  });
  it('includes audit rows in backups and restores the history to the backed-up state', async () => {
    const { app, db, env, sqlite } = setup();
    sqlite.exec("INSERT INTO content_search_index_state (id, state, updated_at_iso) VALUES (1, 'ready', '2026-09-22T12:00:00.000Z')");
    app.post('/change', (c) => { setAuditActor(c, actor); recordAudit(c, { action: 'account_password' }); return c.json({ success: true }); });
    app.post('/restored', (c) => {
      setAuditActor(c, actor);
      recordAudit(c, { action: 'operations_restore', metadata: { operation_id: started.restoreId, stage: 'completed' } });
      return c.json({ success: true });
    });
    await app.request('/change', { method: 'POST' }, env);
    const backup = await exportDatabaseBackup({ db, database: 'studio', mode: 'structure_and_data' });
    expect(backup.manifest.tables).toContainEqual({ name: 'audit_logs', row_count: 1 });
    await app.request('/change', { method: 'POST' }, env);
    const plan = await createDatabaseRestorePlan(await inspectDatabaseBackupArtifact(backup.sql));
    const started = await startDatabaseRestore({ db, database: 'studio', request: {
      database: 'studio', manifest: plan.manifest, manifest_sha256: plan.footer.manifest_sha256,
      artifact_digest: plan.artifactDigest, artifact_statement_count: plan.footer.statement_count,
      expected_chunk_count: plan.chunkCount, table_statements: plan.tableStatements, secondary_statements: plan.secondaryStatements,
      confirmation: 'RESTORE DATABASE',
    } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Background audit writes and cleanup must not alter restore row counts.
      await app.request('/change', { method: 'POST' }, env);
      for (const chunk of createDatabaseRestoreChunks(plan)) {
        await applyDatabaseRestoreChunk({ db, database: 'studio', request: {
          database: 'studio', restore_id: started.restoreId, artifact_digest: plan.artifactDigest,
          chunk_index: chunk.chunkIndex, table: chunk.table, columns: chunk.columns, rows: chunk.rows,
        } });
        if (chunk.table === 'audit_logs') {
          await app.request('/change', { method: 'POST' }, env);
          await pruneAuditLogs(db, new Date('2030-01-01T00:00:00.000Z'));
        }
      }
    } finally {
      warn.mockRestore();
    }
    await finalizeDatabaseRestore({ db, database: 'studio', request: {
      database: 'studio', restore_id: started.restoreId, artifact_digest: plan.artifactDigest,
      expected_chunk_count: plan.chunkCount, secondary_statements: plan.secondaryStatements,
    } });
    expect(await db.prepare('SELECT count(*) AS n FROM audit_logs').first()).toEqual({ n: 1 });
    await app.request('/restored', { method: 'POST' }, env);
    expect(await db.prepare('SELECT action FROM audit_logs WHERE action = ?').bind('operations_restore').first())
      .toEqual({ action: 'operations_restore' });
  });
});


describe('audit import and publishing results', () => {
  const mutation = (path: string, body: unknown) => new Request(`https://studio.test${path}`, {
    method: 'POST',
    headers: { Origin: 'https://studio.test', 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': session.csrfToken },
    body: JSON.stringify(body),
  });

  it.each([
    { created: 1, unchanged: 0, failed: 1, outcome: 'partial' },
    { created: 0, unchanged: 0, failed: 2, outcome: 'failed' },
    { created: 0, unchanged: 2, failed: 0, outcome: 'unchanged' },
  ])('records one WXR chunk summary: $outcome', async ({ created, unchanged, failed, outcome }) => {
    const { app, db, env } = setup();
    app.route('/imports', createWxrCoreImportRoutes({
      resolveSession: async () => session,
      importChunk: vi.fn().mockResolvedValue({ summary: {
        phase: 'menus', processed: 2, created, updated: 0, unchanged, failed,
        failures: Array.from({ length: failed }, (_, row_index) => ({ row_index, key: 'private-menu-key', code: 'REVISION_CONFLICT' })),
      } }),
    }));
    const response = await app.fetch(mutation('/imports/core/chunk', {
      phase: 'menus', rows: [
        { menu_id: 'primary', name: 'Private menu label', items: [] },
        { menu_id: 'footer', name: 'Footer', items: [] },
      ],
    }), env);
    expect(response.status).toBe(200);
    const result = await db.prepare('SELECT action, outcome, metadata_json FROM audit_logs').all();
    expect(result.results).toEqual([{
      action: 'import_chunk', outcome,
      metadata_json: JSON.stringify({ phase: 'menus', requested: 2, failed, skipped: unchanged, created, updated: 0 }),
    }]);
  });

  it.each([
    { options: {}, outcomes: ['success', 'unchanged'], status: 200 },
    { options: { loseWithoutWrite: true }, outcomes: ['unknown'], status: 503 },
    { options: { putStatus: 403 }, outcomes: ['failed'], status: 403 },
  ])('records the confirmed GitHub result: $outcomes', async ({ options, outcomes, status }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, db, env } = setup();
    const github = syntheticGithub(options);
    app.route('/publishing', createPublishingRoutes({
      resolveSession: async () => session,
      readRuntimeSettings: async () => ({ document: DOCUMENT, token: TOKEN }),
      prepareExport: async () => previewDocument(),
      fetch: github.fetch,
    }));
    for (const _outcome of outcomes) {
      const response = await app.fetch(mutation('/publishing', { expected_revision: DOCUMENT.revision }), env);
      expect(response.status).toBe(status);
    }
    const result = await db.prepare('SELECT outcome, metadata_json FROM audit_logs ORDER BY rowid').all<{ outcome: string; metadata_json: string }>();
    expect(result.results.map((record) => record.outcome)).toEqual(outcomes);
    expect(JSON.stringify(result.results)).not.toContain(TOKEN);
    if (status === 200) expect(JSON.parse(result.results[0].metadata_json)).toEqual({ commit_sha: github.state.lastCommit });
  });
});
