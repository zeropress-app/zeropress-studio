import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  cancelUserInvitationRequestSchema,
  createUserInvitationRequestSchema,
  deleteUserAccountRequestSchema,
  destructiveUserMutationSuccessSchema,
  inspectUserDeletionImpactRequestSchema,
  reissueUserInvitationRequestSchema,
  resetUserAccessRequestSchema,
  updateUserNameRequestSchema,
  updateUserRoleRequestSchema,
  updateUserStatusRequestSchema,
  userDeletionImpactSuccessSchema,
  userListQuerySchema,
  userSetupIssuedSuccessSchema,
  userListSuccessSchema,
  userMutationSuccessSchema,
} from '../../../contracts/users';
import {
  applyNativeAuthRateLimit,
  readAuthSecret,
  readJsonBody,
} from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import { openMfaManagementGrant } from '../auth/mfa-crypto';
import { hashPassword } from '../auth/password';
import {
  clearSessionCookie,
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type {
  ResolvedSession,
  ResolveUserSession,
} from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  createUserSetupToken,
  createUserSecurityRevision,
  USER_CREDENTIAL_RECOVERY_TTL_MS,
  USER_INVITATION_TTL_MS,
} from './setup-token-crypto';
import {
  cancelManagedUserInvitation,
  createManagedUserInvitation,
  deleteInactiveManagedUserAccount,
  inspectManagedUserDeletionImpact,
  listManagedUsers,
  reissueManagedUserInvitation,
  resetManagedUserAccess,
  updateManagedUserName,
  updateManagedUserRole,
  updateManagedUserStatus,
} from './user-repository';

const USER_MANAGEMENT_BODY_LIMIT = 32 * 1024;

type UserRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listUsers?: typeof listManagedUsers;
  createInvitation?: typeof createManagedUserInvitation;
  reissueInvitation?: typeof reissueManagedUserInvitation;
  resetAccess?: typeof resetManagedUserAccess;
  updateName?: typeof updateManagedUserName;
  updateRole?: typeof updateManagedUserRole;
  updateStatus?: typeof updateManagedUserStatus;
  inspectDeletionImpact?: typeof inspectManagedUserDeletionImpact;
  cancelInvitation?: typeof cancelManagedUserInvitation;
  deleteAccount?: typeof deleteInactiveManagedUserAccount;
  hashPassword?: typeof hashPassword;
  createSetupToken?: typeof createUserSetupToken;
  createSecurityRevision?: () => string;
  now?: () => Date;
};

type UserManagementOperation =
  | 'invite_user'
  | 'reissue_user_invitation'
  | 'reset_user_access'
  | 'change_user_name'
  | 'change_user_role'
  | 'change_user_status'
  | 'cancel_user_invitation'
  | 'delete_user_account';

function setupUrl(requestUrl: string, token: string): string {
  const url = new URL('/activate', requestUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

async function createSetupMaterialSafely(
  createToken: typeof createUserSetupToken,
) {
  try {
    return await createToken();
  } catch (error) {
    throw new StudioOperationalError(
      'USER_SETUP_CRYPTO_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'create_user_setup_token',
        },
      },
    );
  }
}

