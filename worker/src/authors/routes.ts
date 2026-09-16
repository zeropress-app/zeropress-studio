import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  authorDeleteSuccessSchema,
  authorIdSchema,
  authorListQuerySchema,
  authorListSuccessSchema,
  authorMutationSuccessSchema,
  authorUserOptionsSuccessSchema,
  createAuthorRequestSchema,
  deleteAuthorRequestSchema,
  updateAuthorRequestSchema,
} from '../../../contracts/authors';
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
  createAuthor,
  deleteAuthor,
  listAuthors,
  listAuthorUserOptions,
  updateAuthor,
} from './author-repository';

const AUTHOR_BODY_LIMIT = 32 * 1024;

export type AuthorRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listAuthors?: typeof listAuthors;
  listUserOptions?: typeof listAuthorUserOptions;
  createAuthor?: typeof createAuthor;
  updateAuthor?: typeof updateAuthor;
  deleteAuthor?: typeof deleteAuthor;
  now?: () => Date;
  createRevision?: () => string;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: AUTHOR_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createAuthorRoutes(
  dependencies: AuthorRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.listAuthors ?? listAuthors;
  const listOptions = dependencies.listUserOptions ?? listAuthorUserOptions;
  const create = dependencies.createAuthor ?? createAuthor;
  const update = dependencies.updateAuthor ?? updateAuthor;
  const remove = dependencies.deleteAuthor ?? deleteAuthor;
  const currentTime = dependencies.now ?? (() => new Date());

  function requireAuthorManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'authors.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireAuthorManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    const parsedQuery = authorListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requireAuthorManager(c);
    if (session instanceof Response) return session;
    const result = await list({ db: c.env.DB, query: parsedQuery.data });
    return c.json(authorListSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/user-options', async (c) => {
    const session = await requireAuthorManager(c);
    if (session instanceof Response) return session;
    const items = await listOptions({ db: c.env.DB });
    return c.json(authorUserOptionsSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createAuthorRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      id: parsed.data.id,
      displayName: parsed.data.display_name,
      userId: parsed.data.user_id,
      avatarMediaId: parsed.data.avatar_media_id,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'id_conflict') {
      return errorResponse(c, 409, 'AUTHOR_ID_CONFLICT');
    }
    if (result.kind === 'user_conflict') {
      return errorResponse(c, 409, 'AUTHOR_USER_CONFLICT');
    }
    if (result.kind === 'user_not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'media_not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    return c.json(authorMutationSuccessSchema.parse({
      success: true,
      data: result.author,
    }), 201);
  });

  routes.put('/:id', mutationBodyLimit(), async (c) => {
    const authorId = authorIdSchema.safeParse(c.req.param('id'));
    if (!authorId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateAuthorRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await update({
      db: c.env.DB,
      id: authorId.data,
      displayName: parsed.data.display_name,
      userId: parsed.data.user_id,
      avatarMediaId: parsed.data.avatar_media_id,
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'AUTHOR_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'AUTHOR_REVISION_CONFLICT');
    }
    if (result.kind === 'user_conflict') {
      return errorResponse(c, 409, 'AUTHOR_USER_CONFLICT');
    }
    if (result.kind === 'user_not_found') {
      return errorResponse(c, 404, 'USER_NOT_FOUND');
    }
    if (result.kind === 'media_not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    return c.json(authorMutationSuccessSchema.parse({
      success: true,
      data: result.author,
    }));
  });

  routes.delete('/:id', mutationBodyLimit(), async (c) => {
    const authorId = authorIdSchema.safeParse(c.req.param('id'));
    if (!authorId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteAuthorRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await remove({
      db: c.env.DB,
      id: authorId.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'AUTHOR_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'AUTHOR_REVISION_CONFLICT');
    }
    if (result.kind === 'in_use') {
      return errorResponse(c, 409, 'AUTHOR_IN_USE');
    }
    return c.json(authorDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'author_deleted', id: authorId.data },
    }));
  });

  return routes;
}
