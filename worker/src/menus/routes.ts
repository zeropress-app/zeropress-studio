import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  canonicalizeMenuItems,
  createMenuRequestSchema,
  deleteMenuRequestSchema,
  isDefaultMenuId,
  menuDeleteSuccessSchema,
  menuIdSchema,
  menuListSuccessSchema,
  menuMutationSuccessSchema,
  menuReferencesSuccessSchema,
  menuSaveSuccessSchema,
  resolveMenuReferencesRequestSchema,
  saveMenuRequestSchema,
} from '../../../contracts/menus';
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
  createMenu,
  deleteMenu,
  listMenus,
  resolveMenuReferences,
  saveMenu,
} from './menu-repository';

const MENU_BODY_LIMIT = 1_100_000;
export type MenuRouteDependencies = {
  resolveSession?: ResolveUserSession;
  list?: typeof listMenus;
  resolveReferences?: typeof resolveMenuReferences;
  create?: typeof createMenu;
  save?: typeof saveMenu;
  delete?: typeof deleteMenu;
  now?: () => Date;
  createRevision?: () => string;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: MENU_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createMenuRoutes(
  dependencies: MenuRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.list ?? listMenus;
  const resolveReferences = dependencies.resolveReferences ?? resolveMenuReferences;
  const create = dependencies.create ?? createMenu;
  const save = dependencies.save ?? saveMenu;
  const remove = dependencies.delete ?? deleteMenu;
  const currentTime = dependencies.now ?? (() => new Date());

  function requireMenuManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'menus.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeBodyRequest(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireMenuManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    const session = await requireMenuManager(c);
    if (session instanceof Response) return session;
    const items = await list({ db: c.env.DB });
    return c.json(menuListSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  // Read-only POST keeps up to 500 typed IDs out of URL length limits.
  // It has the same session, capability, origin, and CSRF protection as edits.
  routes.post('/link-references', bodyLimit({
    maxSize: 64_000,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const session = await authorizeBodyRequest(c);
    if (session instanceof Response) return session;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = resolveMenuReferencesRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const items = await resolveReferences({
      db: c.env.DB,
      references: parsed.data.references,
    });
    return c.json(menuReferencesSuccessSchema.parse({ success: true, data: { items } }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createMenuRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeBodyRequest(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      menuId: parsed.data.menu_id,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      items: canonicalizeMenuItems(parsed.data.items),
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'id_conflict') {
      return errorResponse(c, 409, 'MENU_ID_CONFLICT');
    }
    if (result.kind === 'reference_not_found') {
      return errorResponse(c, 409, 'MENU_REFERENCE_NOT_FOUND');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'MENU_LIMIT_REACHED');
    }
    return c.json(menuMutationSuccessSchema.parse({
      success: true,
      data: result.menu,
    }), 201);
  });

  routes.put('/:menuId', mutationBodyLimit(), async (c) => {
    const menuId = menuIdSchema.safeParse(c.req.param('menuId'));
    if (!menuId.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = saveMenuRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    if (parsed.data.expected_revision === null && !isDefaultMenuId(menuId.data)) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeBodyRequest(c);
    if (session instanceof Response) return session;
    const result = await save({
      db: c.env.DB,
      menuId: menuId.data,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      items: canonicalizeMenuItems(parsed.data.items),
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MENU_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MENU_REVISION_CONFLICT');
    }
    if (result.kind === 'id_conflict') {
      return errorResponse(c, 409, 'MENU_ID_CONFLICT');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'MENU_LIMIT_REACHED');
    }
    if (result.kind === 'reference_not_found') {
      return errorResponse(c, 409, 'MENU_REFERENCE_NOT_FOUND');
    }
    return c.json(menuSaveSuccessSchema.parse({
      success: true,
      data: { items: result.menus },
    }));
  });

  routes.delete('/:menuId', mutationBodyLimit(), async (c) => {
    const menuId = menuIdSchema.safeParse(c.req.param('menuId'));
    if (!menuId.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteMenuRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeBodyRequest(c);
    if (session instanceof Response) return session;
    const result = await remove({
      db: c.env.DB,
      menuId: menuId.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MENU_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MENU_REVISION_CONFLICT');
    }
    if (result.kind === 'protected') {
      return errorResponse(c, 409, 'MENU_PROTECTED');
    }
    return c.json(menuDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'menu_deleted', menu_id: menuId.data },
    }));
  });

  return routes;
}
