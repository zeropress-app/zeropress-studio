import type { Context } from 'hono';
import type { AuditMetadata, AuditOutcome } from '../../../contracts/audit-logs';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { operationsEvent } from './operation-event';
import { beginAudit, recordAudit } from './service';

// The caller has confirmed this operation's result, independently of its HTTP response.
export function logAuditedOperation(
  c: Context<StudioHonoEnvironment>,
  code: Parameters<typeof logOperationalFailure>[0],
  options: Parameters<typeof logOperationalFailure>[1],
  result?: { outcome: AuditOutcome; metadata?: AuditMetadata },
): void {
  logOperationalFailure(code, options);
  const values = options?.metadata ?? {};
  const operation = String(values.action ?? '');
  const step = operation.startsWith('advance_') || operation.startsWith('apply_')
    || operation === 'purge_edge_target_orphans' || code.endsWith('_STEP_COMPLETED');
  const started = code.endsWith('_STARTED') && !step;
  const stage = step ? 'step' : started ? 'started'
    : operation.startsWith('cancel_') ? 'cancelled' : 'completed';
  const event = operationsEvent(c.get('audit')?.actor, values, stage);
  if (!event) return;
  if (!started || event.metadata.operation_id) {
    recordAudit(c, {
      ...event,
      outcome: result?.outcome,
      metadata: { ...event.metadata, ...result?.metadata },
    });
  }
  if (started) beginAudit(c, event);
}
