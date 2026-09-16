import { describe, expect, it, vi } from 'vitest';
import type { ManagedUser, UserListData } from '../../../contracts/users';
import { createMfaManagementGrant } from '../auth/mfa-crypto';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createUserRoutes } from './routes';

const now = new Date('2026-07-31T12:00:00.000Z');
const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '1'.repeat(32);
const targetId = '2'.repeat(32);
const sessionId = '3'.repeat(32);
const authRevision = '4'.repeat(32);
const csrfToken = 'csrf-token-with-at-least-thirty-two-characters';

const administratorSession = {
  user: {
    id: userId,
    email: 'owner@example.com',
    name: 'Owner',
    roles: ['admin'],
  },
  session: { id: sessionId },
  csrfToken,
  authRevision,
  mfaVerifiedAtIso: now.toISOString(),
} as ResolvedSession;

const invitedUser: ManagedUser = {
  id: targetId,
  email: 'author@example.com',
  name: 'Site Author',
  status: 'pending',
  role: 'author',
  mfa: {
    totp_configured: false,
    webauthn_credentials: 0,
  },
      active_sessions: 0,
      author: null,
  setup: {
    purpose: 'invitation',
    status: 'pending',
    expires_at_iso: '2026-08-01T12:00:00.000Z',
  },
  created_at_iso: now.toISOString(),
  updated_at_iso: now.toISOString(),
};

const userListData: UserListData = {
  items: [invitedUser],
  pagination: {
    page: 2,
    per_page: 25,
    total: 26,
    total_pages: 2,
  },
  status_counts: {
    all: 26,
    pending: 6,
    active: 18,
    inactive: 2,
  },
  summary: {
    total: 26,
    pending: 6,
    active: 18,
    inactive: 2,
    administrators: 2,
  },
};

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_AUTH_SECRET: authSecret,
  };
}

