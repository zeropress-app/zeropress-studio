import type { Context } from 'hono';
import {
  aiPageDraftSuccessSchema,
  type AiPageDraftRequest,
} from '../../../contracts/ai-page-draft';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  AiPageDraftProviderError,
  AiPageDraftResponseInvalidError,
  AiPageDraftSourceEmptyError,
  generateAiPageDraft,
  prepareAiPageDraftSource,
} from './page-draft-service';
import { requireAiGenerationCapacity } from './request-boundary';

export type GenerateAiPageDraft = typeof generateAiPageDraft;

export async function handleAiPageDraftRequest(input: {
  context: Context<StudioHonoEnvironment>;
  request: AiPageDraftRequest;
  userId: string;
  generate?: GenerateAiPageDraft;
}): Promise<Response> {
  const { context: c } = input;
  let source;
  try {
    source = prepareAiPageDraftSource(input.request);
  } catch (error) {
    if (error instanceof AiPageDraftSourceEmptyError) {
      return errorResponse(c, 400, 'AI_PAGE_DRAFT_SOURCE_EMPTY');
    }
    throw error;
  }

  const ai = await requireAiGenerationCapacity({
    context: c,
    userId: input.userId,
    action: 'generate_page_draft',
    limiterAction: 'limit_page_draft_generation',
    targetType: 'page',
  });
  if (ai instanceof Response) return ai;

  try {
    const candidate = await (input.generate ?? generateAiPageDraft)({
      ai,
      source,
    });
    return c.json(aiPageDraftSuccessSchema.parse({
      success: true,
      data: candidate,
    }));
  } catch (error) {
    if (error instanceof AiPageDraftResponseInvalidError) {
      logOperationalFailure('AI_PAGE_DRAFT_RESPONSE_INVALID', {
        metadata: {
          resource: 'AI',
          action: 'generate_page_draft',
          target_type: 'page',
        },
      });
      return errorResponse(c, 502, 'AI_PAGE_DRAFT_RESPONSE_INVALID');
    }
    const reason = error instanceof AiPageDraftProviderError
      ? error.reason
      : 'request_failed';
    logOperationalFailure('AI_PAGE_DRAFT_GENERATION_FAILED', {
      metadata: {
        resource: 'AI',
        action: 'generate_page_draft',
        target_type: 'page',
        reason,
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }
}
