import { DATABASE_RESTORE_JOURNAL_TABLE } from '../system/schema-upgrade-state';
import {
  AUDIT_IP_RETENTION_DAYS, AUDIT_RETENTION_DAYS, auditLogDetailSchema,
  type AuditLogDetail, type AuditLogQuery,
} from '../../../contracts/audit-logs';
const DAY = 86_400_000;
export const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();
type Row = Record<string, unknown>;
export function insertAuditLog(db: D1Database, event: AuditLogDetail): D1PreparedStatement {
  const { actor, target, network } = event;
  return db.prepare(`INSERT INTO audit_logs (
    id, occurred_at, action, category, outcome, actor_kind, actor_id, actor_name, actor_email,
    target_type, target_id, target_label, metadata_json, ip_address, ip_recorded_at, ip_hash,
    user_agent, country, region, city, timezone, asn, organization
  ) SELECT ${Array(23).fill('?').join(', ')}
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)`).bind(
    event.id, event.occurred_at, event.action, event.category, event.outcome,
    actor.kind, actor.id, actor.name, actor.email, target.type, target.id, target.label,
    JSON.stringify(event.metadata), network.ip_address, network.ip_recorded_at, network.ip_hash,
    network.user_agent, network.country, network.region, network.city, network.timezone, network.asn, network.organization,
    DATABASE_RESTORE_JOURNAL_TABLE,
  );
}
function decodeRow(row: Row, now: Date): AuditLogDetail {
  const rawIpVisible = typeof row.ip_recorded_at === 'string'
    && row.ip_recorded_at > cutoff(now, AUDIT_IP_RETENTION_DAYS);
  return auditLogDetailSchema.parse({
    id: row.id, occurred_at: row.occurred_at, action: row.action, category: row.category, outcome: row.outcome,
    actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name, email: row.actor_email },
    target: { type: row.target_type, id: row.target_id, label: row.target_label },
    metadata: JSON.parse(String(row.metadata_json)),
    network: {
      ip_address: rawIpVisible ? row.ip_address : null, ip_recorded_at: rawIpVisible ? row.ip_recorded_at : null,
      ip_hash: row.ip_hash, user_agent: row.user_agent, country: row.country, region: row.region,
      city: row.city, timezone: row.timezone, asn: row.asn, organization: row.organization,
    },
  });
}
export class InvalidAuditCursor extends Error {}
function filterKey(query: AuditLogQuery): string {
  return JSON.stringify([query.from ?? null, query.to ?? null, query.actor ?? null,
    query.category ?? null, query.outcome ?? null, query.ip_hash ?? null]);
}
function encodeCursor(values: string[]): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(values))));
}
function decodeCursor(cursor: string, query: AuditLogQuery): [string, string] {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor), (v) => v.charCodeAt(0))));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== filterKey(query)
      || typeof value[1] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[1])
      || typeof value[2] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[2])) throw new Error();
    return [value[1], value[2]];
  } catch { throw new InvalidAuditCursor(); }
}
export async function listAuditLogs(db: D1Database, query: AuditLogQuery, now = new Date()) {
  const clauses = ['occurred_at > ?'];
  const values: string[] = [cutoff(now, AUDIT_RETENTION_DAYS)];
  for (const [field, operator, value] of [
    ['occurred_at', '>=', query.from], ['occurred_at', '<=', query.to],
    ['category', '=', query.category], ['outcome', '=', query.outcome], ['ip_hash', '=', query.ip_hash],
  ]) {
    if (value) { clauses.push(`${field} ${operator} ?`); values.push(value); }
  }
  if (query.actor) {
    clauses.push('(instr(lower(actor_name), lower(?)) > 0 OR instr(lower(actor_email), lower(?)) > 0 OR actor_id = ?)');
    values.push(query.actor, query.actor, query.actor);
  }
  if (query.cursor) {
    const [time, id] = decodeCursor(query.cursor, query);
    clauses.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))'); values.push(time, time, id);
  }
  const result = await db.prepare(`SELECT * FROM audit_logs WHERE ${clauses.join(' AND ')}
    ORDER BY occurred_at DESC, id DESC LIMIT 51`).bind(...values).all<Row>();
  const rows = result.results.slice(0, 50).map((row) => decodeRow(row, now));
  const last = rows.at(-1);
  return {
    items: rows.map(({ network: _network, ...event }) => event),
    next_cursor: result.results.length > 50 && last
      ? encodeCursor([filterKey(query), last.occurred_at, last.id]) : null,
  };
}
export async function readAuditLog(db: D1Database, id: string, now = new Date()) {
  const row = await db.prepare('SELECT * FROM audit_logs WHERE id = ? AND occurred_at > ?')
    .bind(id, cutoff(now, AUDIT_RETENTION_DAYS)).first<Row>();
  return row ? decodeRow(row, now) : null;
}
export async function pruneAuditLogs(db: D1Database, now = new Date()): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE audit_logs SET ip_address = NULL, ip_recorded_at = NULL WHERE id IN
      (SELECT id FROM audit_logs WHERE ip_address IS NOT NULL AND ip_recorded_at <= ? LIMIT 500)
      AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)`)
      .bind(cutoff(now, AUDIT_IP_RETENTION_DAYS), DATABASE_RESTORE_JOURNAL_TABLE),
    db.prepare(`DELETE FROM audit_logs WHERE id IN
      (SELECT id FROM audit_logs WHERE occurred_at <= ? ORDER BY occurred_at LIMIT 500)
      AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)`)
      .bind(cutoff(now, AUDIT_RETENTION_DAYS), DATABASE_RESTORE_JOURNAL_TABLE),
  ]);
}
