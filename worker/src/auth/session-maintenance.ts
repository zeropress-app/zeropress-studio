import { pruneAuditLogs } from '../audit/repository';
import { logOperationalFailure } from '../lib/operational-error';
import { inspectDatabaseStatus } from '../system/database-status';
import { resolveSiteMode } from '../system/site-mode';
import { StudioOperationalError } from '../lib/operational-error';
import {
  garbageCollectExpiredSessions,
  type SessionGarbageCollectionResult,
} from './session-garbage-collector';
import type { Env } from '../types';
import { garbageCollectExpiredAuthRateLimits } from './login-rate-limit';
import {
  garbageCollectWebAuthnChallenges,
} from './webauthn-repository';
import { garbageCollectExpiredMediaUploadIntents } from '../media/media-upload-repository';
import { drainMediaObjectDeletionQueue } from '../media/media-object-cleanup';
import { garbageCollectExpiredContentAutosaves } from '../content-autosaves/repository';

export type SessionMaintenanceResult =
  | {
    status: 'skipped';
    reason: 'site_mode_not_operational' | 'database_not_ready';
  }
  | ({
    status: 'completed';
    deleted_webauthn_challenges: number;
    deleted_media_upload_intents: number;
    deleted_media_objects: number;
    deleted_content_autosaves: number;
    deleted_auth_rate_limits: number;
  } & SessionGarbageCollectionResult);

type SessionMaintenanceDependencies = {
  inspectDatabase?: typeof inspectDatabaseStatus;
  collectExpiredSessions?: typeof garbageCollectExpiredSessions;
  collectExpiredWebAuthnChallenges?: typeof garbageCollectWebAuthnChallenges;
  collectExpiredMediaUploadIntents?: typeof garbageCollectExpiredMediaUploadIntents;
  drainMediaObjectDeletions?: typeof drainMediaObjectDeletionQueue;
  collectExpiredContentAutosaves?: typeof garbageCollectExpiredContentAutosaves;
  collectExpiredAuthRateLimits?: typeof garbageCollectExpiredAuthRateLimits;
  managedMediaStorageEnabled?: boolean;
  now?: Date;
};

export async function runScheduledSessionMaintenance(
  env: Env,
  dependencies: SessionMaintenanceDependencies = {},
): Promise<SessionMaintenanceResult> {
  const siteMode = resolveSiteMode(env.STUDIO_SITE_MODE);
  if (
    siteMode.state !== 'valid'
    || siteMode.mode !== 'operational'
  ) {
    return {
      status: 'skipped',
      reason: 'site_mode_not_operational',
    };
  }

  const inspection = await (
    dependencies.inspectDatabase ?? inspectDatabaseStatus
  )(env.DB);
  if (inspection.status.state === 'unavailable') {
    throw new StudioOperationalError('DATABASE_STATUS_QUERY_FAILED', {
      cause: inspection.incident?.cause,
      metadata: inspection.incident?.metadata ?? {
        resource: 'DB',
        action: 'inspect_database_status',
      },
    });
  }
  if (inspection.status.state !== 'ready') {
    return {
      status: 'skipped',
      reason: 'database_not_ready',
    };
  }

  const now = dependencies.now ?? new Date();
  try { await pruneAuditLogs(env.DB, now); }
  catch { logOperationalFailure('AUDIT_RETENTION_FAILED', { metadata: { resource: 'DB' } }); }
  const collected = await (
    dependencies.collectExpiredSessions ?? garbageCollectExpiredSessions
  )({
    db: env.DB,
    now,
  });
  const webAuthnChallenges = await (
    dependencies.collectExpiredWebAuthnChallenges
      ?? garbageCollectWebAuthnChallenges
  )({
    db: env.DB,
    now,
  });
  const contentAutosaves = await (
    dependencies.collectExpiredContentAutosaves
      ?? garbageCollectExpiredContentAutosaves
  )({ db: env.DB, now });
  const authRateLimits = await (
    dependencies.collectExpiredAuthRateLimits ?? garbageCollectExpiredAuthRateLimits
  )({ db: env.DB, now });
  let mediaUploadIntents = { deletedRows: 0, queuedObjectRows: 0 };
  let mediaObjects = { pendingRows: 0, deletedRows: 0 };
  if (dependencies.managedMediaStorageEnabled !== false) {
    mediaUploadIntents = await (
      dependencies.collectExpiredMediaUploadIntents
        ?? garbageCollectExpiredMediaUploadIntents
    )({ db: env.DB, now });
    mediaObjects = await (
      dependencies.drainMediaObjectDeletions
        ?? drainMediaObjectDeletionQueue
    )({ db: env.DB, bucket: env.MEDIA_BUCKET, now });
  }
  return {
    status: 'completed',
    ...collected,
    deleted_webauthn_challenges: webAuthnChallenges.deletedRows,
    deleted_media_upload_intents: mediaUploadIntents.deletedRows,
    deleted_media_objects: mediaObjects.deletedRows,
    deleted_content_autosaves: contentAutosaves.deletedRows,
    deleted_auth_rate_limits: authRateLimits.deletedRows,
  };
}
