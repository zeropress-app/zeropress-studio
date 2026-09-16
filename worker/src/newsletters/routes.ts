import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  createNewsletterSuppressionRequestSchema,
  exportNewsletterSubscriptionsQuerySchema,
  newsletterDeliveriesQuerySchema,
  newsletterDeliveriesSuccessSchema,
  newsletterDetailSuccessSchema,
  newsletterFieldsSuccessSchema,
  newsletterIdSchema,
  newsletterListQuerySchema,
  newsletterListSuccessSchema,
  newsletterRuntimeSuccessSchema,
  newsletterSubscriptionDeleteSuccessSchema,
  newsletterSubscriptionDetailSuccessSchema,
  newsletterSubscriptionMutationSuccessSchema,
  newsletterSubscriptionsQuerySchema,
  newsletterSubscriptionsSuccessSchema,
  newsletterSuppressionDeleteSuccessSchema,
  newsletterSuppressionMutationSuccessSchema,
  newsletterSuppressionsQuerySchema,
  newsletterSuppressionsSuccessSchema,
  replaceNewsletterFieldsRequestSchema,
  updateNewsletterRequestSchema,
  updateNewsletterRuntimeRequestSchema,
} from '../../../contracts/newsletters';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { readMailSettings } from '../mail/settings-repository';
import type { StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import {
  invalidateNewsletterInfoCache,
  requireNewsletterEdgeDatabase,
  requireNewsletterEdgeKv,
} from './edge-resources';
import {
  createNewsletterSuppression,
  deleteNewsletterSubscription,
  deleteNewsletterSuppression,
  getNewsletter,
  getNewsletterSubscription,
  exportNewsletterSubscriptions,
  listNewsletterFields,
  listNewsletterDeliveries,
  listNewsletters,
  listNewsletterSubscriptions,
  listNewsletterSuppressions,
  readNewsletterRuntime,
  replaceNewsletterFields,
  unsubscribeNewsletterSubscription,
  updateNewsletter,
  updateNewsletterRuntime,
} from './management-repository';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';

const NEWSLETTER_MUTATION_BODY_LIMIT = 256 * 1024;

export type NewsletterRouteDependencies = {
  resolveSession?: ResolveUserSession;
  list?: typeof listNewsletters;
  get?: typeof getNewsletter;
  update?: typeof updateNewsletter;
  listFields?: typeof listNewsletterFields;
  listDeliveries?: typeof listNewsletterDeliveries;
  replaceFields?: typeof replaceNewsletterFields;
  listSubscriptions?: typeof listNewsletterSubscriptions;
  getSubscription?: typeof getNewsletterSubscription;
  unsubscribe?: typeof unsubscribeNewsletterSubscription;
  deleteSubscription?: typeof deleteNewsletterSubscription;
  exportSubscriptions?: typeof exportNewsletterSubscriptions;
  listSuppressions?: typeof listNewsletterSuppressions;
  createSuppression?: typeof createNewsletterSuppression;
  deleteSuppression?: typeof deleteNewsletterSuppression;
  readRuntime?: typeof readNewsletterRuntime;
  updateRuntime?: typeof updateNewsletterRuntime;
  readMailSettings?: typeof readMailSettings;
  invalidateCache?: typeof invalidateNewsletterInfoCache;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

function parseQuery(c: Context<StudioHonoEnvironment>) {
  return Object.fromEntries(new URL(c.req.url).searchParams.entries());
}

export function createNewsletterRoutes(
  dependencies: NewsletterRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.list ?? listNewsletters;
  const get = dependencies.get ?? getNewsletter;
  const update = dependencies.update ?? updateNewsletter;
  const listFields = dependencies.listFields ?? listNewsletterFields;
  const listDeliveries = dependencies.listDeliveries
    ?? listNewsletterDeliveries;
  const replaceFields = dependencies.replaceFields ?? replaceNewsletterFields;
  const listSubscriptions = dependencies.listSubscriptions
    ?? listNewsletterSubscriptions;
  const getSubscription = dependencies.getSubscription
    ?? getNewsletterSubscription;
  const unsubscribe = dependencies.unsubscribe
    ?? unsubscribeNewsletterSubscription;
  const removeSubscription = dependencies.deleteSubscription
    ?? deleteNewsletterSubscription;
  const exportSubscriptions = dependencies.exportSubscriptions
    ?? exportNewsletterSubscriptions;
  const listSuppressions = dependencies.listSuppressions
    ?? listNewsletterSuppressions;
  const createSuppression = dependencies.createSuppression
    ?? createNewsletterSuppression;
  const removeSuppression = dependencies.deleteSuppression
    ?? deleteNewsletterSuppression;
  const readRuntime = dependencies.readRuntime ?? readNewsletterRuntime;
  const updateRuntime = dependencies.updateRuntime ?? updateNewsletterRuntime;
  const readMail = dependencies.readMailSettings ?? readMailSettings;
  const invalidateCache = dependencies.invalidateCache
    ?? invalidateNewsletterInfoCache;

  async function requireManager(c: Context<StudioHonoEnvironment>) {
    const session = await requireStudioCapability({
      context: c,
      capability: 'newsletters.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    return await requireEdgeIntegrationReady(
      c,
      dependencies.readEdgeIntegrationMode,
      dependencies.inspectEdgeDatabaseRuntime,
    ) ?? session;
  }

  async function requireExporter(c: Context<StudioHonoEnvironment>) {
    const session = await requireStudioCapability({
      context: c,
      capability: 'newsletters.export',
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
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  async function readMutationBody(c: Context<StudioHonoEnvironment>) {
    const session = await authorizeMutation(c);
    if (session instanceof Response) return { response: session };
    const body = await readJsonBody(c);
    if (!body.valid) return { response: body.response };
    return { value: body.value, session };
  }

  routes.get('/', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const query = newsletterListQuerySchema.safeParse(parseQuery(c));
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    return c.json(newsletterListSuccessSchema.parse({
      success: true,
      data: await list({
        edgeDb: requireNewsletterEdgeDatabase(c.env),
        query: query.data,
      }),
    }));
  });

  routes.get('/runtime', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const mail = await readMail({ db: c.env.DB });
    return c.json(newsletterRuntimeSuccessSchema.parse({
      success: true,
      data: await readRuntime({
        edgeDb: requireNewsletterEdgeDatabase(c.env),
        mailConfigured: mail.configured,
      }),
    }));
  });

  routes.put('/runtime', bodyLimit({
    maxSize: NEWSLETTER_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = updateNewsletterRuntimeRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const mail = await readMail({ db: c.env.DB });
    const result = await updateRuntime({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      confirmationEnabled: parsed.data.confirmation_enabled,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
      mailConfigured: mail.configured,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'NEWSLETTER_REVISION_CONFLICT');
    }
    if (result.kind === 'mail_not_configured') {
      return errorResponse(c, 409, 'NEWSLETTER_MAIL_NOT_CONFIGURED');
    }
    return c.json(newsletterRuntimeSuccessSchema.parse({
      success: true,
      data: result.value,
    }));
  });

  routes.get('/suppressions', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const query = newsletterSuppressionsQuerySchema.safeParse(parseQuery(c));
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    return c.json(newsletterSuppressionsSuccessSchema.parse({
      success: true,
      data: await listSuppressions({
        edgeDb: requireNewsletterEdgeDatabase(c.env),
        query: query.data,
      }),
    }));
  });

  routes.post('/suppressions', bodyLimit({
    maxSize: NEWSLETTER_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = createNewsletterSuppressionRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await createSuppression({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      request: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    return c.json(newsletterSuppressionMutationSuccessSchema.parse({
      success: true,
      data: {
        suppression: result.suppression,
        created: result.created,
        unsubscribed_count: result.unsubscribedCount,
      },
    }), result.created ? 201 : 200);
  });

  routes.delete('/suppressions/:id', async (c) => {
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const deleted = await removeSuppression({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      id: id.data,
    });
    if (!deleted) {
      return errorResponse(c, 404, 'NEWSLETTER_SUPPRESSION_NOT_FOUND');
    }
    return c.json(newsletterSuppressionDeleteSuccessSchema.parse({
      success: true,
      data: { deleted: true },
    }));
  });

  routes.get('/:id', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await get({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      id: id.data,
    });
    if (!result) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    return c.json(newsletterDetailSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.patch('/:id', bodyLimit({
    maxSize: NEWSLETTER_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = updateNewsletterRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await update({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      id: id.data,
      update: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'NEWSLETTER_REVISION_CONFLICT');
    }
    if (result.kind === 'invalid') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    await invalidateCache({
      edgeKv: requireNewsletterEdgeKv(c.env),
      slug: result.value.slug,
    });
    return c.json(newsletterDetailSuccessSchema.parse({
      success: true,
      data: result.value,
    }));
  });

  routes.get('/:id/fields', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listFields({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
    });
    if (!result) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    return c.json(newsletterFieldsSuccessSchema.parse({
      success: true,
      data: {
        items: result.items,
        newsletter_updated_at_iso: result.newsletterUpdatedAtIso,
      },
    }));
  });

  routes.put('/:id/fields', bodyLimit({
    maxSize: NEWSLETTER_MUTATION_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = replaceNewsletterFieldsRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await replaceFields({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      request: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'NEWSLETTER_REVISION_CONFLICT');
    }
    if (result.kind === 'invalid') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const newsletter = await get({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      id: id.data,
    });
    if (!newsletter) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    await invalidateCache({
      edgeKv: requireNewsletterEdgeKv(c.env),
      slug: newsletter.slug,
    });
    return c.json(newsletterFieldsSuccessSchema.parse({
      success: true,
      data: {
        items: result.value.items,
        newsletter_updated_at_iso:
          result.value.newsletterUpdatedAtIso,
      },
    }));
  });

  routes.get('/:id/subscriptions', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const query = newsletterSubscriptionsQuerySchema.safeParse(parseQuery(c));
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listSubscriptions({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      query: query.data,
    });
    if (!result) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    return c.json(newsletterSubscriptionsSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/:id/deliveries', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const query = newsletterDeliveriesQuerySchema.safeParse(parseQuery(c));
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listDeliveries({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      query: query.data,
    });
    if (!result) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    return c.json(newsletterDeliveriesSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/:id/subscriptions/export.csv', async (c) => {
    const session = await requireExporter(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    const query = exportNewsletterSubscriptionsQuerySchema.safeParse(
      parseQuery(c),
    );
    if (!id.success || !query.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const result = await exportSubscriptions({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      query: query.data,
    });
    if (!result) return errorResponse(c, 404, 'NEWSLETTER_NOT_FOUND');
    const body = new Uint8Array(result.byteCount);
    let offset = 0;
    for (const chunk of result.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const date = (dependencies.now?.() ?? new Date())
      .toISOString()
      .slice(0, 10);
    const slug = result.newsletter.slug.replace(/[^a-z0-9._-]+/gu, '-');
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition':
          `attachment; filename="newsletter-${slug || 'subscribers'}-${date}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Export-Row-Count': String(result.rowCount),
        'X-Export-Row-Limit': String(result.rowLimit),
        'X-Export-Byte-Count': String(result.byteCount),
        'X-Export-Byte-Limit': String(result.byteLimit),
        'X-Export-Truncated': String(result.truncated),
        'X-Export-Truncation-Reason':
          result.truncationReason ?? 'none',
      },
    });
  });

  routes.get('/:id/subscriptions/:subscriptionId', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    const subscriptionId = newsletterIdSchema.safeParse(
      c.req.param('subscriptionId'),
    );
    if (!id.success || !subscriptionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const result = await getSubscription({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      subscriptionId: subscriptionId.data,
    });
    if (!result) {
      return errorResponse(c, 404, 'NEWSLETTER_SUBSCRIPTION_NOT_FOUND');
    }
    return c.json(newsletterSubscriptionDetailSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.post('/:id/subscriptions/:subscriptionId/unsubscribe', async (c) => {
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    const subscriptionId = newsletterIdSchema.safeParse(
      c.req.param('subscriptionId'),
    );
    if (!id.success || !subscriptionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await unsubscribe({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      subscriptionId: subscriptionId.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (!result) {
      return errorResponse(c, 404, 'NEWSLETTER_SUBSCRIPTION_NOT_FOUND');
    }
    return c.json(newsletterSubscriptionMutationSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.delete('/:id/subscriptions/:subscriptionId', async (c) => {
    const id = newsletterIdSchema.safeParse(c.req.param('id'));
    const subscriptionId = newsletterIdSchema.safeParse(
      c.req.param('subscriptionId'),
    );
    if (!id.success || !subscriptionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await removeSubscription({
      edgeDb: requireNewsletterEdgeDatabase(c.env),
      newsletterId: id.data,
      subscriptionId: subscriptionId.data,
    });
    if (!result) {
      return errorResponse(c, 404, 'NEWSLETTER_SUBSCRIPTION_NOT_FOUND');
    }
    return c.json(newsletterSubscriptionDeleteSuccessSchema.parse({
      success: true,
      data: {
        deleted: true,
        subscriber_deleted: result.subscriberDeleted,
      },
    }));
  });

  return routes;
}
