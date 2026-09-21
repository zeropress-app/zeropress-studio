import type { Context, MiddlewareHandler } from 'hono';
import {
  AUDIT_ACTIONS,
  auditLogDetailSchema,
  parseAuditMetadata,
  type AuditAction,
  type AuditActor,
  type AuditMetadata,
  type AuditOutcome,
} from '../../../contracts/audit-logs';
import { logOperationalFailure, StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { captureAuditNetwork, hashAuditIp, type AuditNetwork } from './network';
import { operationsEvent } from './operation-event';
import { insertAuditLog } from './repository';

export type AuditEvent = {
  action: AuditAction;
  outcome?: AuditOutcome;
  actor?: AuditActor;
  target?: { type: string; id?: string | null; label?: string | null };
  metadata?: AuditMetadata;
};

export type AuditContext = {
  attempt?: AuditEvent;
  network: AuditNetwork;
  actor?: AuditActor;
  events: (AuditEvent & { occurred_at: string })[];
};

type AuditHonoContext = Context<StudioHonoEnvironment>;
type ContentSnapshot = { id: string; title: string; status: string };

export function userAuditActor(user: { id: string; name: string; email: string }): AuditActor {
  return { kind: 'user', id: user.id, name: user.name, email: user.email };
}

export function setAuditActor(c: AuditHonoContext, actor: AuditActor): void {
  const state = c.get('audit');
  if (state) state.actor = actor;
}

export function recordAudit(c: AuditHonoContext, event: AuditEvent): void {
  const state = c.get('audit');
  if (!state) return;
  if (state.attempt?.action === event.action) state.attempt = undefined;
  // Snapshot the actor before another operation can change or delete the account.
  state.events.push({
    ...event,
    actor: event.actor ?? state.actor,
    occurred_at: new Date().toISOString(),
  });
}

// Call after permission, CSRF and input checks, immediately before the operation.
export function beginAudit(c: AuditHonoContext, event: AuditEvent): void {
  const state = c.get('audit');
  if (state) state.attempt = { ...event, actor: event.actor ?? state.actor };
}

export async function auditUserById(c: AuditHonoContext, id: string): Promise<AuditActor> {
  try {
    const user = await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?')
      .bind(id).first<{ id: string; name: string; email: string }>();
    if (user) return userAuditActor(user);
  } catch {
    logOperationalFailure('AUDIT_SNAPSHOT_FAILED', { metadata: { resource: 'DB' } });
  }
  return { kind: 'user', id, name: null, email: null };
}

async function persistAudit(c: AuditHonoContext, state: AuditContext): Promise<void> {
  try {
    const network = { ...state.network };
    if (network.ip_address) {
      try {
        network.ip_hash = await hashAuditIp(network.ip_address, c.env.STUDIO_AUTH_SECRET);
      } catch {
        network.ip_address = null;
        network.ip_recorded_at = null;
        network.ip_hash = null;
        logOperationalFailure('AUDIT_IP_HASH_FAILED', { metadata: { component: 'web_crypto' } });
      }
    }
    const statements: D1PreparedStatement[] = [];
    for (const event of state.events) {
      try {
        if (!event.actor) throw new Error('Verified audit actor missing');
        const row = auditLogDetailSchema.parse({
          id: crypto.randomUUID(),
          occurred_at: event.occurred_at,
          category: AUDIT_ACTIONS[event.action],
          action: event.action,
          outcome: event.outcome ?? 'success',
          actor: event.actor,
          target: {
            type: event.target?.type ?? 'account',
            id: event.target?.id ?? null,
            label: event.target?.label?.slice(0, 512) ?? null,
          },
          metadata: parseAuditMetadata(event.action, event.metadata ?? {}),
          network,
        });
        statements.push(insertAuditLog(c.env.DB, row));
      } catch {
        // A malformed event must not discard other confirmed results in this request.
        logOperationalFailure('AUDIT_WRITE_FAILED', { metadata: { resource: 'DB' } });
      }
    }
    if (!statements.length) return;
    const results = await c.env.DB.batch(statements);
    if (results.some((result) => result.meta.changes === 0)) {
      logOperationalFailure('AUDIT_WRITE_FAILED', {
        metadata: { resource: 'DB', reason: 'database_restore_in_progress' },
      });
    }
  } catch {
    logOperationalFailure('AUDIT_WRITE_FAILED', { metadata: { resource: 'DB' } });
  }
}

function recordFailedAttempt(c: AuditHonoContext, state: AuditContext): void {
  if (c.error instanceof StudioOperationalError && state.actor && !state.attempt) {
    const event = operationsEvent(state.actor, c.error.operationalMetadata, 'step');
    if (event && !state.events.some((completed) => completed.action === event.action)) {
      beginAudit(c, event);
    }
  }
  if (!c.error || !state.attempt) return;
  const code = 'code' in c.error && typeof c.error.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,99}$/.test(c.error.code) ? c.error.code : undefined;
  const outcome: AuditOutcome = code === 'PUBLISHING_RESULT_UNKNOWN' ? 'unknown'
    : c.error instanceof StudioOperationalError && c.error.operationalMetadata.completed_resource
      ? 'partial' : 'failed';
  recordAudit(c, {
    ...state.attempt,
    outcome,
    metadata: { ...state.attempt.metadata, error_code: code },
  });
}

export const auditMiddleware: MiddlewareHandler<StudioHonoEnvironment> = async (c, next) => {
  const state: AuditContext = { network: captureAuditNetwork(c.req.raw), events: [] };
  c.set('audit', state);
  await next();
  recordFailedAttempt(c, state);
  if (!state.events.length) return;
  const pending = persistAudit(c, state);
  try {
    c.executionCtx.waitUntil(pending);
  } catch {
    await pending;
  }
};

export function auditSettings(
  c: AuditHonoContext,
  section: string,
  fields: string[],
  credential?: AuditMetadata['credential'],
): void {
  recordAudit(c, {
    action: 'settings_update',
    target: { type: 'settings', id: section, label: section },
    metadata: { fields, credential },
  });
}

function contentAction(previous: string, next: string): AuditAction {
  return next === 'trash' ? 'content_trash' : previous === 'trash' ? 'content_restore' : 'content_status';
}

export function auditContentChange(
  c: AuditHonoContext,
  type: 'post' | 'page',
  current: ContentSnapshot,
  previous: string | undefined,
): void {
  if (previous === undefined || current.status === previous) return;
  recordAudit(c, {
    action: contentAction(previous, current.status),
    target: { type, id: current.id, label: current.title },
    metadata: { from_status: previous, to_status: current.status },
  });
}

export function beginContentAudit(
  c: AuditHonoContext,
  type: 'post' | 'page',
  current: ContentSnapshot,
  status: string,
): void {
  if (current.status === status) return;
  beginAudit(c, {
    action: contentAction(current.status, status),
    target: { type, id: current.id, label: current.title },
    metadata: { from_status: current.status, to_status: status },
  });
}

export function auditBulk(
  c: AuditHonoContext,
  type: 'post' | 'page' | 'media',
  summary: { requested: number; updated: number; unchanged: number; conflict: number; skipped: number },
  status?: string,
): void {
  const failed = summary.conflict + summary.skipped;
  recordAudit(c, {
    action: type === 'media' ? 'media_delete' : 'content_bulk',
    target: { type },
    outcome: failed ? (summary.updated ? 'partial' : 'failed') : summary.updated ? 'success' : 'unchanged',
    metadata: {
      requested: summary.requested,
      succeeded: summary.updated,
      skipped: summary.unchanged,
      failed,
      to_status: status,
    },
  });
}
