import { setAuditActor, userAuditActor } from '../audit/service';
import type { Context } from 'hono';
import {
  hasStudioCapability,
  type StudioCapability,
} from '../../../contracts/authorization';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import {
  clearSessionCookie,
  readSessionCookie,
} from './session-http';
import {
  resolveUserSession,
  type ResolvedSession,
  type ResolveUserSession,
} from './session-repository';

export { hasStudioCapability } from '../../../contracts/authorization';

export async function requireStudioSession(input: {
  context: Context<StudioHonoEnvironment>;
  resolveSession?: ResolveUserSession;
}): Promise<ResolvedSession | Response> {
  const session = await (input.resolveSession ?? resolveUserSession)({
    db: input.context.env.DB,
    cookieValue: readSessionCookie(input.context),
  });
  if (!session) {
    clearSessionCookie(input.context);
    return errorResponse(input.context, 401, 'AUTHENTICATION_REQUIRED');
  }
  setAuditActor(input.context, userAuditActor(session.user));
  return session;
}

export async function requireStudioCapability(input: {
  context: Context<StudioHonoEnvironment>;
  capability: StudioCapability;
  resolveSession?: ResolveUserSession;
}): Promise<ResolvedSession | Response> {
  const session = await requireStudioSession(input);
  if (session instanceof Response) return session;
  if (!hasStudioCapability(session.user.roles, input.capability)) {
    return errorResponse(input.context, 403, 'FORBIDDEN');
  }
  return session;
}

export function capabilityForMfaManagementOperation(
  operation: string,
): StudioCapability | null {
  return operation === 'invite_user'
    || operation === 'reissue_user_invitation'
    || operation === 'reset_user_access'
    || operation === 'change_user_name'
    || operation === 'change_user_role'
    || operation === 'change_user_status'
    || operation === 'cancel_user_invitation'
    || operation === 'delete_user_account'
    ? 'users.manage'
    : null;
}
