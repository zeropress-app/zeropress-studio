import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  commentBulkModerationRequestSchema,
  commentBulkModerationSuccessSchema,
  commentDeleteSuccessSchema,
  commentIdSchema,
  commentListQuerySchema,
  commentListSuccessSchema,
  commentMutationSuccessSchema,
  commentTargetOptionsQuerySchema,
  commentTargetOptionsSuccessSchema,
  createStudioCommentRequestSchema,
  deleteCommentRequestSchema,
  updateCommentRequestSchema,
} from '../../../contracts/comments';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import { requireEdgeDatabase } from './edge-db';
import {
  bulkModerateManagedComments,
  createStudioComment,
  deleteManagedComment,
  listCommentTargetOptions,
  listManagedComments,
  updateManagedComment,
} from './management-repository';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';

const COMMENT_MUTATION_BODY_LIMIT = 16 * 1024;

export type CommentManagementRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listComments?: typeof listManagedComments;
  listTargets?: typeof listCommentTargetOptions;
  createComment?: typeof createStudioComment;
  bulkModerate?: typeof bulkModerateManagedComments;
  updateComment?: typeof updateManagedComment;
  deleteComment?: typeof deleteManagedComment;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

export function createCommentManagementRoutes(
  dependencies: CommentManagementRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const listComments = dependencies.listComments ?? listManagedComments;
  const listTargets = dependencies.listTargets ?? listCommentTargetOptions;
  const createComment = dependencies.createComment ?? createStudioComment;
  const bulkModerate = dependencies.bulkModerate
    ?? bulkModerateManagedComments;
  const updateComment = dependencies.updateComment ?? updateManagedComment;
  const deleteComment = dependencies.deleteComment ?? deleteManagedComment;
  const currentTime = dependencies.now ?? (() => new Date());

  async function requireModerator(c: Context<StudioHonoEnvironment>) {
    const session = await requireStudioCapability({
      context: c,
      capability: 'comments.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    return await requireEdgeIntegrationReady(
      c,
      dependencies.readEdgeIntegrationMode,
      dependencies.inspectEdgeDatabaseRuntime,
    ) ?? session;
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireModerator(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    const session = await requireModerator(c);
    if (session instanceof Response) return session;
    const query = commentListQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    );
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listComments({
      db: c.env.DB,
      edgeDb: requireEdgeDatabase(c.env),
      query: query.data,
    });
    return c.json(commentListSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/targets', async (c) => {
    const session = await requireModerator(c);
    if (session instanceof Response) return session;
    const query = commentTargetOptionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const items = await listTargets({
      db: c.env.DB,
      edgeDb: requireEdgeDatabase(c.env),
      query: query.data,
    });
    return c.json(commentTargetOptionsSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.post('/', bodyLimit({
    maxSize: COMMENT_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createStudioCommentRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await createComment({
      db: c.env.DB,
      edgeDb: requireEdgeDatabase(c.env),
      author: session.user,
      comment: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'target_not_available') {
      return errorResponse(c, 409, 'COMMENT_TARGET_NOT_AVAILABLE');
    }
    if (result.kind === 'reply_not_available') {
      return errorResponse(c, 409, 'COMMENT_REPLY_NOT_AVAILABLE');
    }
    if (result.kind === 'state_conflict') {
      return errorResponse(c, 409, 'COMMENT_CREATION_CONFLICT');
    }
    return c.json(commentMutationSuccessSchema.parse({
      success: true,
      data: result.comment,
    }), 201);
  });

  routes.post('/bulk-moderation', bodyLimit({
    maxSize: COMMENT_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = commentBulkModerationRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await bulkModerate({
      edgeDb: requireEdgeDatabase(c.env),
      request: parsed.data,
      now: currentTime(),
    });
    return c.json(commentBulkModerationSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.put('/:id', bodyLimit({
    maxSize: COMMENT_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const id = commentIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateCommentRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await updateComment({
      db: c.env.DB,
      edgeDb: requireEdgeDatabase(c.env),
      id: id.data,
      update: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'COMMENT_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'COMMENT_REVISION_CONFLICT');
    }
    return c.json(commentMutationSuccessSchema.parse({
      success: true,
      data: result.comment,
    }));
  });

  routes.delete('/:id', bodyLimit({
    maxSize: COMMENT_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const id = commentIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteCommentRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await deleteComment({
      db: c.env.DB,
      edgeDb: requireEdgeDatabase(c.env),
      id: id.data,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'COMMENT_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'COMMENT_REVISION_CONFLICT');
    }
    return c.json(commentDeleteSuccessSchema.parse({
      success: true,
      data: result.kind === 'moved_to_trash'
        ? { status: result.kind, comment: result.comment }
        : {
            status: result.kind,
            deleted_count: result.deletedCount,
          },
    }));
  });

  return routes;
}
