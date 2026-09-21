import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { startStudioSchemaUpgrade, applyNextStudioSchemaUpgrade } from '../system/schema-upgrade-runner';
import { DATABASE_UPGRADE_CONFIRMATION } from '../../../contracts/database-upgrade';
import { URL as NodeURL } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { type AuditLogDetail } from '../../../contracts/audit-logs';
import { createAuthDatabase } from '../test-helpers/auth-database';
import { captureAuditNetwork, hashAuditIp } from './network';
import { insertAuditLog, listAuditLogs, readAuditLog, pruneAuditLogs, InvalidAuditCursor } from './repository';
import { auditMiddleware, recordAudit, beginAudit, setAuditActor, auditBulk, auditContentChange } from './service';
import { logAuditedOperation } from './operations';
import { createAuditRoutes } from './routes';
import type { StudioHonoEnvironment } from '../types';
import type { ResolvedSession } from '../auth/session-repository';
import { STUDIO_SCHEMA_UPGRADE_ARTIFACTS } from '../system/schema-upgrade-artifacts';
import { createSchemaUpgradeArtifactSha256 } from '../system/schema-upgrade-runner';
import { STUDIO_SCHEMA_VERSION, MIN_SUPPORTED_STUDIO_SCHEMA_VERSION } from '../system/schema-version';
const secret = 'audit-test-secret-'.repeat(4);
const actor = { kind: 'user' as const, id: 'a'.repeat(32), name: 'Former administrator', email: 'former@example.test' };
const now = new Date('2026-09-22T12:00:00.000Z');
function event(at = now.toISOString()): AuditLogDetail {
  return { id: crypto.randomUUID(), occurred_at: at, action: 'account_delete', category: 'account', outcome: 'success', actor,
    target: { type: 'user', id: 'b'.repeat(32), label: '<script>alert(1)</script>' }, metadata: {},
    network: { ...captureAuditNetwork(new Request('https://studio.test', { headers: { 'CF-Connecting-IP': '192.0.2.11' } }), new Date(at)), ip_hash: `v1.${'a'.repeat(64)}` } };
}
afterEach(() => vi.restoreAllMocks());
describe('audit storage and request privacy', () => {
  it('normalizes the trusted IP, reads only Cloudflare location metadata and bounds untrusted text', async () => {
    const request = new Request('https://studio.test', { headers: {
      'CF-Connecting-IP': '2001:0db8::1', 'X-Forwarded-For': '198.51.100.55', 'User-Agent': 'x'.repeat(1200),
    } });
    Object.defineProperty(request, 'cf', { value: { country: 'KR', region: 'Seoul', city: 'Seoul', timezone: 'Asia/Seoul', asn: 64500, asOrganization: 'Test network', latitude: 'secret-coordinate', postalCode: 'secret-postcode' } });
    const captured = captureAuditNetwork(request, now);
    expect(captured).toMatchObject({ ip_address: '2001:db8::1', country: 'KR', city: 'Seoul', asn: 64500, organization: 'Test network' });
    expect(captured.user_agent).toHaveLength(1024);
    expect(Object.keys(captured)).toEqual(['ip_address','ip_recorded_at','ip_hash','user_agent','country','region','city','timezone','asn','organization']);
    expect(captureAuditNetwork(new Request('https://studio.test', { headers: { 'X-Forwarded-For': '192.0.2.1' } })).ip_address).toBeNull();
    expect(await hashAuditIp(captured.ip_address!, secret)).toMatch(/^v1\.[a-f0-9]{64}$/);
    expect(await hashAuditIp(captured.ip_address!, secret)).toBe(await hashAuditIp('2001:db8::1', secret));
    expect(await hashAuditIp('2001:db8::1', secret + 'changed')).not.toBe(await hashAuditIp('2001:db8::1', secret));
    await expect(hashAuditIp('192.0.2.1', undefined)).rejects.toThrow();
  });
  it('applies raw IP and record retention at read time even before cron runs', async () => {
    const { db } = createAuthDatabase();
    const recent = event(new Date(now.getTime() - 30 * 86400000 + 1).toISOString());
    const redacted = event(new Date(now.getTime() - 30 * 86400000).toISOString());
    const expired = event(new Date(now.getTime() - 365 * 86400000).toISOString());
    for (const row of [recent, redacted, expired]) await insertAuditLog(db, row).run();
    expect((await readAuditLog(db, recent.id, now))?.network.ip_address).toBe('192.0.2.11');
    expect((await readAuditLog(db, redacted.id, now))?.network).toMatchObject({ ip_address: null, ip_recorded_at: null, ip_hash: redacted.network.ip_hash });
    expect(await readAuditLog(db, expired.id, now)).toBeNull();
    expect((await listAuditLogs(db, {}, now)).items).toHaveLength(2);
    await pruneAuditLogs(db, now);
    expect(await db.prepare('SELECT ip_address FROM audit_logs WHERE id = ?').bind(redacted.id).first()).toEqual({ ip_address: null });
    expect(await db.prepare('SELECT id FROM audit_logs WHERE id = ?').bind(expired.id).first()).toBeNull();
  });
  it('paginates equal timestamps without duplicates and searches stored actors after account deletion', async () => {
    const { db } = createAuthDatabase();
    await db.batch(Array.from({ length: 53 }, () => insertAuditLog(db, event())));
    const first = await listAuditLogs(db, { actor: 'former@', category: 'account' }, now);
    const second = await listAuditLogs(db, { actor: 'former@', category: 'account', cursor: first.next_cursor! }, now);
    expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((v) => v.id)).size).toBe(53);
    expect(second.next_cursor).toBeNull();
    await expect(listAuditLogs(db, { actor: 'different', cursor: first.next_cursor! }, now)).rejects.toBeInstanceOf(InvalidAuditCursor);
    expect((await listAuditLogs(db, { actor: '%' }, now)).items).toHaveLength(0);
    expect((await listAuditLogs(db, { ip_hash: `v1.${'a'.repeat(64)}`, outcome: 'success' }, now)).items).toHaveLength(50);
  });
  it('limits each cleanup batch to 500 records', async () => {
    const { db } = createAuthDatabase();
    await db.batch(Array.from({ length: 501 }, () => insertAuditLog(db, event('2024-01-01T00:00:00.000Z'))));
    await pruneAuditLogs(db, now);
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first()).toEqual({ count: 1 });
  });
});
function appWithAudit(db: D1Database, authSecret = secret) {
  const app = new Hono<StudioHonoEnvironment>();
  app.use('*', auditMiddleware);
  app.post('/operation', (c) => {
    setAuditActor(c, actor);
    recordAudit(c, { action: 'account_delete', target: { type: 'user', id: 'deleted-user' } });
    return c.json({ success: true });
  });
  return { app, env: { DB: db, STUDIO_AUTH_SECRET: authSecret } as StudioHonoEnvironment['Bindings'] };
}
describe('audit availability and semantic events', () => {
  it('registers background work and preserves an operation response when audit storage fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = { prepare: () => { throw new Error('SQL contains private input'); } } as unknown as D1Database;
    const { app, env } = appWithAudit(db);
    const promises: Promise<unknown>[] = [];
    const context = { waitUntil: (pending: Promise<unknown>) => promises.push(pending), passThroughOnException() {} } as unknown as ExecutionContext;
    const response = await app.request('/operation', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' } }, env, context);
    expect(await response.json()).toEqual({ success: true });
    expect(promises).toHaveLength(1); await Promise.all(promises);
    expect(JSON.stringify(warn.mock.calls)).toContain('AUDIT_WRITE_FAILED');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SQL contains private input');
  });
  it('drops both raw IP and hash if crypto fails while preserving the remaining event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = createAuthDatabase(); const { app, env } = appWithAudit(db, 'invalid');
    const response = await app.request('/operation', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' } }, env);
    expect(response.status).toBe(200);
    const row = await db.prepare('SELECT actor_name, ip_address, ip_recorded_at, ip_hash FROM audit_logs').first();
    expect(row).toEqual({ actor_name: actor.name, ip_address: null, ip_recorded_at: null, ip_hash: null });
  });
  it('records confirmed content changes and one bulk summary, omitting ordinary edits', async () => {
    const { db } = createAuthDatabase(); const { app, env } = appWithAudit(db);
    app.post('/content', (c) => {
      setAuditActor(c, actor);
      auditContentChange(c, 'post', { id: '1', title: 'Changed title only', status: 'draft' }, 'draft');
      auditContentChange(c, 'post', { id: '1', title: 'Published', status: 'published' }, 'draft');
      auditBulk(c, 'page', { requested: 3, updated: 1, unchanged: 1, conflict: 1, skipped: 0 }, 'trash');
      return c.json({ success: true });
    });
    await app.request('/content', { method: 'POST' }, env);
    const rows = await db.prepare('SELECT action, outcome, metadata_json FROM audit_logs ORDER BY rowid').all<{action:string;outcome:string;metadata_json:string}>();
    expect(rows.results.map((v) => [v.action,v.outcome])).toEqual([['content_status','success'],['content_bulk','partial']]);
    expect(JSON.parse(rows.results[1].metadata_json)).toMatchObject({ requested: 3, succeeded: 1, failed: 1 });
  });
  it('separates a continuation caller from the original Operations initiator', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { db } = createAuthDatabase(); const { app, env } = appWithAudit(db);
    app.post('/step', (c) => {
      setAuditActor(c, { kind: 'operations', id: null, name: 'Operations token', email: null });
      logAuditedOperation(c, 'EDGE_TARGET_RECONCILIATION_COMPLETED', { metadata: {
        action: 'advance_edge_target_reconciliation', operation_id: 'original-operation',
        initiated_by_user_id: actor.id, initiated_by_user_email: actor.email,
      } });
      return c.json({ success: true });
    });
    await app.request('/step', { method: 'POST' }, env);
    const row = await db.prepare('SELECT actor_kind, metadata_json FROM audit_logs').first<{actor_kind:string;metadata_json:string}>();
    expect(row?.actor_kind).toBe('operations');
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ stage: 'step', operation_id: 'original-operation', initiator: { id: actor.id, email: actor.email } });
  });
  it('records unknown publish outcomes without exposing error messages', async () => {
    const { db } = createAuthDatabase(); const { app, env } = appWithAudit(db);
    app.post('/publish', (c) => { setAuditActor(c, actor); beginAudit(c, { action: 'publishing_publish' });
      throw Object.assign(new Error('secret-provider-body'), { code: 'PUBLISHING_RESULT_UNKNOWN' }); });
    app.onError((_e, c) => c.json({ success: false }, 503));
    expect((await app.request('/publish', { method: 'POST' }, env)).status).toBe(503);
    expect(await db.prepare('SELECT outcome, metadata_json FROM audit_logs').first()).toEqual({ outcome: 'unknown', metadata_json: '{"error_code":"PUBLISHING_RESULT_UNKNOWN"}' });
  });
});
describe('audit read authorization', () => {
  it.each([['admin', 200], ['editor', 403], ['author', 403], [null, 401]] as const)('allows only an administrator: %s', async (role, status) => {
    const { db } = createAuthDatabase(); const app = createAuditRoutes({ resolveSession: async () => role
      ? { user: { ...actor, roles: [role] } } as unknown as ResolvedSession : null });
    for (const path of ['/', '/missing-record']) {
      const response = await app.request(path, {}, { DB: db } as StudioHonoEnvironment['Bindings']);
      expect(response.status).toBe(role === 'admin' && path !== '/' ? 404 : status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});
describe('released schema upgrade', () => {
  it('upgrades schema 1 to the fresh schema 2 without modifying existing data', async () => {
    const old = new DatabaseSync(':memory:'); const fresh = new DatabaseSync(':memory:');
    try {
      old.exec(readFileSync(new NodeURL('./fixtures/schema-1.sql', import.meta.url), 'utf8'));
      old.exec("INSERT INTO site_settings (key, value, updated_at_iso) VALUES ('test', 'preserved', '2026-01-01T00:00:00.000Z')");
      const artifact = STUDIO_SCHEMA_UPGRADE_ARTIFACTS.find((v) => v.fromVersion === 1)!;
      expect(await createSchemaUpgradeArtifactSha256(artifact.sql)).toBe(artifact.sha256);
      old.exec("INSERT INTO zeropress_schema_state (id, schema_version, lifecycle_state, updated_at_iso) VALUES (1, 1, 'ready', '2026-09-22T12:00:00.000Z')");
      const db = sqliteD1(old);
      const started = await startStudioSchemaUpgrade({ db,
        initiator: { userId: actor.id, userEmail: actor.email }, request: {
          administrator_email: actor.email, administrator_password: 'synthetic-password',
          backup_acknowledged: true, confirmation: DATABASE_UPGRADE_CONFIRMATION,
        }, now });
      const upgraded = await applyNextStudioSchemaUpgrade({ db, request: {
        operation_id: started.operation_id, step_id: started.next_step.id, confirmation: DATABASE_UPGRADE_CONFIRMATION,
      }, now });
      expect(upgraded.status).toBe('completed');
      expect(old.prepare('SELECT schema_version FROM zeropress_schema_state').get()).toEqual({ schema_version: 2 });
      fresh.exec(readFileSync(new NodeURL('../../../database/install/001_baseline.sql', import.meta.url), 'utf8'));
      const catalog = (db: DatabaseSync) => db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      expect(catalog(old)).toEqual(catalog(fresh));
      expect(old.prepare("SELECT value FROM site_settings WHERE key = 'test'").get()).toEqual({ value: 'preserved' });
      expect(old.prepare('SELECT count(*) AS count FROM audit_logs').get()).toEqual({ count: 0 });
      expect([STUDIO_SCHEMA_VERSION, MIN_SUPPORTED_STUDIO_SCHEMA_VERSION]).toEqual([2, 1]);
    } finally { old.close(); fresh.close(); }
  });
});