export function createUserRoutes(
  dependencies: UserRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const currentTime = dependencies.now ?? (() => new Date());
  const resolveSession = dependencies.resolveSession;
  const listUsers = dependencies.listUsers ?? listManagedUsers;
  const createInvitation = dependencies.createInvitation
    ?? createManagedUserInvitation;
  const reissueInvitation = dependencies.reissueInvitation
    ?? reissueManagedUserInvitation;
  const resetAccess = dependencies.resetAccess ?? resetManagedUserAccess;
  const updateName = dependencies.updateName ?? updateManagedUserName;
  const updateRole = dependencies.updateRole ?? updateManagedUserRole;
  const updateStatus = dependencies.updateStatus ?? updateManagedUserStatus;
  const inspectDeletionImpact = dependencies.inspectDeletionImpact
    ?? inspectManagedUserDeletionImpact;
  const cancelInvitation = dependencies.cancelInvitation
    ?? cancelManagedUserInvitation;
  const deleteAccount = dependencies.deleteAccount
    ?? deleteInactiveManagedUserAccount;
  const hashPendingPassword = dependencies.hashPassword ?? hashPassword;
  const createSetupToken = dependencies.createSetupToken
    ?? createUserSetupToken;
  const createSecurityRevision = dependencies.createSecurityRevision
    ?? createUserSecurityRevision;

  async function requireAdministrator(
    c: Context<StudioHonoEnvironment>,
  ) {
    return requireStudioCapability({
      context: c,
      capability: 'users.manage',
      resolveSession,
    });
  }

  async function authorizeMutation(input: {
    c: Context<StudioHonoEnvironment>;
    operation: UserManagementOperation;
    managementToken: string;
    targetId?: string;
  }): Promise<ResolvedSession | Response> {
    const session = await requireAdministrator(input.c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(input.c, session.csrfToken)) {
      return errorResponse(input.c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const authSecret = readAuthSecret(input.c);
    if (authSecret instanceof Response) return authSecret;
    const grant = await openMfaManagementGrant({
      authSecret,
      token: input.managementToken,
      expectedOperation: input.operation,
      expectedTargetId: input.targetId,
      now: currentTime(),
    });
    if (
      !grant
      || grant.userId !== session.user.id
      || grant.sessionId !== session.session.id
      || grant.authRevision !== session.authRevision
    ) {
      return errorResponse(
        input.c,
        401,
        'MFA_MANAGEMENT_CHALLENGE_INVALID',
      );
    }
    return session;
  }

  routes.get('/', async (c) => {
    const session = await requireAdministrator(c);
    if (session instanceof Response) return session;
    const query = userListQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listUsers({
      db: c.env.DB,
      query: query.data,
      now: currentTime(),
    });
    return c.json(userListSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.use('*', async (c, next) => {
    if (c.req.method === 'GET') {
      await next();
      return;
    }
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    await next();
  });

  routes.post('/deletion-impact', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = inspectUserDeletionImpactRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireAdministrator(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const result = await inspectDeletionImpact({
      db: c.env.DB,
      userId: parsed.data.user_id,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'account_not_inactive') {
      return errorResponse(
        c,
        409,
        'USER_ACCOUNT_DELETE_REQUIRES_INACTIVE',
      );
    }
    return c.json(userDeletionImpactSuccessSchema.parse({
      success: true,
      data: result.impact,
    }));
  });

  routes.post('/invitations', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createUserInvitationRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'invite_user',
      managementToken: parsed.data.management_token,
    });
    if (session instanceof Response) return session;
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    const material = await createSetupMaterialSafely(
      createSetupToken,
    );
    let pendingPasswordHash: string;
    try {
      pendingPasswordHash = await hashPendingPassword(material.token);
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_PASSWORD_HASHING_FAILED',
        {
          cause: error,
          metadata: {
            component: 'argon2id',
            action: 'hash_pending_user_password',
          },
        },
      );
    }
    const now = currentTime();
    const expiresAt = new Date(now.getTime() + USER_INVITATION_TTL_MS);
    const result = await createInvitation({
      db: c.env.DB,
      administratorId: session.user.id,
      email: parsed.data.email,
      name: parsed.data.name,
      role: parsed.data.role,
      pendingPasswordHash,
      setupTokenId: material.id,
      secretDigest: material.secretDigest,
      now,
      expiresAt,
    });
    if (result.kind === 'email_conflict') {
      return errorResponse(c, 409, 'USER_EMAIL_CONFLICT');
    }
    return c.json(userSetupIssuedSuccessSchema.parse({
      success: true,
      data: {
        status: 'invitation_created',
        user: result.user,
        setup_url: setupUrl(c.req.url, material.token),
        expires_at_iso: expiresAt.toISOString(),
      },
    }), 201);
  });

  routes.post('/invitations/reissue', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = reissueUserInvitationRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'reissue_user_invitation',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    const material = await createSetupMaterialSafely(
      createSetupToken,
    );
    const now = currentTime();
    const expiresAt = new Date(now.getTime() + USER_INVITATION_TTL_MS);
    const result = await reissueInvitation({
      db: c.env.DB,
      administratorId: session.user.id,
      userId: parsed.data.user_id,
      setupTokenId: material.id,
      secretDigest: material.secretDigest,
      expiresAt,
      nextAuthRevision: createSecurityRevision(),
      now,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    return c.json(userSetupIssuedSuccessSchema.parse({
      success: true,
      data: {
        status: 'invitation_reissued',
        user: result.user,
        setup_url: setupUrl(c.req.url, material.token),
        expires_at_iso: expiresAt.toISOString(),
      },
    }));
  });

  routes.post('/invitations/cancel', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = cancelUserInvitationRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'cancel_user_invitation',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    if (session.user.id === parsed.data.user_id) {
      return errorResponse(c, 409, 'CURRENT_USER_DELETE_FORBIDDEN');
    }
    const limited = await applyNativeAuthRateLimit(c, 'limit_mfa_route');
    if (limited) return limited;
    const result = await cancelInvitation({
      db: c.env.DB,
      administratorId: session.user.id,
      userId: parsed.data.user_id,
      confirmationEmail: parsed.data.confirmation_email,
      now: currentTime(),
      createRevision: createSecurityRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'current_user') {
      return errorResponse(c, 409, 'CURRENT_USER_DELETE_FORBIDDEN');
    }
    if (result.kind === 'confirmation_mismatch') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (result.kind !== 'completed') {
      return errorResponse(c, 409, 'USER_INVITATION_NOT_CANCELLABLE');
    }
    return c.json(destructiveUserMutationSuccessSchema.parse({
      success: true,
      data: {
        status: 'invitation_cancelled',
        user_id: parsed.data.user_id,
      },
    }));
  });

  routes.post('/delete', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteUserAccountRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'delete_user_account',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    if (session.user.id === parsed.data.user_id) {
      return errorResponse(c, 409, 'CURRENT_USER_DELETE_FORBIDDEN');
    }
    const limited = await applyNativeAuthRateLimit(c, 'limit_mfa_route');
    if (limited) return limited;
    const result = await deleteAccount({
      db: c.env.DB,
      administratorId: session.user.id,
      userId: parsed.data.user_id,
      confirmationEmail: parsed.data.confirmation_email,
      now: currentTime(),
      createRevision: createSecurityRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'current_user') {
      return errorResponse(c, 409, 'CURRENT_USER_DELETE_FORBIDDEN');
    }
    if (result.kind === 'confirmation_mismatch') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (result.kind !== 'completed') {
      return errorResponse(
        c,
        409,
        'USER_ACCOUNT_DELETE_REQUIRES_INACTIVE',
      );
    }
    return c.json(destructiveUserMutationSuccessSchema.parse({
      success: true,
      data: {
        status: 'user_account_deleted',
        user_id: parsed.data.user_id,
      },
    }));
  });

  routes.post('/access-recovery', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = resetUserAccessRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'reset_user_access',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    if (session.user.id === parsed.data.user_id) {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    const material = await createSetupMaterialSafely(createSetupToken);
    const now = currentTime();
    const expiresAt = new Date(
      now.getTime() + USER_CREDENTIAL_RECOVERY_TTL_MS,
    );
    const result = await resetAccess({
      db: c.env.DB,
      administratorId: session.user.id,
      userId: parsed.data.user_id,
      setupTokenId: material.id,
      secretDigest: material.secretDigest,
      expiresAt,
      nextAuthRevision: createSecurityRevision(),
      now,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'last_admin') {
      return errorResponse(c, 409, 'LAST_ACTIVE_ADMIN_REQUIRED');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    return c.json(userSetupIssuedSuccessSchema.parse({
      success: true,
      data: {
        status: result.reissued
          ? 'credential_recovery_reissued'
          : 'credential_recovery_created',
        user: result.user,
        setup_url: setupUrl(c.req.url, material.token),
        expires_at_iso: expiresAt.toISOString(),
      },
    }));
  });

  routes.post('/name', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateUserNameRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'change_user_name',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    const limited = await applyNativeAuthRateLimit(c, 'limit_mfa_route');
    if (limited) return limited;
    const result = await updateName({
      db: c.env.DB,
      userId: parsed.data.user_id,
      name: parsed.data.name,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    return c.json(userMutationSuccessSchema.parse({
      success: true,
      data: {
        status: 'user_name_updated',
        user: result.user,
        revoked_sessions: 0,
        current_session_ended: false,
      },
    }));
  });

  routes.post('/role', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateUserRoleRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'change_user_role',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    const result = await updateRole({
      db: c.env.DB,
      userId: parsed.data.user_id,
      role: parsed.data.role,
      nextAuthRevision: createSecurityRevision(),
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'last_admin') {
      return errorResponse(c, 409, 'LAST_ACTIVE_ADMIN_REQUIRED');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    const currentSessionEnded = session.user.id === parsed.data.user_id
      && result.revokedSessions > 0;
    if (currentSessionEnded) clearSessionCookie(c);
    return c.json(userMutationSuccessSchema.parse({
      success: true,
      data: {
        status: 'user_role_updated',
        user: result.user,
        revoked_sessions: result.revokedSessions,
        current_session_ended: currentSessionEnded,
      },
    }));
  });

  routes.post('/status', bodyLimit({
    maxSize: USER_MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateUserStatusRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation({
      c,
      operation: 'change_user_status',
      managementToken: parsed.data.management_token,
      targetId: parsed.data.user_id,
    });
    if (session instanceof Response) return session;
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    const result = await updateStatus({
      db: c.env.DB,
      userId: parsed.data.user_id,
      status: parsed.data.status,
      nextAuthRevision: createSecurityRevision(),
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'last_admin') {
      return errorResponse(c, 409, 'LAST_ACTIVE_ADMIN_REQUIRED');
    }
    if (result.kind === 'setup_required') {
      return errorResponse(c, 409, 'USER_SETUP_REQUIRED');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'USER_STATE_CONFLICT');
    }
    const currentSessionEnded = session.user.id === parsed.data.user_id
      && result.revokedSessions > 0;
    if (currentSessionEnded) clearSessionCookie(c);
    return c.json(userMutationSuccessSchema.parse({
      success: true,
      data: {
        status: 'user_status_updated',
        user: result.user,
        revoked_sessions: result.revokedSessions,
        current_session_ended: currentSessionEnded,
      },
    }));
  });

  return routes;
}
