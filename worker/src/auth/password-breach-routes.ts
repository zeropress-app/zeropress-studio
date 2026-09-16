import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  passwordBreachCheckRequestSchema,
  passwordBreachCheckSuccessSchema,
} from '../../../contracts/password-breach';
import { errorResponse, getClientIp } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { readJsonBody } from './auth-route-utils';
import {
  checkPasswordBreach,
  type CheckPasswordBreach,
} from './password-breach-service';
import { isSameOriginMutation } from './session-http';

const PASSWORD_CHECK_BODY_LIMIT = 2 * 1024;

export function createPasswordBreachRoutes(dependencies: {
  checkBreach?: CheckPasswordBreach;
} = {}) {
  const routes = new Hono<StudioHonoEnvironment>();
  const executeCheck = dependencies.checkBreach ?? checkPasswordBreach;

  routes.post('/check', bodyLimit({
    maxSize: PASSWORD_CHECK_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    let rateLimit: { success: boolean };
    try {
      rateLimit = await c.env.AUTH_ROUTE_RATE_LIMITER.limit({
        key: `password-check:${getClientIp(c)}`,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            resource: 'AUTH_ROUTE_RATE_LIMITER',
            action: 'limit_password_breach_check',
          },
        },
      );
    }
    if (!rateLimit.success) {
      c.header('Retry-After', '60');
      return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
    }

    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = passwordBreachCheckRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    return c.json(passwordBreachCheckSuccessSchema.parse({
      success: true,
      data: await executeCheck({
        password: parsed.data.password,
        env: c.env,
      }),
    }));
  });

  return routes;
}
