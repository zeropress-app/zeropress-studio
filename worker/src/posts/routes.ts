import { recordAudit, auditContentChange, auditBulk, beginAudit, beginContentAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  postAutosaveLocatorQuerySchema,
  postAutosaveMutationSuccessSchema,
  postAutosavePromotionRequestSchema,
  postAutosavePromotionSuccessSchema,
  postAutosaveReadSuccessSchema,
  normalizePostContentSnapshot,
  putPostAutosaveRequestSchema,
} from '../../../contracts/post-autosaves';
import {
  contentAutosaveDeleteRequestSchema,
  contentAutosaveDeleteSuccessSchema,
} from '../../../contracts/content-snapshots';
import {
  contentRevisionIdSchema,
  restoreContentRevisionRequestSchema,
} from '../../../contracts/content-revisions';
import {
  postRevisionDetailSuccessSchema,
  postRevisionListSuccessSchema,
} from '../../../contracts/post-revisions';
import {
  createPostRequestSchema,
  deletePostRequestSchema,
  postBulkLifecycleRequestSchema,
  postBulkLifecycleSuccessSchema,
  postDeleteSuccessSchema,
  postDetailSuccessSchema,
  postEditorOptionsQuerySchema,
  postEditorOptionsSuccessSchema,
  postIdSchema,
  postListQuerySchema,
  postListSuccessSchema,
  postMutationSuccessSchema,
  postNewsletterNotificationRequestSchema,
  postNewsletterNotificationSuccessSchema,
  updatePostRequestSchema,
  type PostAccess,
} from '../../../contracts/posts';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type {
  ResolvedSession,
  ResolveUserSession,
} from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import { scheduleCommentTargetProjectionDrain } from '../comments/schedule-target-projection';
import {
  createPost,
  deletePost,
  getPost,
  listPostEditorOptions,
  listPosts,
  updatePost,
  updatePostBulkLifecycle,
  type PostReferenceFailure,
} from './post-repository';
import {
  postAccessAuthorId,
  resolvePostAccess,
} from './post-access';
import {
  deletePostAutosave,
  putPostAutosave,
  readRecentPostAutosave,
  readPostAutosave,
} from '../content-autosaves/repository';
import { promotePostAutosave } from '../content-autosaves/promotion';
import {
  listPostRevisions,
  readPostRevision,
} from '../content-revisions/repository';
import { ContentSearchQueryInvalidError } from '../../../contracts/content-search';
import { ContentSearchIndexNotReadyError } from '../content-search/index-repository';
import { aiExcerptRequestSchema } from '../../../contracts/ai-excerpt';
import { aiPostDraftRequestSchema } from '../../../contracts/ai-post-draft';
import { aiPostEditRequestSchema } from '../../../contracts/ai-post-edit';
import {
  handleAiExcerptRequest,
  type GenerateAiExcerpt,
} from '../ai/excerpt-route';
import {
  handleAiPostDraftRequest,
  type GenerateAiPostDraft,
} from '../ai/post-draft-route';
import {
  handleAiPostEditRequest,
  type GenerateAiPostEdit,
} from '../ai/post-edit-route';
import { readGeneralSettings } from '../settings/general-settings-repository';
import { readRoutingSettings } from '../settings/routing-settings-repository';
import { resolvePostPublicRoute } from '../routing/public-url-resolver';
import { readMailSettings } from '../mail/settings-repository';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import { requireNewsletterEdgeDatabase } from '../newsletters/edge-resources';
import { preparePostNotification } from '../newsletters/post-notification-repository';
import {
  EDGE_MAIL_QUEUE_CONTRACT_VERSION,
  newsletterPostNotificationDispatchMessageSchema,
} from '../../../contracts/edge-mail-queue';
import { logOperationalFailure } from '../lib/operational-error';

const POST_BODY_LIMIT = 8 * 1024 * 1024;
const AI_POST_DRAFT_BODY_LIMIT = 32 * 1024;
// The contract is measured in UTF-16 code units while JSON transport is UTF-8.
// Keep the hard boundary large enough for a valid all-non-ASCII selection.
const AI_POST_EDIT_BODY_LIMIT = 384 * 1024;

