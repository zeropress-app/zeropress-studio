import type { Context } from 'hono';
import type { AiPostDraftRequest } from '../../../contracts/ai-post-draft';
import { aiPostDraftSuccessSchema } from '../../../contracts/ai-post-draft';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  AiPostDraftProviderError,
  AiPostDraftResponseInvalidError,
  AiPostDraftSourceEmptyError,
  generateAiPostDraft,
  prepareAiPostDraftSource,
} from './post-draft-service';
import { requireAiGenerationCapacity } from './request-boundary';

export type GenerateAiPostDraft = typeof generateAiPostDraft;

export async function handleAiPostDraftRequest(input: {
  context: Context<StudioHonoEnvironment>;
  request: AiPostDraftRequest;
  userId: string;
  generate?: GenerateAiPostDraft;
}): Promise<Response> {
  const { context: c } = input;
  let source;
  try {
    source = prepareAiPostDraftSource(input.request);
  } catch (error) {
    if (error instanceof AiPostDraftSourceEmptyError) {
      return errorResponse(c, 400, 'AI_POST_DRAFT_SOURCE_EMPTY');
    }
    throw error;
  }

  const ai = await requireAiGenerationCapacity({
    context: c,
    userId: input.userId,
    action: 'generate_post_draft',
    limiterAction: 'limit_post_draft_generation',
    targetType: 'post',
  });
  if (ai instanceof Response) return ai;

  try {
    const candidate = await (input.generate ?? generateAiPostDraft)({
      ai,
      source,
    });
    return c.json(aiPostDraftSuccessSchema.parse({
      success: true,
      data: candidate,
    }));
  } catch (error) {
    if (error instanceof AiPostDraftResponseInvalidError) {
      logOperationalFailure('AI_POST_DRAFT_RESPONSE_INVALID', {
        metadata: {
          resource: 'AI',
          action: 'generate_post_draft',
          target_type: 'post',
        },
      });
      return errorResponse(c, 502, 'AI_POST_DRAFT_RESPONSE_INVALID');
    }
    const reason = error instanceof AiPostDraftProviderError
      ? error.reason
      : 'request_failed';
    logOperationalFailure('AI_POST_DRAFT_GENERATION_FAILED', {
      metadata: {
        resource: 'AI',
        action: 'generate_post_draft',
        target_type: 'post',
        reason,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
}
