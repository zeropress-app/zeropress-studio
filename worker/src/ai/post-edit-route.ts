import type { Context } from 'hono';
import {
  aiPostEditSuccessSchema,
  type AiPostEditRequest,
} from '../../../contracts/ai-post-edit';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  AiPostEditProviderError,
  AiPostEditResponseInvalidError,
  AiPostEditSelectionEmptyError,
  AiPostEditSelectionUnsupportedError,
  generateAiPostEdit,
  prepareAiPostEditSource,
} from './post-edit-service';
import { requireAiGenerationCapacity } from './request-boundary';

export type GenerateAiPostEdit = typeof generateAiPostEdit;

export async function handleAiPostEditRequest(input: {
  context: Context<StudioHonoEnvironment>;
  request: AiPostEditRequest;
  userId: string;
  postId: string;
  generate?: GenerateAiPostEdit;
}): Promise<Response> {
  const { context: c } = input;
  let source;
  try {
    source = prepareAiPostEditSource(input.request);
  } catch (error) {
    if (error instanceof AiPostEditSelectionEmptyError) {
      return errorResponse(c, 400, 'AI_POST_EDIT_SELECTION_EMPTY');
    }
    if (error instanceof AiPostEditSelectionUnsupportedError) {
      return errorResponse(c, 400, 'AI_POST_EDIT_SELECTION_UNSUPPORTED');
    }
    throw error;
  }

  const ai = await requireAiGenerationCapacity({
    context: c,
    userId: input.userId,
    action: 'generate_post_edit',
    limiterAction: 'limit_post_edit_generation',
    targetType: 'post',
  });
  if (ai instanceof Response) return ai;

  try {
    const replacement = await (input.generate ?? generateAiPostEdit)({
      ai,
      source,
    });
    return c.json(aiPostEditSuccessSchema.parse({
      success: true,
      data: { replacement },
    }));
  } catch (error) {
    if (error instanceof AiPostEditResponseInvalidError) {
      logOperationalFailure('AI_POST_EDIT_RESPONSE_INVALID', {
        metadata: {
          resource: 'AI',
          action: 'generate_post_edit',
          target_type: 'post',
          post_id: input.postId,
        },
      });
      return errorResponse(c, 502, 'AI_POST_EDIT_RESPONSE_INVALID');
    }
    const reason = error instanceof AiPostEditProviderError
      ? error.reason
      : 'request_failed';
    logOperationalFailure('AI_POST_EDIT_GENERATION_FAILED', {
      metadata: {
        resource: 'AI',
        action: 'generate_post_edit',
        target_type: 'post',
        post_id: input.postId,
        reason,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
}
