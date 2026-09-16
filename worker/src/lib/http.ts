import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, Env as HonoEnvironment } from 'hono';
import type { ApiErrorCode, ApiErrorResponse } from '../../../contracts/api';
import type { Env } from '../types';

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
): string {
  const cloudflareIp = c.req.header('CF-Connecting-IP')?.trim();
  if (cloudflareIp) return cloudflareIp;

  const forwardedIp = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwardedIp) return forwardedIp;

  return '127.0.0.1';
}
