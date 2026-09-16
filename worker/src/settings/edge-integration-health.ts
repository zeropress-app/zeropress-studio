import type {
  EdgeIntegrationUnavailableReason,
} from '../../../contracts/edge-services';
import type { EdgeDatabaseStatus } from '../../../contracts/edge-database-lifecycle';
import { StudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';
import { inspectEdgeDatabaseLifecycle } from '../edge-database/lifecycle';
import { countPendingCommentTargetEvents } from '../comments/target-projection-outbox';
import { edgeTargetParityMatches } from '../comments/target-reconciliation';

export type EdgeIntegrationInspection =
  | { state: 'ready' }
  | { state: 'projection_pending'; pendingTargetEvents: number }
  | {
      state: 'unavailable';
      reason: EdgeIntegrationUnavailableReason;
      cause?: unknown;
    }
  | { state: 'reconciliation_required' };

export async function inspectEdgeIntegration(input: {
  env: Env;
  inspectLifecycle?: (input: {
    edgeDb?: D1Database;
    siteMode: 'operational';
  }) => Promise<EdgeDatabaseStatus>;
  countPending?: typeof countPendingCommentTargetEvents;
  compareTargets?: typeof edgeTargetParityMatches;
}): Promise<EdgeIntegrationInspection> {
  if (!input.env.EDGE_DB) {
    return { state: 'unavailable', reason: 'edge_db_binding_missing' };
  }
  const edgeDb = input.env.EDGE_DB;
  const lifecycle = await (input.inspectLifecycle ?? inspectEdgeDatabaseLifecycle)({
    edgeDb,
    siteMode: 'operational',
  });
  if (lifecycle.state !== 'ready') {
    const reasons = {
      uninstalled: 'database_uninstalled',
      adoption_required: 'database_adoption_required',
      upgrade_required: 'database_upgrade_required',
      in_progress: 'database_upgrade_required',
      recovery_required: 'database_recovery_required',
      unmanaged: 'database_unmanaged',
      newer_than_code: 'database_newer_than_code',
      unavailable: 'database_unavailable',
    } as const;
    return { state: 'unavailable', reason: reasons[lifecycle.state] };
  }
  try {
    const pending = await (input.countPending
      ?? countPendingCommentTargetEvents)({ db: input.env.DB });
    if (pending > 0) {
      return { state: 'projection_pending', pendingTargetEvents: pending };
    }
    if (!await (input.compareTargets ?? edgeTargetParityMatches)({
      db: input.env.DB,
      edgeDb,
    })) return { state: 'reconciliation_required' };
    if (!input.env.EDGE_KV) {
      return { state: 'unavailable', reason: 'edge_kv_binding_missing' };
    }
    return { state: 'ready' };
  } catch (cause) {
    return { state: 'unavailable', reason: 'database_unavailable', cause };
  }
}

export function edgeHealthFailure(input: {
  reason: EdgeIntegrationUnavailableReason;
  cause?: unknown;
}) {
  return new StudioOperationalError('EDGE_INTEGRATION_HEALTH_CHECK_FAILED', {
    cause: input.cause,
    metadata: {
      resource: 'EDGE_DB',
      related_resource: 'EDGE_KV',
      action: 'inspect_edge_integration',
      reason: input.reason,
    },
  });
}