function mutationRequest(path: string, body: unknown) {
  return new Request(`https://studio.local${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function grant(
  operation:
    | 'invite_user'
    | 'reset_user_access'
    | 'change_user_name'
    | 'change_user_role'
    | 'change_user_status'
    | 'cancel_user_invitation'
    | 'delete_user_account',
  target?: string,
) {
  return createMfaManagementGrant({
    authSecret,
    userId,
    sessionId,
    authRevision,
    operation,
    ...(target ? { targetId: target } : {}),
    now,
  });
}

describe('Studio user routes', () => {
  it('denies an authenticated non-administrator before listing users', async () => {
    const listUsers = vi.fn();
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      listUsers,
      now: () => now,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );

    expect(response.status).toBe(403);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('validates and forwards bounded user discovery filters', async () => {
    const listUsers = vi.fn().mockResolvedValue(userListData);
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      listUsers,
      now: () => now,
    });

    const response = await routes.fetch(new Request(
      'https://studio.local/?search=Site+Author&role=author&status=pending&page=2&per_page=25',
    ), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: userListData,
    });
    expect(listUsers).toHaveBeenCalledWith({
      db: expect.anything(),
      query: {
        search: 'Site Author',
        role: 'author',
        status: 'pending',
        page: 2,
        per_page: 25,
      },
      now,
    });
  });

  it('rejects an oversized user-list page before querying D1', async () => {
    const listUsers = vi.fn();
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      listUsers,
      now: () => now,
    });

    const response = await routes.fetch(new Request(
      'https://studio.local/?per_page=101',
    ), env());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('returns the one-time setup URL while persisting only derived material', async () => {
    const issued = await grant('invite_user');
    const createInvitation = vi.fn().mockResolvedValue({
      kind: 'completed',
      user: invitedUser,
    });
    const hashPassword = vi.fn().mockResolvedValue('$argon2id$pending');
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      createInvitation,
      hashPassword,
      createSetupToken: vi.fn().mockResolvedValue({
        id: '5'.repeat(32),
        token: `${'5'.repeat(32)}.${'A'.repeat(43)}`,
        secretDigest: '6'.repeat(64),
      }),
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/invitations', {
      email: invitedUser.email,
      name: invitedUser.name,
      role: invitedUser.role,
      management_token: issued.token,
    }), env());

    expect(response.status).toBe(201);
    const body = await response.json() as {
      success: true;
      data: { setup_url: string };
    };
    expect(body.data.setup_url).toBe(
      `https://studio.local/activate#token=${'5'.repeat(32)}.${'A'.repeat(43)}`,
    );
    expect(hashPassword).toHaveBeenCalledWith(
      `${'5'.repeat(32)}.${'A'.repeat(43)}`,
    );
    expect(createInvitation).toHaveBeenCalledWith(expect.objectContaining({
      secretDigest: '6'.repeat(64),
      pendingPasswordHash: '$argon2id$pending',
    }));
    expect(JSON.stringify(createInvitation.mock.calls)).not.toContain(
      `${'5'.repeat(32)}.${'A'.repeat(43)}`,
    );
  });

  it('rejects a management grant bound to another user target', async () => {
    const wrongGrant = await grant('change_user_role', '7'.repeat(32));
    const updateRole = vi.fn();
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateRole,
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/role', {
      user_id: targetId,
      role: 'editor',
      management_token: wrongGrant.token,
    }), env());

    expect(response.status).toBe(401);
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('updates only the exact user name under a target-bound grant', async () => {
    const issued = await grant('change_user_name', targetId);
    const renamedUser = {
      ...invitedUser,
      name: 'Editorial Author',
      updated_at_iso: '2026-07-31T12:01:00.000Z',
    };
    const updateName = vi.fn().mockResolvedValue({
      kind: 'completed',
      user: renamedUser,
    });
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateName,
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/name', {
      user_id: targetId,
      name: renamedUser.name,
      expected_updated_at_iso: invitedUser.updated_at_iso,
      management_token: issued.token,
    }), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'user_name_updated',
        user: renamedUser,
        revoked_sessions: 0,
        current_session_ended: false,
      },
    });
    expect(updateName).toHaveBeenCalledWith({
      db: expect.anything(),
      userId: targetId,
      name: renamedUser.name,
      expectedUpdatedAtIso: invitedUser.updated_at_iso,
      now,
    });
  });

  it('maps last-administrator protection without changing the account', async () => {
    const issued = await grant('change_user_status', targetId);
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateStatus: vi.fn().mockResolvedValue({ kind: 'last_admin' }),
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/status', {
      user_id: targetId,
      status: 'inactive',
      management_token: issued.token,
    }), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'LAST_ACTIVE_ADMIN_REQUIRED' },
    });
  });

  it('issues a one-hour credential-recovery link after revoking target access', async () => {
    const issued = await grant('reset_user_access', targetId);
    const resetUser: ManagedUser = {
      ...invitedUser,
      status: 'pending',
      setup: {
        purpose: 'credential_recovery',
        status: 'pending',
        expires_at_iso: '2026-07-31T13:00:00.000Z',
      },
    };
    const resetAccess = vi.fn().mockResolvedValue({
      kind: 'completed',
      user: resetUser,
      revokedSessions: 2,
      reissued: false,
    });
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      resetAccess,
      createSetupToken: vi.fn().mockResolvedValue({
        id: '5'.repeat(32),
        token: `${'5'.repeat(32)}.${'A'.repeat(43)}`,
        secretDigest: '6'.repeat(64),
      }),
      createSecurityRevision: () => '7'.repeat(32),
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/access-recovery', {
      user_id: targetId,
      management_token: issued.token,
    }), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: 'credential_recovery_created',
        user: resetUser,
        setup_url:
          `https://studio.local/activate#token=${'5'.repeat(32)}.${'A'.repeat(43)}`,
        expires_at_iso: '2026-07-31T13:00:00.000Z',
      },
    });
    expect(resetAccess).toHaveBeenCalledWith(expect.objectContaining({
      administratorId: userId,
      userId: targetId,
      setupTokenId: '5'.repeat(32),
      secretDigest: '6'.repeat(64),
      nextAuthRevision: '7'.repeat(32),
      expiresAt: new Date('2026-07-31T13:00:00.000Z'),
    }));
  });

  it('does not let an administrator reset their own account through user management', async () => {
    const issued = await grant('reset_user_access', userId);
    const resetAccess = vi.fn();
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      resetAccess,
      now: () => now,
    });

    const response = await routes.fetch(mutationRequest('/access-recovery', {
      user_id: userId,
      management_token: issued.token,
    }), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'USER_STATE_CONFLICT' },
    });
    expect(resetAccess).not.toHaveBeenCalled();
  });

  it('previews and cancels only the exact target invitation', async () => {
    const impact = {
      operation: 'cancel_invitation' as const,
      user: invitedUser,
      effects: {
        post_autosaves: 0,
        page_autosaves: 0,
        media_upload_intents: 1,
      },
    };
    const inspectDeletionImpact = vi.fn().mockResolvedValue({
      kind: 'completed',
      impact,
    });
    const cancelInvitation = vi.fn().mockResolvedValue({ kind: 'completed' });
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      inspectDeletionImpact,
      cancelInvitation,
      createSecurityRevision: () => '7'.repeat(32),
      now: () => now,
    });

    const previewResponse = await routes.fetch(mutationRequest(
      '/deletion-impact',
      { user_id: targetId },
    ), env());
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toEqual({
      success: true,
      data: impact,
    });

    const issued = await grant('cancel_user_invitation', targetId);
    const response = await routes.fetch(mutationRequest(
      '/invitations/cancel',
      {
        user_id: targetId,
        confirmation_email: invitedUser.email,
        management_token: issued.token,
      },
    ), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'invitation_cancelled',
        user_id: targetId,
      },
    });
    expect(cancelInvitation).toHaveBeenCalledWith({
      db: expect.anything(),
      administratorId: userId,
      userId: targetId,
      confirmationEmail: invitedUser.email,
      now,
      createRevision: expect.any(Function),
    });
  });

  it('requires an inactive account and explicit recovery-copy acknowledgement before deletion', async () => {
    const issued = await grant('delete_user_account', targetId);
    const deleteAccount = vi.fn()
      .mockResolvedValueOnce({ kind: 'account_not_inactive' })
      .mockResolvedValueOnce({ kind: 'completed' });
    const routes = createUserRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      deleteAccount,
      now: () => now,
    });
    const requestBody = {
      user_id: targetId,
      confirmation_email: invitedUser.email,
      acknowledge_recovery_copy_deletion: true,
      management_token: issued.token,
    };

    const rejected = await routes.fetch(mutationRequest(
      '/delete',
      requestBody,
    ), env());
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toEqual({
      success: false,
      error: { code: 'USER_ACCOUNT_DELETE_REQUIRES_INACTIVE' },
    });

    const completed = await routes.fetch(mutationRequest(
      '/delete',
      requestBody,
    ), env());
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'user_account_deleted',
        user_id: targetId,
      },
    });

    const missingAcknowledgement = await routes.fetch(mutationRequest(
      '/delete',
      {
        user_id: targetId,
        confirmation_email: invitedUser.email,
        management_token: issued.token,
      },
    ), env());
    expect(missingAcknowledgement.status).toBe(400);
    expect(deleteAccount).toHaveBeenCalledTimes(2);
  });
});
