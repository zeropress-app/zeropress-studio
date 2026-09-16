import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  pageAutosaveLocatorQuerySchema,
  pageAutosaveMutationSuccessSchema,
  pageAutosavePromotionRequestSchema,
  pageAutosavePromotionSuccessSchema,
  pageAutosaveReadSuccessSchema,
  normalizePageContentSnapshot,
  putPageAutosaveRequestSchema,
} from '../../../contracts/page-autosaves';
import {
  contentAutosaveDeleteRequestSchema,
  contentAutosaveDeleteSuccessSchema,
} from '../../../contracts/content-snapshots';
import {
  contentRevisionIdSchema,
  restoreContentRevisionRequestSchema,
} from '../../../contracts/content-revisions';
import {
  pageRevisionDetailSuccessSchema,
  pageRevisionListSuccessSchema,
} from '../../../contracts/page-revisions';
import {
  createPageRequestSchema,
  deletePageRequestSchema,
  pageBulkLifecycleRequestSchema,
  pageBulkLifecycleSuccessSchema,
  pageDeleteSuccessSchema,
  pageDetailSuccessSchema,
  pageIdSchema,
  pageListQuerySchema,
  pageListSuccessSchema,
  pageMutationSuccessSchema,
  pageParentOptionsQuerySchema,
  pageParentOptionsSuccessSchema,
  updatePageRequestSchema,
} from '../../../contracts/pages';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import { scheduleCommentTargetProjectionDrain } from '../comments/schedule-target-projection';
import {
  createPage,
  deletePage,
  getPage,
  listPageParentOptions,
  listPages,
  updatePage,
  updatePageBulkLifecycle,
  type PageReferenceFailure,
} from './page-repository';
import {
  deletePageAutosave,
  putPageAutosave,
  readRecentPageAutosave,
  readPageAutosave,
} from '../content-autosaves/repository';
import { promotePageAutosave } from '../content-autosaves/promotion';
import {
  listPageRevisions,
  readPageRevision,
} from '../content-revisions/repository';
import { ContentSearchQueryInvalidError } from '../../../contracts/content-search';
import { ContentSearchIndexNotReadyError } from '../content-search/index-repository';
import { aiExcerptRequestSchema } from '../../../contracts/ai-excerpt';
import {
  handleAiExcerptRequest,
  type GenerateAiExcerpt,
} from '../ai/excerpt-route';
import { aiPageDraftRequestSchema } from '../../../contracts/ai-page-draft';
import {
  handleAiPageDraftRequest,
  type GenerateAiPageDraft,
} from '../ai/page-draft-route';
import { readRoutingSettings } from '../settings/routing-settings-repository';
import { resolvePageNavigationUrl } from '../routing/public-url-resolver';

const PAGE_BODY_LIMIT = 8 * 1024 * 1024;
const AI_PAGE_DRAFT_BODY_LIMIT = 32 * 1024;

