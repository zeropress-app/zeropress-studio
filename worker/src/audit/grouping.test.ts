import { describe, expect, it } from 'vitest';
import { auditLogEventsSuccessSchema, type AuditLogDetail } from '../../../contracts/audit-logs';
import { createAuthDatabase } from '../test-helpers/auth-database';
import { createAuditRoutes } from './routes';
import { insertAuditLog, listAuditLogs, readAuditLog, readAuditLogEvents, InvalidAuditCursor } from './repository';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';

const now = new Date('2026-09-26T12:00:00.000Z');
const actor = { kind: 'user' as const, id: 'a'.repeat(32), name: 'Original owner', email: 'original@example.test' };
function event(index: number, overrides: Partial<AuditLogDetail> = {}): AuditLogDetail {
  return {
    id: index.toString(16).padStart(36, '0'), occurred_at: new Date(now.getTime() - 100_000 + index * 1000).toISOString(),
    action: 'operations_search', category: 'operations', outcome: 'success', actor,
    target: { type: 'DB', id: null, label: null }, metadata: { operation_id: 'same-rebuild', stage: 'step' },
    network: { ip_address: '192.0.2.1', ip_recorded_at: now.toISOString(), ip_hash: `v1.${'a'.repeat(64)}`,
      user_agent: 'Synthetic browser', country: null, region: null, city: null, timezone: null, asn: null, organization: null },
    ...overrides,
  };
}

describe('search rebuild audit grouping', () => {
  it('keeps completion ahead of progress when events share a timestamp', async () => {
    const { db } = createAuthDatabase();
    const completed = event(1, { metadata: { operation_id: 'same-rebuild', stage: 'completed' } });
    const step = event(2, { occurred_at: completed.occurred_at });
    const start = event(3, { occurred_at: completed.occurred_at, metadata: { operation_id: 'same-rebuild', stage: 'started' } });
    await db.batch([completed, step, start].map(row => insertAuditLog(db, row)));
    expect((await listAuditLogs(db, {}, now)).items).toMatchObject([{ id: completed.id, event_count: 3 }]);
  });
  it('groups historical steps before pagination and leaves unrelated work separate', async () => {
    const { db } = createAuthDatabase();
    const steps = Array.from({ length: 60 }, (_, index) => event(index + 1));
    const other = Array.from({ length: 51 }, (_, index) => event(index + 100, {
      action: 'auth_login', category: 'auth', metadata: { method: 'totp' },
    }));
    await db.batch([...steps, ...other].map(row => insertAuditLog(db, row)));
    const first = await listAuditLogs(db, {}, now);
    const second = await listAuditLogs(db, { cursor: first.next_cursor! }, now);
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(2);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map(row => row.id)).size).toBe(52);
    const rebuild = all.filter(row => row.action === 'operations_search');
    expect(rebuild).toMatchObject([{ id: steps.at(-1)!.id, event_count: 60 }]);
    const page = await readAuditLogEvents(db, rebuild[0].id, undefined, now);
    const earlier = await readAuditLogEvents(db, rebuild[0].id, page!.next_cursor!, now);
    expect(page!.items).toHaveLength(50);
    expect(earlier!.items).toHaveLength(10);
    expect(new Set([...page!.items, ...earlier!.items].map(row => row.id)).size).toBe(60);
    expect(earlier!.next_cursor).toBeNull();
    expect(page!.items[0]).not.toHaveProperty('network');
    expect(await readAuditLog(db, page!.items[0].id, now)).toMatchObject({ network: { ip_address: '192.0.2.1' } });
    await expect(readAuditLogEvents(db, other[0].id, page!.next_cursor!, now)).rejects.toBeInstanceOf(InvalidAuditCursor);
  });

  it('keeps the latest result when matching an earlier caller or IP, and filters outcomes by that latest result', async () => {
    const { db } = createAuthDatabase();
    const start = event(1, { metadata: { operation_id: 'same-rebuild', stage: 'started' } });
    const failure = event(2, { outcome: 'failed', metadata: { operation_id: 'same-rebuild', stage: 'step' } });
    const complete = event(3, {
      actor: { kind: 'operations', id: null, name: 'Operations token', email: null },
      metadata: { operation_id: 'same-rebuild', stage: 'completed', initiator: actor },
      network: { ...start.network, ip_hash: `v1.${'b'.repeat(64)}`, ip_address: '192.0.2.2' },
    });
    await db.batch([start, failure].map(row => insertAuditLog(db, row)));
    expect((await listAuditLogs(db, { outcome: 'failed' }, now)).items).toMatchObject([{ id: failure.id, event_count: 2 }]);
    await insertAuditLog(db, complete).run();
    expect((await listAuditLogs(db, { actor: 'original@', ip_hash: start.network.ip_hash! }, now)).items)
      .toMatchObject([{ id: complete.id, outcome: 'success', event_count: 3, metadata: { stage: 'completed' } }]);
    expect((await listAuditLogs(db, { actor: 'original@', ip_hash: complete.network.ip_hash! }, now)).items).toHaveLength(0);
    expect((await listAuditLogs(db, { outcome: 'failed' }, now)).items).toHaveLength(0);
    expect((await listAuditLogs(db, { to: start.occurred_at }, now)).items).toHaveLength(0);
    const events = await readAuditLogEvents(db, complete.id, undefined, now);
    expect(events!.items.map(row => row.outcome)).toEqual(['success', 'failed', 'success']);
  });

  it('keeps different or missing operation IDs separate and applies retention to grouped history', async () => {
    const { db } = createAuthDatabase();
    const expiredAt = new Date(now.getTime() - 365 * 86400000).toISOString();
    const expired = event(1, { occurred_at: expiredAt });
    const redactedAt = new Date(now.getTime() - 30 * 86400000).toISOString();
    const redacted = event(2, { occurred_at: redactedAt, network: { ...event(2).network, ip_recorded_at: redactedAt } });
    await db.batch([expired, redacted, event(3), event(4, { metadata: { operation_id: 'another-rebuild' } }),
      event(5, { metadata: {} }), event(6, { metadata: {} }),
      event(7, { action: 'operations_upgrade' }),
    ].map(row => insertAuditLog(db, row)));
    const list = await listAuditLogs(db, {}, now);
    expect(list.items).toHaveLength(5);
    expect(list.items.find(row => row.id === event(3).id)?.event_count).toBe(2);
    expect((await readAuditLogEvents(db, event(3).id, undefined, now))!.items).toHaveLength(2);
    expect(await readAuditLogEvents(db, expired.id, undefined, now)).toBeNull();
    expect((await readAuditLog(db, redacted.id, now))?.network).toMatchObject({ ip_address: null, ip_recorded_at: null });
  });

  it('protects step history with audit.read and validates its cursor', async () => {
    const { db } = createAuthDatabase();
    const row = event(1, { occurred_at: new Date().toISOString() });
    await insertAuditLog(db, row).run();
    for (const [role, status] of [[null, 401], ['editor', 403], ['admin', 200]] as const) {
      const routes = createAuditRoutes({ resolveSession: async () => role ? { user: { ...actor, roles: [role] } } as unknown as ResolvedSession : null });
      const response = await routes.request(`/${row.id}/events`, {}, { DB: db } as Env);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      if (role === 'admin') {
        expect(auditLogEventsSuccessSchema.parse(await response.json()).data.items).toHaveLength(1);
        expect((await routes.request(`/${row.id}/events?cursor=invalid`, {}, { DB: db } as Env)).status).toBe(400);
        expect((await routes.request('/missing/events', {}, { DB: db } as Env)).status).toBe(404);
      }
    }
  });
});
