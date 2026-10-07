import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import baseline from '../../../database/install/001_baseline.sql?raw';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { createPasskeySettingsRoutes } from './passkey-settings-routes';
import { materializePasskeySettings, readPasskeySettings, updatePasskeySettings } from './passkey-settings-repository';
import { createMfaManagementGrant } from './mfa-crypto';
import type { Env } from '../types';
import type { ResolvedSession } from './session-repository';
import { capabilityForMfaManagementOperation } from './authorization';

const now = new Date('2026-10-01T00:00:00.000Z');
const userId = '1'.repeat(32); const sessionId = '2'.repeat(32); const authRevision = '3'.repeat(32);
const authSecret = 'synthetic-auth-secret-only-for-tests-123456789'; const csrfToken = 'c'.repeat(43);
const session = { user: { id: userId, email: 'owner@example.test', name: 'Owner', roles: ['admin'] }, session: { id: sessionId }, authRevision, csrfToken } as ResolvedSession;
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });
function database() {
  const sql = new DatabaseSync(':memory:'); dbs.push(sql); sql.exec(baseline);
  sql.prepare('INSERT INTO users (id,email,password_hash,name,created_at_iso,updated_at_iso) VALUES (?,?,?,?,?,?)').run(userId,'owner@example.test','synthetic','Owner',now.toISOString(),now.toISOString());
  return { sql, db: sqliteD1(sql) };
}

describe('passkey registration policy', () => {
  it('defaults to off, rejects partial data and preserves revision conflicts', async () => {
    const { db, sql } = database();
    const first = await readPasskeySettings({ db });
    expect(first.settings.require_fido_certified_authenticator).toBe(false);
    const result = await updatePasskeySettings({ db, expectedRevision: first.revision, updatedBy: userId, settings: { require_fido_certified_authenticator: true }, now });
    expect(result.kind).toBe('completed'); expect((await readPasskeySettings({ db })).settings.require_fido_certified_authenticator).toBe(true);
    expect(await updatePasskeySettings({ db, expectedRevision: first.revision, updatedBy: userId, settings: { require_fido_certified_authenticator: false }, now })).toEqual({ kind: 'revision_conflict' });
    sql.exec("DELETE FROM studio_settings WHERE key='passkey_registration_policy_revision'");
    await expect(readPasskeySettings({ db })).rejects.toThrow();
    expect(() => materializePasskeySettings([{ key: 'passkey_registration_policy', type: 'json', value: 'not JSON', updated_at_iso: now.toISOString() }])).toThrow();
  });
  it('requires administrator, same-origin, CSRF and a grant bound to the new operation/session', async () => {
    const { db } = database(); const environment = { DB: db, STUDIO_AUTH_SECRET: authSecret } as Env;
    const routes = createPasskeySettingsRoutes({ resolveSession: async () => session, now: () => now });
    const get = await routes.fetch(new Request('https://studio.example.test/'), environment);
    expect(get.status).toBe(200); expect(get.headers.get('cache-control')).toBe('no-store');
    const revision = (await get.json() as { data: { revision: string } }).data.revision;
    const grant = await createMfaManagementGrant({ authSecret, userId, sessionId, authRevision, operation: 'change_passkey_policy', now });
    const req = (token = grant.token, origin = 'https://studio.example.test', csrf = csrfToken) => new Request('https://studio.example.test/', {
      method: 'PUT', headers: { Origin: origin, 'X-ZeroPress-CSRF': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: revision, management_token: token, settings: { require_fido_certified_authenticator: true } }),
    });
    expect((await routes.fetch(req(grant.token, 'https://evil.example'), environment)).status).toBe(403);
    expect((await routes.fetch(req(grant.token, undefined, 'wrong'), environment)).status).toBe(403);
    const wrong = await createMfaManagementGrant({ authSecret, userId, sessionId, authRevision, operation: 'add_webauthn', now });
    expect((await routes.fetch(req(wrong.token), environment)).status).toBe(401);
    const nonAdmin = createPasskeySettingsRoutes({ resolveSession: async () => ({ ...session, user: { ...session.user, roles: ['editor'] } }), now: () => now });
    expect((await nonAdmin.fetch(req(), environment)).status).toBe(403);
    expect((await nonAdmin.fetch(new Request('https://studio.example.test/'), environment)).status).toBe(403);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await routes.fetch(req(), environment)).status).toBe(200);
    expect((await readPasskeySettings({ db })).settings.require_fido_certified_authenticator).toBe(true);
    expect(capabilityForMfaManagementOperation('change_passkey_policy')).toBe('settings.manage');
  });
});

it.each([{ success: false }, { success: true }])('does not treat an incomplete D1 response as the default OFF policy: %j', async (result) => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => result }) }) } as unknown as D1Database;
  await expect(readPasskeySettings({ db })).rejects.toMatchObject({ code: 'PASSKEY_SETTINGS_QUERY_FAILED' });
});