export type PostRouteDependencies = {
  resolveSession?: ResolveUserSession;
  resolveAccess?: typeof resolvePostAccess;
  listPosts?: typeof listPosts;
  readGeneralSettings?: typeof readGeneralSettings;
  readRoutingSettings?: typeof readRoutingSettings;
  readMailSettings?: typeof readMailSettings;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  preparePostNotification?: typeof preparePostNotification;
  getPost?: typeof getPost;
  listOptions?: typeof listPostEditorOptions;
  createPost?: typeof createPost;
  updatePost?: typeof updatePost;
  bulkLifecycle?: typeof updatePostBulkLifecycle;
  deletePost?: typeof deletePost;
  readAutosave?: typeof readPostAutosave;
  readRecentAutosave?: typeof readRecentPostAutosave;
  putAutosave?: typeof putPostAutosave;
  deleteAutosave?: typeof deletePostAutosave;
  promoteAutosave?: typeof promotePostAutosave;
  listRevisions?: typeof listPostRevisions;
  readRevision?: typeof readPostRevision;
  scheduleProjectionDrain?: typeof scheduleCommentTargetProjectionDrain;
  now?: () => Date;
  createId?: () => string;
  createRevision?: () => string;
  generateAiExcerpt?: GenerateAiExcerpt;
  generateAiPostDraft?: GenerateAiPostDraft;
  generateAiPostEdit?: GenerateAiPostEdit;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: POST_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function aiPostDraftBodyLimit() {
  return bodyLimit({
    maxSize: AI_POST_DRAFT_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function aiPostEditBodyLimit() {
  return bodyLimit({
    maxSize: AI_POST_EDIT_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function referenceFailureResponse(
  c: Context<StudioHonoEnvironment>,
  kind: PostReferenceFailure,
) {
  return kind === 'author_not_found'
    ? errorResponse(c, 404, 'AUTHOR_NOT_FOUND')
    : kind === 'media_not_found'
      ? errorResponse(c, 404, 'MEDIA_NOT_FOUND')
      : errorResponse(c, 404, 'TAXONOMY_TERM_NOT_FOUND');
}

export function createPostRoutes(
  dependencies: PostRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.listPosts ?? listPosts;
  const readGeneral = dependencies.readGeneralSettings ?? readGeneralSettings;
  const readRouting = dependencies.readRoutingSettings ?? readRoutingSettings;
  const readMail = dependencies.readMailSettings ?? readMailSettings;
  const prepareNotification = dependencies.preparePostNotification
    ?? preparePostNotification;
  const read = dependencies.getPost ?? getPost;
  const listOptions = dependencies.listOptions ?? listPostEditorOptions;
  const create = dependencies.createPost ?? createPost;
  const update = dependencies.updatePost ?? updatePost;
  const bulkLifecycle = dependencies.bulkLifecycle ?? updatePostBulkLifecycle;
  const remove = dependencies.deletePost ?? deletePost;
  const readAutosave = dependencies.readAutosave ?? readPostAutosave;
  const readRecentAutosave = dependencies.readRecentAutosave
    ?? readRecentPostAutosave;
  const writeAutosave = dependencies.putAutosave ?? putPostAutosave;
  const removeAutosave = dependencies.deleteAutosave ?? deletePostAutosave;
  const promoteAutosave = dependencies.promoteAutosave
    ?? promotePostAutosave;
  const listRevisions = dependencies.listRevisions ?? listPostRevisions;
  const readRevision = dependencies.readRevision ?? readPostRevision;
  const scheduleProjectionDrain = dependencies.scheduleProjectionDrain
    ?? scheduleCommentTargetProjectionDrain;
  const currentTime = dependencies.now ?? (() => new Date());
  const readAccess = dependencies.resolveAccess ?? resolvePostAccess;

  async function requirePostContributor(
    c: Context<StudioHonoEnvironment>,
  ): Promise<{
    session: ResolvedSession;
    access: PostAccess;
  } | Response> {
    const session = await requireStudioCapability({
      context: c,
      capability: 'posts.contribute',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    const access = await readAccess({
      db: c.env.DB,
      userId: session.user.id,
      roles: session.user.roles,
    });
    return { session, access };
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    if (!hasValidCsrfHeader(c, authorization.session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return authorization;
  }

  async function authorizeNewsletterMutation(
    c: Context<StudioHonoEnvironment>,
  ) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireStudioCapability({
      context: c,
      capability: 'newsletters.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return await requireEdgeIntegrationReady(
      c,
      dependencies.readEdgeIntegrationMode,
      dependencies.inspectEdgeDatabaseRuntime,
    ) ?? session;
  }

  function scopedAuthorId(access: PostAccess) {
    return postAccessAuthorId(access);
  }

  function authorScope(
    access: PostAccess,
    session: ResolvedSession,
  ) {
    return access.scope === 'own'
      ? { authorId: access.author.id, userId: session.user.id }
      : undefined;
  }

  function authorUnavailable(c: Context<StudioHonoEnvironment>) {
    return errorResponse(c, 409, 'POST_AUTHOR_NOT_LINKED');
  }

  async function readScopedPost(input: {
    c: Context<StudioHonoEnvironment>;
    id: string;
    access: PostAccess;
  }) {
    if (input.access.scope === 'unavailable') return null;
    return read({
      db: input.c.env.DB,
      id: input.id,
      ...(input.access.scope === 'own'
        ? { authorId: input.access.author.id }
        : {}),
    });
  }

  routes.get('/', async (c) => {
    const parsed = postListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    if (
      parsed.data.author_id !== undefined
      && authorization.access.scope !== 'all'
    ) {
      return errorResponse(c, 403, 'FORBIDDEN');
    }
    const authorId = authorization.access.scope === 'all'
      ? parsed.data.author_id
      : scopedAuthorId(authorization.access);
    let result: Awaited<ReturnType<typeof list>>;
    try {
      result = await list({
        db: c.env.DB,
        query: parsed.data,
        ...(authorId === undefined ? {} : { authorId }),
      });
    } catch (error) {
      if (error instanceof ContentSearchQueryInvalidError) {
        return errorResponse(c, 400, 'CONTENT_SEARCH_QUERY_INVALID');
      }
      if (error instanceof ContentSearchIndexNotReadyError) {
        return errorResponse(c, 503, 'CONTENT_SEARCH_INDEX_NOT_READY');
      }
      throw error;
    }
    let items = result.items;
    if (items.length > 0) {
      const [general, routing] = await Promise.all([
        readGeneral({ db: c.env.DB }),
        readRouting({ db: c.env.DB }),
      ]);
      items = items.map((item) => ({
        ...item,
        public_url: resolvePostPublicRoute({
          settings: routing.settings,
          timezone: general.settings.timezone,
          post: item,
        }).url,
      }));
    }
    return c.json(postListSuccessSchema.parse({
      success: true,
      data: { access: authorization.access, ...result, items },
    }));
  });

  routes.get('/options', async (c) => {
    const parsed = postEditorOptionsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    const items = await listOptions({
      db: c.env.DB,
      kind: parsed.data.kind,
      search: parsed.data.search,
      ...(authorization.access.scope === 'all'
        ? {}
        : { authorId: scopedAuthorId(authorization.access) }),
    });
    return c.json(postEditorOptionsSuccessSchema.parse({
      success: true,
      data: { kind: parsed.data.kind, items },
    }));
  });

  routes.post('/ai/excerpt', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = aiExcerptRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    return handleAiExcerptRequest({
      context: c,
      request: parsed.data,
      userId: authorization.session.user.id,
      targetType: 'post',
      generate: dependencies.generateAiExcerpt,
    });
  });

  routes.post('/ai/draft', aiPostDraftBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = aiPostDraftRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    return handleAiPostDraftRequest({
      context: c,
      request: parsed.data,
      userId: authorization.session.user.id,
      generate: dependencies.generateAiPostDraft,
    });
  });

  routes.post('/bulk-lifecycle', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = postBulkLifecycleRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    beginAudit(c, { action: 'content_bulk', target: { type: 'post' } });
    const result = await bulkLifecycle({
      db: c.env.DB,
      request: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
      ...(authorization.access.scope === 'own'
        ? { authorScope: authorScope(
            authorization.access,
            authorization.session,
          ) }
        : {}),
    });
    auditBulk(c, 'post', result.summary, result.target_status);
    if (result.summary.updated > 0) scheduleProjectionDrain(c);
    return c.json(postBulkLifecycleSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/autosave', async (c) => {
    const parsed = postAutosaveLocatorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    if (
      authorization.access.scope !== 'all'
      && parsed.data.target_id
      && !await readScopedPost({
        c,
        id: parsed.data.target_id,
        access: authorization.access,
      })
    ) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const autosave = await readAutosave({
      db: c.env.DB,
      userId: authorization.session.user.id,
      locator: parsed.data.draft_id
        ? { draftId: parsed.data.draft_id }
        : { targetId: parsed.data.target_id! },
      now: currentTime(),
    });
    const visibleAutosave = authorization.access.scope === 'own'
      && autosave?.snapshot.draft.author_id
        !== authorization.access.author.id
      ? null
      : authorization.access.scope === 'unavailable'
        ? null
        : autosave;
    return c.json(postAutosaveReadSuccessSchema.parse({
      success: true,
      data: { autosave: visibleAutosave },
    }));
  });

  routes.get('/autosave/recent', async (c) => {
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    const autosave = authorization.access.scope === 'unavailable'
      ? null
      : await readRecentAutosave({
          db: c.env.DB,
          userId: authorization.session.user.id,
          ...(authorization.access.scope === 'own'
            ? { authorId: authorization.access.author.id }
            : {}),
          now: currentTime(),
        });
    return c.json(postAutosaveReadSuccessSchema.parse({
      success: true,
      data: { autosave },
    }));
  });

  routes.put('/autosave', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = putPostAutosaveRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    if (
      authorization.access.scope === 'own'
      && parsed.data.snapshot.draft.author_id
        !== authorization.access.author.id
    ) return errorResponse(c, 403, 'FORBIDDEN');
    if (
      authorization.access.scope !== 'all'
      && parsed.data.target_id
      && !await readScopedPost({
        c,
        id: parsed.data.target_id,
        access: authorization.access,
      })
    ) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const result = await writeAutosave({
      db: c.env.DB,
      userId: authorization.session.user.id,
      request: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'target_not_found') {
      return errorResponse(c, 404, 'POST_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (result.kind === 'draft_conflict') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (result.kind !== 'completed') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    return c.json(postAutosaveMutationSuccessSchema.parse({
      success: true,
      data: result.autosave,
    }));
  });

  routes.delete('/autosave', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = contentAutosaveDeleteRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    const deleted = await removeAutosave({
      db: c.env.DB,
      userId: authorization.session.user.id,
      draftId: parsed.data.draft_id,
    });
    return c.json(contentAutosaveDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'autosave_deleted', deleted },
    }));
  });

  routes.post('/autosave/promote', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = postAutosavePromotionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    const result = await promoteAutosave({
      db: c.env.DB,
      userId: authorization.session.user.id,
      draftId: parsed.data.draft_id,
      now: currentTime(),
      ...(dependencies.createId ? { createId: dependencies.createId } : {}),
      ...(dependencies.createRevision
        ? { createRevision: dependencies.createRevision }
        : {}),
      ...(authorization.access.scope === 'own'
        ? { authorScope: authorScope(
            authorization.access,
            authorization.session,
          ) }
        : {}),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'CONTENT_AUTOSAVE_NOT_FOUND');
    }
    if (result.kind === 'author_scope_changed') {
      return authorUnavailable(c);
    }
    if (result.kind === 'not_ready') {
      return errorResponse(c, 409, 'CONTENT_AUTOSAVE_PROMOTION_NOT_READY');
    }
    scheduleProjectionDrain(c);
    return c.json(postAutosavePromotionSuccessSchema.parse({
      success: true,
      data: { status: 'draft_promoted', post: result.post },
    }), 201);
  });

  routes.post('/:id/ai/edit', aiPostEditBodyLimit(), async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = aiPostEditRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    const post = await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    });
    if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
    if (post.revision !== parsed.data.expected_revision) {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (post.status === 'trash') {
      return errorResponse(c, 409, 'AI_POST_EDIT_UNAVAILABLE');
    }
    return handleAiPostEditRequest({
      context: c,
      request: parsed.data,
      userId: authorization.session.user.id,
      postId: post.id,
      generate: dependencies.generateAiPostEdit,
    });
  });

  routes.post(
    '/:id/newsletter-notification',
    mutationBodyLimit(),
    async (c) => {
      const id = postIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return errorResponse(c, 404, 'POST_NOT_FOUND');
      const body = await readJsonBody(c);
      if (!body.valid) return body.response;
      const request = postNewsletterNotificationRequestSchema.safeParse(
        body.value,
      );
      if (!request.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
      const authorization = await authorizeNewsletterMutation(c);
      if (authorization instanceof Response) return authorization;

      const post = await read({ db: c.env.DB, id: id.data });
      if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
      if (post.revision !== request.data.expected_revision) {
        return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
      }
      if (post.status !== 'published') {
        return errorResponse(
          c,
          409,
          'NEWSLETTER_POST_NOTIFICATION_REQUIRES_PUBLISHED',
        );
      }
      if (!c.env.MAIL_QUEUE) {
        logOperationalFailure('NEWSLETTER_POST_NOTIFICATION_QUEUE_FAILED', {
          metadata: {
            component: 'worker_binding',
            resource: 'MAIL_QUEUE',
            action: 'queue_post_notification',
          },
        });
        return errorResponse(
          c,
          503,
          'NEWSLETTER_POST_NOTIFICATION_UNAVAILABLE',
        );
      }

      const [mail, general, routing] = await Promise.all([
        readMail({ db: c.env.DB }),
        readGeneral({ db: c.env.DB }),
        readRouting({ db: c.env.DB }),
      ]);
      if (!mail.configured) {
        return errorResponse(c, 409, 'NEWSLETTER_MAIL_NOT_CONFIGURED');
      }
      const publicPath = resolvePostPublicRoute({
        settings: routing.settings,
        timezone: general.settings.timezone,
        post,
      }).url;
      const prepared = await prepareNotification({
        edgeDb: requireNewsletterEdgeDatabase(c.env),
        postId: post.id,
        postRevision: post.revision,
        subject: `New post: ${post.title}`,
        now: currentTime(),
      });
      if (prepared.kind === 'unavailable') {
        return errorResponse(
          c,
          409,
          'NEWSLETTER_POST_NOTIFICATION_UNAVAILABLE',
        );
      }

      if (prepared.pendingCount > 0) {
        const message = newsletterPostNotificationDispatchMessageSchema.parse({
          contract_version: EDGE_MAIL_QUEUE_CONTRACT_VERSION,
          type: 'newsletter.post_notification.dispatch',
          snapshot: {
            newsletter_id: prepared.newsletterId,
            post_id: post.id,
            post_revision: post.revision,
            title: post.title,
            excerpt: post.excerpt,
            public_path: publicPath,
          },
          after_idempotency_key: null,
        });
        try {
          await c.env.MAIL_QUEUE.send(message);
        } catch (error) {
          logOperationalFailure('NEWSLETTER_POST_NOTIFICATION_QUEUE_FAILED', {
            cause: error,
            metadata: {
              resource: 'MAIL_QUEUE',
              action: 'queue_post_notification',
            },
          });
          return errorResponse(
            c,
            503,
            'NEWSLETTER_POST_NOTIFICATION_UNAVAILABLE',
          );
        }
      }

      const status = prepared.recipientCount === 0
        ? 'no_subscribers'
        : prepared.pendingCount === 0
          ? 'already_started'
          : 'queued';
      return c.json(postNewsletterNotificationSuccessSchema.parse({
        success: true,
        data: {
          status,
          post_id: post.id,
          post_revision: post.revision,
          recipient_count: prepared.recipientCount,
          newly_queued_count: prepared.newlyQueuedCount,
        },
      }));
    },
  );

  routes.get('/:id/revisions', async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    const post = await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    });
    if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const revisions = await listRevisions({ db: c.env.DB, post });
    return c.json(postRevisionListSuccessSchema.parse({
      success: true,
      data: revisions,
    }));
  });

  routes.get('/:id/revisions/:revisionId', async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    const revisionId = contentRevisionIdSchema.safeParse(
      c.req.param('revisionId'),
    );
    if (!id.success || !revisionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    const post = await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    });
    if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const revision = await readRevision({
      db: c.env.DB,
      post,
      revisionId: revisionId.data,
    });
    if (!revision) {
      return errorResponse(c, 404, 'POST_SAVED_REVISION_NOT_FOUND');
    }
    return c.json(postRevisionDetailSuccessSchema.parse({
      success: true,
      data: revision,
    }));
  });

  routes.post(
    '/:id/revisions/:revisionId/restore',
    mutationBodyLimit(),
    async (c) => {
      const id = postIdSchema.safeParse(c.req.param('id'));
      const revisionId = contentRevisionIdSchema.safeParse(
        c.req.param('revisionId'),
      );
      if (!id.success || !revisionId.success) {
        return errorResponse(c, 400, 'VALIDATION_ERROR');
      }
      const body = await readJsonBody(c);
      if (!body.valid) return body.response;
      const restoreRequest = restoreContentRevisionRequestSchema.safeParse(
        body.value,
      );
      if (!restoreRequest.success) {
        return errorResponse(c, 400, 'VALIDATION_ERROR');
      }
      const authorization = await authorizeMutation(c);
      if (authorization instanceof Response) return authorization;
      if (authorization.access.scope === 'unavailable') {
        return authorUnavailable(c);
      }
      const post = await readScopedPost({
        c,
        id: id.data,
        access: authorization.access,
      });
      if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
      const revision = await readRevision({
        db: c.env.DB,
        post,
        revisionId: revisionId.data,
      });
      if (!revision) {
        return errorResponse(c, 404, 'POST_SAVED_REVISION_NOT_FOUND');
      }
      const authored = updatePostRequestSchema.parse({
        ...normalizePostContentSnapshot(revision.snapshot).draft,
        expected_revision: restoreRequest.data.expected_revision,
      });
      if (
        authorization.access.scope === 'own'
        && authored.author_id !== authorization.access.author.id
      ) return errorResponse(c, 403, 'FORBIDDEN');
      const result = await update({
      beforeStatusChange: (current, status) => beginContentAudit(c, 'post', current, status),
        db: c.env.DB,
        id: id.data,
        authored,
        now: currentTime(),
        createRevision: dependencies.createRevision,
        autosaveUserId: authorization.session.user.id,
        ...(authorization.access.scope === 'own'
          ? { authorScope: authorScope(
              authorization.access,
              authorization.session,
            ) }
          : {}),
      });
      if (result.kind === 'author_scope_changed') {
        return authorUnavailable(c);
      }
      if (result.kind === 'not_found') {
        return errorResponse(c, 404, 'POST_NOT_FOUND');
      }
      if (result.kind === 'revision_conflict') {
        return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
      }
      if (result.kind === 'slug_conflict') {
        return errorResponse(c, 409, 'POST_SLUG_CONFLICT');
      }
      if (result.kind === 'document_type_change_forbidden') {
        return errorResponse(c, 409, 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN');
      }
      if (result.kind !== 'completed') {
        return referenceFailureResponse(c, result.kind);
      }
      scheduleProjectionDrain(c);
      auditContentChange(c, 'post', result.post, 'previousStatus' in result ? result.previousStatus : undefined);
      return c.json(postMutationSuccessSchema.parse({
        success: true,
        data: result.post,
      }));
    },
  );

  routes.get('/:id', async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await requirePostContributor(c);
    if (authorization instanceof Response) return authorization;
    const post = await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    });
    if (!post) return errorResponse(c, 404, 'POST_NOT_FOUND');
    return c.json(postDetailSuccessSchema.parse({
      success: true,
      data: post,
    }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createPostRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    if (
      authorization.access.scope === 'own'
      && parsed.data.author_id !== authorization.access.author.id
    ) return errorResponse(c, 403, 'FORBIDDEN');
    const result = await create({
      db: c.env.DB,
      authored: parsed.data,
      now: currentTime(),
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
      autosaveUserId: authorization.session.user.id,
      ...(authorization.access.scope === 'own'
        ? { authorScope: authorScope(
            authorization.access,
            authorization.session,
          ) }
        : {}),
    });
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'POST_SLUG_CONFLICT');
    }
    if (result.kind === 'author_scope_changed') {
      return authorUnavailable(c);
    }
    if (result.kind === 'autosave_conflict') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (result.kind !== 'completed') {
      return referenceFailureResponse(c, result.kind);
    }
    scheduleProjectionDrain(c);
    return c.json(postMutationSuccessSchema.parse({
      success: true,
      data: result.post,
    }), 201);
  });

  routes.put('/:id', mutationBodyLimit(), async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updatePostRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    if (
      authorization.access.scope === 'own'
      && parsed.data.author_id !== authorization.access.author.id
    ) return errorResponse(c, 403, 'FORBIDDEN');
    if (authorization.access.scope !== 'all' && !await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    })) return errorResponse(c, 404, 'POST_NOT_FOUND');
    const result = await update({
      beforeStatusChange: (current, status) => beginContentAudit(c, 'post', current, status),
      db: c.env.DB,
      id: id.data,
      authored: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
      autosaveUserId: authorization.session.user.id,
      ...(authorization.access.scope === 'own'
        ? { authorScope: authorScope(
            authorization.access,
            authorization.session,
          ) }
        : {}),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'POST_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'POST_SLUG_CONFLICT');
    }
    if (result.kind === 'author_scope_changed') {
      return authorUnavailable(c);
    }
    if (result.kind === 'document_type_change_forbidden') {
      return errorResponse(c, 409, 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN');
    }
    if (result.kind !== 'completed') {
      return referenceFailureResponse(c, result.kind);
    }
    scheduleProjectionDrain(c);
    auditContentChange(c, 'post', result.post, 'previousStatus' in result ? result.previousStatus : undefined);
    return c.json(postMutationSuccessSchema.parse({
      success: true,
      data: result.post,
    }));
  });

  routes.delete('/:id', mutationBodyLimit(), async (c) => {
    const id = postIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deletePostRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authorization = await authorizeMutation(c);
    if (authorization instanceof Response) return authorization;
    if (authorization.access.scope === 'unavailable') {
      return authorUnavailable(c);
    }
    if (authorization.access.scope !== 'all' && !await readScopedPost({
      c,
      id: id.data,
      access: authorization.access,
    })) return errorResponse(c, 404, 'POST_NOT_FOUND');
    beginAudit(c, { action: 'content_delete', target: { type: 'post', id: id.data } });
    const result = await remove({
      db: c.env.DB,
      id: id.data,
      expectedRevision: parsed.data.expected_revision,
      ...(authorization.access.scope === 'own'
        ? { authorScope: authorScope(
            authorization.access,
            authorization.session,
          ) }
        : {}),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'POST_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'POST_REVISION_CONFLICT');
    }
    if (result.kind === 'not_in_trash') {
      return errorResponse(c, 409, 'POST_NOT_IN_TRASH');
    }
    scheduleProjectionDrain(c);
    recordAudit(c, { action: 'content_delete', target: { type: 'post', id: id.data, label: result.title } });
    return c.json(postDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'post_deleted', id: id.data },
    }));
  });

  return routes;
}
