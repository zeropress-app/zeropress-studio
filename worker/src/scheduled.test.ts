import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleScheduledEdgeProjectionMaintenance,
  handleScheduledSessionMaintenance,
} from './index';
import { StudioOperationalError } from './lib/operational-error';
import type { Env } from './types';

const env = {} as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduled Worker handler', () => {
  it('logs a cataloged summary only when rows were deleted', async () => {
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const runMaintenance = vi.fn().mockResolvedValue({
      status: 'completed',
      cutoff_at_iso: '2026-07-31T18:23:00.000Z',
      deleted_rows: 7,
      deleted_webauthn_challenges: 0,
    });

    await handleScheduledSessionMaintenance(env, runMaintenance);

    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Expired Studio sessions deleted',
      $zeropress: {
        code: 'AUTH_SESSION_GARBAGE_COLLECTION_COMPLETED',
        resource: 'DB',
        action: 'garbage_collect_sessions',
        cutoff_at_iso: '2026-07-31T18:23:00.000Z',
        deleted_rows: 7,
      },
    });
  });

  it('logs WebAuthn challenge cleanup separately from session cleanup', async () => {
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const runMaintenance = vi.fn().mockResolvedValue({
      status: 'completed',
      cutoff_at_iso: '2026-07-31T18:23:00.000Z',
      deleted_rows: 0,
      deleted_webauthn_challenges: 3,
    });

    await handleScheduledSessionMaintenance(env, runMaintenance);

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Expired Studio WebAuthn challenges deleted',
      $zeropress: {
        code: 'AUTH_WEBAUTHN_CHALLENGE_GARBAGE_COLLECTION_COMPLETED',
        resource: 'DB',
        action: 'garbage_collect_webauthn_challenges',
        cutoff_at_iso: '2026-07-31T18:23:00.000Z',
        deleted_rows: 3,
      },
    });
  });

  it('keeps skipped and zero-row invocations silent', async () => {
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handleScheduledSessionMaintenance(
      env,
      vi.fn().mockResolvedValue({
        status: 'skipped',
        reason: 'site_mode_not_operational',
      }),
    );
    await handleScheduledSessionMaintenance(
      env,
      vi.fn().mockResolvedValue({
        status: 'completed',
        cutoff_at_iso: '2026-07-31T18:23:00.000Z',
        deleted_rows: 0,
        deleted_webauthn_challenges: 0,
      }),
    );

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('logs a classified failure once and rethrows it', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new StudioOperationalError(
      'AUTH_SESSION_GARBAGE_COLLECTION_FAILED',
      {
        cause: new Error('D1 cleanup unavailable'),
        metadata: {
          resource: 'DB',
          action: 'garbage_collect_sessions',
        },
      },
    );

    await expect(handleScheduledSessionMaintenance(
      env,
      vi.fn().mockRejectedValue(error),
    )).rejects.toBe(error);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Expired Studio session cleanup failed',
      $zeropress: {
        code: 'AUTH_SESSION_GARBAGE_COLLECTION_FAILED',
        resource: 'DB',
        action: 'garbage_collect_sessions',
        trigger: 'scheduled',
        errorType: 'Error',
        guidance: 'Verify the DB binding, D1 availability, and the current Studio sessions schema. Restore service and allow the next daily scheduled cleanup to retry.',
      },
    });
  });

  it('contains Edge projection failures without failing Studio maintenance', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const failure = new StudioOperationalError(
      'COMMENT_TARGET_OUTBOX_DRAIN_FAILED',
      {
        cause: new Error('Edge D1 unavailable'),
        metadata: {
          resource: 'EDGE_DB',
          related_resource: 'DB',
          action: 'apply_comment_target_outbox_events',
        },
      },
    );
    const drain = vi.fn().mockRejectedValue(failure);

    await expect(handleScheduledEdgeProjectionMaintenance(env, drain))
      .resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledWith({ env, limit: 250 });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Studio comment-target projection drain failed',
      $zeropress: expect.objectContaining({
        code: 'COMMENT_TARGET_OUTBOX_DRAIN_FAILED',
        trigger: 'scheduled',
      }),
    }));
  });
});
