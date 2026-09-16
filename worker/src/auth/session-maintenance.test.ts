import { describe, expect, it, vi } from 'vitest';
import type { DatabaseInspection } from '../system/database-status';
import type { Env } from '../types';
import { runScheduledSessionMaintenance } from './session-maintenance';
import { STUDIO_SCHEMA_VERSION } from '../system/schema-version';

function env(siteMode: string | undefined): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: siteMode,
  };
}

function inspection(state: DatabaseInspection['status']): DatabaseInspection {
  return { status: state, incident: null };
}

describe('scheduled session maintenance policy', () => {
  it.each([
    undefined,
    'invalid',
    'initial',
    'maintenance',
    'recovery',
  ])('does not query D1 in the %s site mode', async (siteMode) => {
    const inspectDatabase = vi.fn();
    const collectExpiredSessions = vi.fn();

    await expect(runScheduledSessionMaintenance(env(siteMode), {
      inspectDatabase,
      collectExpiredSessions,
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'site_mode_not_operational',
    });
    expect(inspectDatabase).not.toHaveBeenCalled();
    expect(collectExpiredSessions).not.toHaveBeenCalled();
  });

  it('skips writes unless the operational database schema is current', async () => {
    const inspectDatabase = vi.fn().mockResolvedValue(inspection({
      state: 'upgrade_required',
      schema_version: 0,
      target_schema_version: STUDIO_SCHEMA_VERSION,
    }));
    const collectExpiredSessions = vi.fn();

    await expect(runScheduledSessionMaintenance(env('operational'), {
      inspectDatabase,
      collectExpiredSessions,
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'database_not_ready',
    });
    expect(collectExpiredSessions).not.toHaveBeenCalled();
  });

  it('collects expired sessions only for a ready operational database', async () => {
    const now = new Date('2026-07-31T18:23:00.000Z');
    const inspectDatabase = vi.fn().mockResolvedValue(inspection({
      state: 'ready',
      schema_version: STUDIO_SCHEMA_VERSION,
      target_schema_version: STUDIO_SCHEMA_VERSION,
    }));
    const collectExpiredSessions = vi.fn().mockResolvedValue({
      cutoff_at_iso: now.toISOString(),
      deleted_rows: 4,
    });
    const collectExpiredWebAuthnChallenges = vi.fn().mockResolvedValue({
      cutoffAtIso: now.toISOString(),
      deletedRows: 2,
    });
    const collectExpiredMediaUploadIntents = vi.fn().mockResolvedValue({
      deletedRows: 3,
    });
    const drainMediaObjectDeletions = vi.fn().mockResolvedValue({
      pendingRows: 2,
      deletedRows: 2,
    });
    const collectExpiredContentAutosaves = vi.fn().mockResolvedValue({
      cutoffAtIso: now.toISOString(),
      deletedRows: 5,
    });
    const collectExpiredAuthRateLimits = vi.fn().mockResolvedValue({ deletedRows: 6 });
    const environment = env('operational');

    await expect(runScheduledSessionMaintenance(environment, {
      inspectDatabase,
      collectExpiredSessions,
      collectExpiredWebAuthnChallenges,
      collectExpiredMediaUploadIntents,
      drainMediaObjectDeletions,
      collectExpiredContentAutosaves,
      collectExpiredAuthRateLimits,
      now,
    })).resolves.toEqual({
      status: 'completed',
      cutoff_at_iso: now.toISOString(),
      deleted_rows: 4,
      deleted_webauthn_challenges: 2,
      deleted_media_upload_intents: 3,
      deleted_media_objects: 2,
      deleted_content_autosaves: 5,
      deleted_auth_rate_limits: 6,
    });
    expect(collectExpiredSessions).toHaveBeenCalledWith({
      db: environment.DB,
      now,
    });
    expect(collectExpiredWebAuthnChallenges).toHaveBeenCalledWith({
      db: environment.DB,
      now,
    });
    expect(collectExpiredMediaUploadIntents).toHaveBeenCalledWith({
      db: environment.DB,
      now,
    });
    expect(drainMediaObjectDeletions).toHaveBeenCalledWith({
      db: environment.DB,
      bucket: undefined,
      now,
    });
    expect(collectExpiredAuthRateLimits).toHaveBeenCalledWith({ db: environment.DB, now });
    expect(collectExpiredContentAutosaves).toHaveBeenCalledWith({
      db: environment.DB,
      now,
    });
  });

  it('turns a D1 status outage back into an operational error', async () => {
    const cause = new Error('D1 status unavailable');
    const inspectDatabase = vi.fn().mockResolvedValue({
      status: { state: 'unavailable' },
      incident: {
        code: 'DATABASE_STATUS_QUERY_FAILED',
        cause,
        metadata: {
          resource: 'DB',
          action: 'inspect_database_status',
        },
      },
    } satisfies DatabaseInspection);

    await expect(runScheduledSessionMaintenance(env('operational'), {
      inspectDatabase,
    })).rejects.toMatchObject({
      code: 'DATABASE_STATUS_QUERY_FAILED',
      originalCause: cause,
    });
  });
});
