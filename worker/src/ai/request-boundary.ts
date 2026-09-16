import type { Context } from 'hono';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';

export async function requireAiGenerationCapacity(input: {
  context: Context<StudioHonoEnvironment>;
  userId: string;
  action:
    | 'generate_excerpt'
    | 'generate_post_draft'
    | 'generate_post_edit'
    | 'generate_page_draft'
    | 'generate_image';
  limiterAction:
    | 'limit_excerpt_generation'
    | 'limit_post_draft_generation'
    | 'limit_post_edit_generation'
    | 'limit_page_draft_generation'
    | 'limit_image_generation';
  targetType: 'post' | 'page' | 'media';
}): Promise<Ai | Response> {
  const { context: c } = input;
  if (!c.env.AI) {
    logOperationalFailure('AI_BINDING_NOT_CONFIGURED', {
      metadata: {
        resource: 'AI',
        action: input.action,
        target_type: input.targetType,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
  if (!c.env.AI_REQUEST_RATE_LIMITER) {
    logOperationalFailure('AI_REQUEST_RATE_LIMITER_NOT_AVAILABLE', {
      metadata: {
        resource: 'AI_REQUEST_RATE_LIMITER',
        action: input.limiterAction,
        target_type: input.targetType,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }

  let allowed: boolean;
  try {
    // All Studio AI generation features intentionally share one user quota.
    allowed = (await c.env.AI_REQUEST_RATE_LIMITER.limit({
      key: input.userId,
    })).success;
  } catch {
    logOperationalFailure('AI_REQUEST_RATE_LIMITER_NOT_AVAILABLE', {
      metadata: {
        resource: 'AI_REQUEST_RATE_LIMITER',
        action: input.limiterAction,
        target_type: input.targetType,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
  return allowed
    ? c.env.AI
    : errorResponse(c, 429, 'AI_REQUEST_RATE_LIMITED');
}
