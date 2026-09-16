import type { ApiErrorCode } from '../../../contracts/api';
import type { EdgeServicesDocument } from '../../../contracts/edge-services';
import { countPendingCommentTargetEvents } from '../comments/target-projection-outbox';
import { logStudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';
import {
  edgeHealthFailure,
  inspectEdgeIntegration,
  type EdgeIntegrationInspection,
} from './edge-integration-health';
import {
  readEdgeIntegrationSettings,
  type StoredEdgeIntegrationDocument,
} from './edge-services-repository';

export type EdgeServicesMaterializationDependencies = {
  readSettings?: typeof readEdgeIntegrationSettings;
  countPending?: typeof countPendingCommentTargetEvents;
  inspect?: typeof inspectEdgeIntegration;
};

export function edgeIntegrationActivationError(
  health: EdgeIntegrationInspection,
): ApiErrorCode | null {
  if (health.state === 'ready') return null;
  if (health.state === 'projection_pending') {
    return 'EDGE_TARGET_PROJECTION_PENDING';
  }
  if (health.state === 'reconciliation_required') {
    return 'EDGE_RECONCILIATION_REQUIRED';
  }
  const lifecycleCode = {
    database_uninstalled: 'EDGE_DATABASE_INSTALL_REQUIRED',
    database_adoption_required: 'EDGE_DATABASE_ADOPTION_REQUIRED',
    database_upgrade_required: 'EDGE_DATABASE_UPGRADE_REQUIRED',
    database_recovery_required: 'EDGE_DATABASE_RECOVERY_REQUIRED',
    database_unmanaged: 'EDGE_DATABASE_RECOVERY_REQUIRED',
    database_newer_than_code: 'EDGE_DATABASE_RECOVERY_REQUIRED',
    schema_incomplete: 'EDGE_DATABASE_RECOVERY_REQUIRED',
    seed_incomplete: 'EDGE_DATABASE_RECOVERY_REQUIRED',
  } as const satisfies Partial<Record<
    Extract<EdgeIntegrationInspection, { state: 'unavailable' }>['reason'],
    ApiErrorCode
  >>;
  return lifecycleCode[health.reason as keyof typeof lifecycleCode]
    ?? 'EDGE_INTEGRATION_UNAVAILABLE';
}

export async function materializeEdgeServicesDocument(input: {
  env: Env;
  stored?: StoredEdgeIntegrationDocument;
  dependencies?: EdgeServicesMaterializationDependencies;
  requestContext?: {
    method: string;
    pathname: string;
  };
}): Promise<EdgeServicesDocument> {
  const readSettings = input.dependencies?.readSettings
    ?? readEdgeIntegrationSettings;
  const countPending = input.dependencies?.countPending
    ?? countPendingCommentTargetEvents;
  const inspect = input.dependencies?.inspect ?? inspectEdgeIntegration;
  const stored = input.stored ?? await readSettings({ db: input.env.DB });
  if (stored.settings.mode === 'disabled') {
    return {
      ...stored,
      effective_state: 'disabled',
      pending_target_events: await countPending({ db: input.env.DB }),
    };
  }
  const health = await inspect({ env: input.env, countPending });
  if (health.state === 'ready') {
    return {
      ...stored,
      effective_state: 'ready',
      pending_target_events: 0,
    };
  }
  if (health.state === 'projection_pending') {
    return {
      ...stored,
      effective_state: 'projection_pending',
      pending_target_events: health.pendingTargetEvents,
    };
  }
  if (health.state === 'reconciliation_required') {
    return {
      ...stored,
      effective_state: 'reconciliation_required',
      unavailable_reason: 'target_mismatch',
      pending_target_events: 0,
    };
  }
  logStudioOperationalError(
    edgeHealthFailure(health),
    input.requestContext,
  );
  return {
    ...stored,
    effective_state: 'unavailable',
    unavailable_reason: health.reason,
    pending_target_events: 0,
  };
}
