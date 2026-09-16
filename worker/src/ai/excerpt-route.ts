import type { Context } from 'hono';
import type { AiExcerptRequest } from '../../../contracts/ai-excerpt';
import { aiExcerptSuccessSchema } from '../../../contracts/ai-excerpt';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  AiExcerptProviderError,
  AiExcerptResponseInvalidError,
  AiExcerptSourceEmptyError,
  generateAiExcerpt,
  prepareAiExcerptSource,
} from './excerpt-service';
import { requireAiGenerationCapacity } from './request-boundary';

export type AiExcerptTargetType = 'post' | 'page';
export type GenerateAiExcerpt = typeof generateAiExcerpt;

export async function handleAiExcerptRequest(input: {
  context: Context<StudioHonoEnvironment>;
  request: AiExcerptRequest;
  userId: string;
  targetType: AiExcerptTargetType;
  generate?: GenerateAiExcerpt;
}): Promise<Response> {
  const { context: c } = input;
  let source;
  try {
    source = prepareAiExcerptSource(input.request);
  } catch (error) {
    if (error instanceof AiExcerptSourceEmptyError) {
      return errorResponse(c, 400, 'AI_EXCERPT_SOURCE_EMPTY');
    }
    throw error;
  }

  const ai = await requireAiGenerationCapacity({
    context: c,
    userId: input.userId,
    action: 'generate_excerpt',
    limiterAction: 'limit_excerpt_generation',
    targetType: input.targetType,
  });
  if (ai instanceof Response) return ai;

  try {
    const result = await (input.generate ?? generateAiExcerpt)({
      ai,
      source,
    });
    return c.json(aiExcerptSuccessSchema.parse({
      success: true,
      data: {
        excerpt: result.excerpt,
        source_truncated: result.sourceTruncated,
      },
    }));
  } catch (error) {
    if (error instanceof AiExcerptResponseInvalidError) {
      logOperationalFailure('AI_EXCERPT_RESPONSE_INVALID', {
        metadata: {
          resource: 'AI',
          action: 'generate_excerpt',
          target_type: input.targetType,
        },
      });
      return errorResponse(c, 502, 'AI_EXCERPT_RESPONSE_INVALID');
    }
    const reason = error instanceof AiExcerptProviderError
      ? error.reason
      : 'request_failed';
    logOperationalFailure('AI_EXCERPT_GENERATION_FAILED', {
      metadata: {
        resource: 'AI',
        action: 'generate_excerpt',
        target_type: input.targetType,
        reason,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
}
