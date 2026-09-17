import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, Env as HonoEnvironment } from 'hono';
import type { ApiErrorCode, ApiErrorResponse } from '../../../contracts/api';
import type { Env } from '../types';
import { resolveTrustedClientIp } from './client-ip';
import { StudioOperationalError } from './operational-error';

export function errorResponse<E extends HonoEnvironment & { Bindings: Env }>(
  c: Context<E>,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
) {
  return c.json<ApiErrorResponse>({
    success: false,
    error: { code },
  }, status);
}

export function getClientIp<E extends HonoEnvironment & { Bindings: Env }>(
  c: Context<E>,
): string | null {
  return resolveTrustedClientIp(c.req.raw);
}

export function requireClientIp<E extends HonoEnvironment & { Bindings: Env }>(
  c: Context<E>,
): string {
  const clientIp = getClientIp(c);
  if (clientIp === null) {
    throw new StudioOperationalError('CLIENT_IP_NOT_AVAILABLE', {
      metadata: { component: 'request', action: 'resolve_client_ip' },
    });
  }
  return clientIp;
}
