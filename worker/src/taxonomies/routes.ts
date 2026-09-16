import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  createTaxonomyTermRequestSchema,
  deleteTaxonomyTermRequestSchema,
  taxonomyDeleteSuccessSchema,
  taxonomyListQuerySchema,
  taxonomyListSuccessSchema,
  taxonomyMutationSuccessSchema,
  taxonomyTermIdSchema,
  updateTaxonomyTermRequestSchema,
  type TaxonomyKind,
} from '../../../contracts/taxonomies';
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
  createTaxonomyTerm,
  deleteTaxonomyTerm,
  listTaxonomyTerms,
  updateTaxonomyTerm,
} from './taxonomy-repository';

const TAXONOMY_BODY_LIMIT = 32 * 1024;
const taxonomyPathSchema = z.enum(['categories', 'tags']);

function taxonomyFromPath(path: z.infer<typeof taxonomyPathSchema>): TaxonomyKind {
  return path === 'categories' ? 'category' : 'tag';
}

export type TaxonomyRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listTerms?: typeof listTaxonomyTerms;
  createTerm?: typeof createTaxonomyTerm;
  updateTerm?: typeof updateTaxonomyTerm;
  deleteTerm?: typeof deleteTaxonomyTerm;
  now?: () => Date;
  createId?: () => string;
  createRevision?: () => string;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: TAXONOMY_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createTaxonomyRoutes(
  dependencies: TaxonomyRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.listTerms ?? listTaxonomyTerms;
  const create = dependencies.createTerm ?? createTaxonomyTerm;
  const update = dependencies.updateTerm ?? updateTaxonomyTerm;
  const remove = dependencies.deleteTerm ?? deleteTaxonomyTerm;
  const currentTime = dependencies.now ?? (() => new Date());

  function parseTaxonomy(c: Context<StudioHonoEnvironment>) {
    const parsed = taxonomyPathSchema.safeParse(c.req.param('taxonomy'));
    return parsed.success ? taxonomyFromPath(parsed.data) : null;
  }

  function requireTaxonomyManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'taxonomies.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireTaxonomyManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/:taxonomy', async (c) => {
    const taxonomy = parseTaxonomy(c);
    if (!taxonomy) return errorResponse(c, 404, 'NOT_FOUND');
    const parsedQuery = taxonomyListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requireTaxonomyManager(c);
    if (session instanceof Response) return session;
    const result = await list({
      db: c.env.DB,
      taxonomy,
      query: parsedQuery.data,
    });
    return c.json(taxonomyListSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.post('/:taxonomy', mutationBodyLimit(), async (c) => {
    const taxonomy = parseTaxonomy(c);
    if (!taxonomy) return errorResponse(c, 404, 'NOT_FOUND');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createTaxonomyTermRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      taxonomy,
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
      now: currentTime(),
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'TAXONOMY_SLUG_CONFLICT');
    }
    return c.json(taxonomyMutationSuccessSchema.parse({
      success: true,
      data: result.term,
    }), 201);
  });

  routes.put('/:taxonomy/:id', mutationBodyLimit(), async (c) => {
    const taxonomy = parseTaxonomy(c);
    if (!taxonomy) return errorResponse(c, 404, 'NOT_FOUND');
    const id = taxonomyTermIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateTaxonomyTermRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await update({
      db: c.env.DB,
      taxonomy,
      id: id.data,
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'TAXONOMY_TERM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'TAXONOMY_REVISION_CONFLICT');
    }
    if (result.kind === 'slug_conflict') {
      return errorResponse(c, 409, 'TAXONOMY_SLUG_CONFLICT');
    }
    return c.json(taxonomyMutationSuccessSchema.parse({
      success: true,
      data: result.term,
    }));
  });

  routes.delete('/:taxonomy/:id', mutationBodyLimit(), async (c) => {
    const taxonomy = parseTaxonomy(c);
    if (!taxonomy) return errorResponse(c, 404, 'NOT_FOUND');
    const id = taxonomyTermIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteTaxonomyTermRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await remove({
      db: c.env.DB,
      taxonomy,
      id: id.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'TAXONOMY_TERM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'TAXONOMY_REVISION_CONFLICT');
    }
    if (result.kind === 'in_use') {
      return errorResponse(c, 409, 'TAXONOMY_TERM_IN_USE');
    }
    return c.json(taxonomyDeleteSuccessSchema.parse({
      success: true,
      data: {
        status: 'taxonomy_term_deleted',
        taxonomy,
        id: id.data,
      },
    }));
  });

  return routes;
}