export type PageRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listPages?: typeof listPages;
  readRoutingSettings?: typeof readRoutingSettings;
  getPage?: typeof getPage;
  listParentOptions?: typeof listPageParentOptions;
  createPage?: typeof createPage;
  updatePage?: typeof updatePage;
  bulkLifecycle?: typeof updatePageBulkLifecycle;
  deletePage?: typeof deletePage;
  readAutosave?: typeof readPageAutosave;
  readRecentAutosave?: typeof readRecentPageAutosave;
  putAutosave?: typeof putPageAutosave;
  deleteAutosave?: typeof deletePageAutosave;
  promoteAutosave?: typeof promotePageAutosave;
  listRevisions?: typeof listPageRevisions;
  readRevision?: typeof readPageRevision;
  scheduleProjectionDrain?: typeof scheduleCommentTargetProjectionDrain;
  now?: () => Date;
  createId?: () => string;
  createRevision?: () => string;
  generateAiExcerpt?: GenerateAiExcerpt;
  generateAiPageDraft?: GenerateAiPageDraft;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: PAGE_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function aiPageDraftBodyLimit() {
  return bodyLimit({
    maxSize: AI_PAGE_DRAFT_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function parentFailureResponse(
  c: Context<StudioHonoEnvironment>,
  kind: PageReferenceFailure,
) {
  return kind === 'media_not_found'
    ? errorResponse(c, 404, 'MEDIA_NOT_FOUND')
    : kind === 'parent_not_found'
    ? errorResponse(c, 404, 'PAGE_PARENT_NOT_FOUND')
    : errorResponse(c, 409, 'PAGE_PARENT_CYCLE');
}

export function createPageRoutes(
  dependencies: PageRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.listPages ?? listPages;
  const readRouting = dependencies.readRoutingSettings ?? readRoutingSettings;
  const read = dependencies.getPage ?? getPage;
  const listParents = dependencies.listParentOptions ?? listPageParentOptions;
  const create = dependencies.createPage ?? createPage;
  const update = dependencies.updatePage ?? updatePage;
  const bulkLifecycle = dependencies.bulkLifecycle ?? updatePageBulkLifecycle;
  const remove = dependencies.deletePage ?? deletePage;
  const readAutosave = dependencies.readAutosave ?? readPageAutosave;
  const readRecentAutosave = dependencies.readRecentAutosave
    ?? readRecentPageAutosave;
  const writeAutosave = dependencies.putAutosave ?? putPageAutosave;
  const removeAutosave = dependencies.deleteAutosave ?? deletePageAutosave;
  const promoteAutosave = dependencies.promoteAutosave
    ?? promotePageAutosave;
  const listRevisions = dependencies.listRevisions ?? listPageRevisions;
  const readRevision = dependencies.readRevision ?? readPageRevision;
  const scheduleProjectionDrain = dependencies.scheduleProjectionDrain
    ?? scheduleCommentTargetProjectionDrain;
  const currentTime = dependencies.now ?? (() => new Date());

  function requirePageManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'pages.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    const parsed = pageListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    let result: Awaited<ReturnType<typeof list>>;
    try {
      result = await list({ db: c.env.DB, query: parsed.data });
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
      const routing = await readRouting({ db: c.env.DB });
      items = items.map((item) => ({
        ...item,
        public_url: resolvePageNavigationUrl({
          settings: routing.settings,
          page: item,
        }),
      }));
    }
    return c.json(pageListSuccessSchema.parse({
      success: true,
      data: { ...result, items },
    }));
  });

  routes.get('/parent-options', async (c) => {
    const parsed = pageParentOptionsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const items = await listParents({
      db: c.env.DB,
      search: parsed.data.search,
      currentPageId: parsed.data.current_page_id,
    });
    return c.json(pageParentOptionsSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.post('/ai/excerpt', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = aiExcerptRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    return handleAiExcerptRequest({
      context: c,
      request: parsed.data,
      userId: session.user.id,
      targetType: 'page',
      generate: dependencies.generateAiExcerpt,
    });
  });

  routes.post('/ai/draft', aiPageDraftBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = aiPageDraftRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    return handleAiPageDraftRequest({
      context: c,
      request: parsed.data,
      userId: session.user.id,
      generate: dependencies.generateAiPageDraft,
    });
  });

  routes.post('/bulk-lifecycle', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = pageBulkLifecycleRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await bulkLifecycle({
      db: c.env.DB,
      request: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.summary.updated > 0) scheduleProjectionDrain(c);
    return c.json(pageBulkLifecycleSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/autosave', async (c) => {
    const parsed = pageAutosaveLocatorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const autosave = await readAutosave({
      db: c.env.DB,
      userId: session.user.id,
      locator: parsed.data.draft_id
        ? { draftId: parsed.data.draft_id }
        : { targetId: parsed.data.target_id! },
      now: currentTime(),
    });
    return c.json(pageAutosaveReadSuccessSchema.parse({
      success: true,
      data: { autosave },
    }));
  });

  routes.get('/autosave/recent', async (c) => {
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const autosave = await readRecentAutosave({
      db: c.env.DB,
      userId: session.user.id,
      now: currentTime(),
    });
    return c.json(pageAutosaveReadSuccessSchema.parse({
      success: true,
      data: { autosave },
    }));
  });

  routes.put('/autosave', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = putPageAutosaveRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await writeAutosave({
      db: c.env.DB,
      userId: session.user.id,
      request: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'target_not_found') {
      return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    if (result.kind === 'draft_conflict') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    if (result.kind !== 'completed') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    return c.json(pageAutosaveMutationSuccessSchema.parse({
      success: true,
      data: result.autosave,
    }));
  });

  routes.delete('/autosave', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = contentAutosaveDeleteRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const deleted = await removeAutosave({
      db: c.env.DB,
      userId: session.user.id,
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
    const parsed = pageAutosavePromotionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await promoteAutosave({
      db: c.env.DB,
      userId: session.user.id,
      draftId: parsed.data.draft_id,
      now: currentTime(),
      ...(dependencies.createId ? { createId: dependencies.createId } : {}),
      ...(dependencies.createRevision
        ? { createRevision: dependencies.createRevision }
        : {}),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'CONTENT_AUTOSAVE_NOT_FOUND');
    }
    if (result.kind === 'not_ready') {
      return errorResponse(c, 409, 'CONTENT_AUTOSAVE_PROMOTION_NOT_READY');
    }
    scheduleProjectionDrain(c);
    return c.json(pageAutosavePromotionSuccessSchema.parse({
      success: true,
      data: { status: 'draft_promoted', page: result.page },
    }), 201);
  });

  routes.get('/:id/revisions', async (c) => {
    const id = pageIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const page = await read({ db: c.env.DB, id: id.data });
    if (!page) return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    const revisions = await listRevisions({ db: c.env.DB, page });
    return c.json(pageRevisionListSuccessSchema.parse({
      success: true,
      data: revisions,
    }));
  });

  routes.get('/:id/revisions/:revisionId', async (c) => {
    const id = pageIdSchema.safeParse(c.req.param('id'));
    const revisionId = contentRevisionIdSchema.safeParse(
      c.req.param('revisionId'),
    );
    if (!id.success || !revisionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const page = await read({ db: c.env.DB, id: id.data });
    if (!page) return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    const revision = await readRevision({
      db: c.env.DB,
      page,
      revisionId: revisionId.data,
    });
    if (!revision) {
      return errorResponse(c, 404, 'PAGE_SAVED_REVISION_NOT_FOUND');
    }
    return c.json(pageRevisionDetailSuccessSchema.parse({
      success: true,
      data: revision,
    }));
  });

  routes.post(
    '/:id/revisions/:revisionId/restore',
    mutationBodyLimit(),
    async (c) => {
      const id = pageIdSchema.safeParse(c.req.param('id'));
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
      const session = await authorizeMutation(c);
      if (session instanceof Response) return session;
      const page = await read({ db: c.env.DB, id: id.data });
      if (!page) return errorResponse(c, 404, 'PAGE_NOT_FOUND');
      const revision = await readRevision({
        db: c.env.DB,
        page,
        revisionId: revisionId.data,
      });
      if (!revision) {
        return errorResponse(c, 404, 'PAGE_SAVED_REVISION_NOT_FOUND');
      }
      const authored = updatePageRequestSchema.parse({
        ...normalizePageContentSnapshot(revision.snapshot).draft,
        expected_revision: restoreRequest.data.expected_revision,
      });
      const result = await update({
        db: c.env.DB,
        id: id.data,
        authored,
        now: currentTime(),
        createRevision: dependencies.createRevision,
        autosaveUserId: session.user.id,
      });
      if (result.kind === 'not_found') {
        return errorResponse(c, 404, 'PAGE_NOT_FOUND');
      }
      if (result.kind === 'revision_conflict') {
        return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
      }
      if (result.kind === 'slug_conflict') {
        return errorResponse(c, 409, 'PAGE_SLUG_CONFLICT');
      }
      if (result.kind === 'has_children') {
        return errorResponse(c, 409, 'PAGE_HAS_CHILDREN');
      }
      if (result.kind === 'front_page_protected') {
        return errorResponse(c, 409, 'PAGE_IS_FRONT_PAGE');
      }
      if (result.kind === 'document_type_change_forbidden') {
        return errorResponse(c, 409, 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN');
      }
      if (result.kind !== 'completed') {
        return parentFailureResponse(c, result.kind);
      }
      scheduleProjectionDrain(c);
      return c.json(pageMutationSuccessSchema.parse({
        success: true,
        data: result.page,
      }));
    },
  );

  routes.get('/:id', async (c) => {
    const id = pageIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requirePageManager(c);
    if (session instanceof Response) return session;
    const page = await read({ db: c.env.DB, id: id.data });
    if (!page) return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    return c.json(pageDetailSuccessSchema.parse({ success: true, data: page }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createPageRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      authored: parsed.data,
      now: currentTime(),
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
      autosaveUserId: session.user.id,
    });
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'PAGE_SLUG_CONFLICT');
    }
    if (result.kind === 'autosave_conflict') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    if (result.kind !== 'completed') {
      return parentFailureResponse(c, result.kind);
    }
    scheduleProjectionDrain(c);
    return c.json(pageMutationSuccessSchema.parse({
      success: true,
      data: result.page,
    }), 201);
  });

  routes.put('/:id', mutationBodyLimit(), async (c) => {
    const id = pageIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updatePageRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await update({
      db: c.env.DB,
      id: id.data,
      authored: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
      autosaveUserId: session.user.id,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'PAGE_SLUG_CONFLICT');
    }
    if (result.kind === 'has_children') {
      return errorResponse(c, 409, 'PAGE_HAS_CHILDREN');
    }
    if (result.kind === 'front_page_protected') {
      return errorResponse(c, 409, 'PAGE_IS_FRONT_PAGE');
    }
    if (result.kind === 'document_type_change_forbidden') {
      return errorResponse(c, 409, 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN');
    }
    if (result.kind !== 'completed') {
      return parentFailureResponse(c, result.kind);
    }
    scheduleProjectionDrain(c);
    return c.json(pageMutationSuccessSchema.parse({
      success: true,
      data: result.page,
    }));
  });

  routes.delete('/:id', mutationBodyLimit(), async (c) => {
    const id = pageIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deletePageRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await remove({
      db: c.env.DB,
      id: id.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'PAGE_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'PAGE_REVISION_CONFLICT');
    }
    if (result.kind === 'not_in_trash') {
      return errorResponse(c, 409, 'PAGE_NOT_IN_TRASH');
    }
    if (result.kind === 'has_children') {
      return errorResponse(c, 409, 'PAGE_HAS_CHILDREN');
    }
    if (result.kind === 'front_page_protected') {
      return errorResponse(c, 409, 'PAGE_IS_FRONT_PAGE');
    }
    scheduleProjectionDrain(c);
    return c.json(pageDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'page_deleted', id: id.data },
    }));
  });

  return routes;
}
