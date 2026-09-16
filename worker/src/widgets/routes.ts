import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  canonicalizeWidgetItems,
  createWidgetAreaRequestSchema,
  deleteWidgetAreaRequestSchema,
  isProtectedWidgetAreaId,
  saveWidgetAreaRequestSchema,
  widgetAreaDeleteSuccessSchema,
  widgetAreaIdSchema,
  widgetAreaListSuccessSchema,
  widgetAreaMutationSuccessSchema,
  widgetAuthorOptionsQuerySchema,
  widgetAuthorOptionsSuccessSchema,
} from '../../../contracts/widgets';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import {
  createWidgetArea,
  deleteWidgetArea,
  listWidgetAreas,
  listWidgetAuthorOptions,
  saveWidgetArea,
} from './widget-repository';

const WIDGET_BODY_LIMIT = 1_100_000;

export type WidgetRouteDependencies = {
  resolveSession?: ResolveUserSession;
  list?: typeof listWidgetAreas;
  listAuthorOptions?: typeof listWidgetAuthorOptions;
  create?: typeof createWidgetArea;
  save?: typeof saveWidgetArea;
  delete?: typeof deleteWidgetArea;
  now?: () => Date;
  createRevision?: () => string;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: WIDGET_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createWidgetRoutes(
  dependencies: WidgetRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.list ?? listWidgetAreas;
  const authorOptions = dependencies.listAuthorOptions
    ?? listWidgetAuthorOptions;
  const create = dependencies.create ?? createWidgetArea;
  const save = dependencies.save ?? saveWidgetArea;
  const remove = dependencies.delete ?? deleteWidgetArea;
  const currentTime = dependencies.now ?? (() => new Date());

  function requireWidgetManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'widgets.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireWidgetManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    const session = await requireWidgetManager(c);
    if (session instanceof Response) return session;
    const items = await list({ db: c.env.DB });
    return c.json(widgetAreaListSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.get('/author-options', async (c) => {
    const query = widgetAuthorOptionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireWidgetManager(c);
    if (session instanceof Response) return session;
    const items = await authorOptions({
      db: c.env.DB,
      search: query.data.search,
    });
    return c.json(widgetAuthorOptionsSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createWidgetAreaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      widgetAreaId: parsed.data.widget_area_id,
      name: parsed.data.name,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'id_conflict') {
      return errorResponse(c, 409, 'WIDGET_AREA_ID_CONFLICT');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'WIDGET_AREA_LIMIT_REACHED');
    }
    return c.json(widgetAreaMutationSuccessSchema.parse({
      success: true,
      data: result.widgetArea,
    }), 201);
  });

  routes.put('/:widgetAreaId', mutationBodyLimit(), async (c) => {
    const widgetAreaId = widgetAreaIdSchema.safeParse(
      c.req.param('widgetAreaId'),
    );
    if (!widgetAreaId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = saveWidgetAreaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    if (
      parsed.data.expected_revision === null
      && !isProtectedWidgetAreaId(widgetAreaId.data)
    ) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await save({
      db: c.env.DB,
      widgetAreaId: widgetAreaId.data,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      items: canonicalizeWidgetItems(parsed.data.items),
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'WIDGET_AREA_NOT_FOUND');
    }
    if (result.kind === 'id_conflict') {
      return errorResponse(c, 409, 'WIDGET_AREA_ID_CONFLICT');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'WIDGET_AREA_REVISION_CONFLICT');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'WIDGET_AREA_LIMIT_REACHED');
    }
    if (result.kind === 'author_not_found') {
      return errorResponse(c, 409, 'WIDGET_AUTHOR_NOT_FOUND');
    }
    return c.json(widgetAreaMutationSuccessSchema.parse({
      success: true,
      data: result.widgetArea,
    }));
  });

  routes.delete('/:widgetAreaId', mutationBodyLimit(), async (c) => {
    const widgetAreaId = widgetAreaIdSchema.safeParse(
      c.req.param('widgetAreaId'),
    );
    if (!widgetAreaId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteWidgetAreaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await remove({
      db: c.env.DB,
      widgetAreaId: widgetAreaId.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'WIDGET_AREA_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'WIDGET_AREA_REVISION_CONFLICT');
    }
    if (result.kind === 'protected') {
      return errorResponse(c, 409, 'WIDGET_AREA_PROTECTED');
    }
    return c.json(widgetAreaDeleteSuccessSchema.parse({
      success: true,
      data: {
        status: 'widget_area_deleted',
        widget_area_id: widgetAreaId.data,
      },
    }));
  });

  return routes;
}
