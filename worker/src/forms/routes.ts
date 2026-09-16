import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  createFormRequestSchema,
  deleteFormRequestSchema,
  deleteFormSubmissionRequestSchema,
  formDeleteSuccessSchema,
  formDetailSuccessSchema,
  formFieldsSuccessSchema,
  formIdSchema,
  formListQuerySchema,
  formListSuccessSchema,
  formNotificationRecipientCandidateQuerySchema,
  formNotificationRecipientCandidatesSuccessSchema,
  formNotificationSettingsSuccessSchema,
  formSubmissionDetailSuccessSchema,
  formSubmissionMutationSuccessSchema,
  formSubmissionsQuerySchema,
  formSubmissionsSuccessSchema,
  replaceFormFieldsRequestSchema,
  updateFormNotificationSettingsRequestSchema,
  updateFormRequestSchema,
  updateFormSubmissionRequestSchema,
} from '../../../contracts/forms';
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
  invalidateFormInfoCache,
  requireFormsEdgeDatabase,
  requireFormsEdgeKv,
} from './edge-resources';
import {
  createForm,
  deleteForm,
  deleteFormSubmission,
  getForm,
  getFormSubmission,
  listFormNotificationRecipientCandidates,
  listFormFields,
  listForms,
  listFormSubmissions,
  readFormNotificationSettings,
  replaceFormFields,
  updateForm,
  updateFormNotificationSettings,
  updateFormSubmission,
} from './management-repository';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';

const FORM_MUTATION_BODY_LIMIT = 1024 * 1024;

export type FormRouteDependencies = {
  resolveSession?: ResolveUserSession;
  list?: typeof listForms;
  get?: typeof getForm;
  create?: typeof createForm;
  update?: typeof updateForm;
  remove?: typeof deleteForm;
  listFields?: typeof listFormFields;
  replaceFields?: typeof replaceFormFields;
  listSubmissions?: typeof listFormSubmissions;
  getSubmission?: typeof getFormSubmission;
  updateSubmission?: typeof updateFormSubmission;
  deleteSubmission?: typeof deleteFormSubmission;
  listNotificationRecipients?: typeof listFormNotificationRecipientCandidates;
  readNotificationSettings?: typeof readFormNotificationSettings;
  updateNotificationSettings?: typeof updateFormNotificationSettings;
  readMailSettings?: typeof readMailSettings;
  invalidateCache?: typeof invalidateFormInfoCache;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

function parseQuery(c: Context<StudioHonoEnvironment>) {
  return Object.fromEntries(new URL(c.req.url).searchParams.entries());
}

function mutationLimit() {
  return bodyLimit({
    maxSize: FORM_MUTATION_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createFormRoutes(dependencies: FormRouteDependencies = {}) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.list ?? listForms;
  const get = dependencies.get ?? getForm;
  const create = dependencies.create ?? createForm;
  const update = dependencies.update ?? updateForm;
  const remove = dependencies.remove ?? deleteForm;
  const listFields = dependencies.listFields ?? listFormFields;
  const replaceFields = dependencies.replaceFields ?? replaceFormFields;
  const listSubmissions = dependencies.listSubmissions ?? listFormSubmissions;
  const getSubmission = dependencies.getSubmission ?? getFormSubmission;
  const updateSubmission = dependencies.updateSubmission ?? updateFormSubmission;
  const removeSubmission = dependencies.deleteSubmission ?? deleteFormSubmission;
  const listNotificationRecipients = dependencies.listNotificationRecipients
    ?? listFormNotificationRecipientCandidates;
  const readNotificationSettings = dependencies.readNotificationSettings
    ?? readFormNotificationSettings;
  const updateNotificationSettings = dependencies.updateNotificationSettings
    ?? updateFormNotificationSettings;
  const readMail = dependencies.readMailSettings ?? readMailSettings;
  const invalidateCache = dependencies.invalidateCache ?? invalidateFormInfoCache;

  async function requireManager(c: Context<StudioHonoEnvironment>) {
    const session = await requireStudioCapability({
      context: c,
      capability: 'forms.manage',
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
    const query = formListQuerySchema.safeParse(parseQuery(c));
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    return c.json(formListSuccessSchema.parse({
      success: true,
      data: await list({
        edgeDb: requireFormsEdgeDatabase(c.env),
        query: query.data,
      }),
    }));
  });

  routes.post('/', mutationLimit(), async (c) => {
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = createFormRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await create({
      edgeDb: requireFormsEdgeDatabase(c.env),
      request: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'already_exists') {
      return errorResponse(c, 409, 'FORM_ALREADY_EXISTS');
    }
    await invalidateCache({
      edgeKv: requireFormsEdgeKv(c.env),
      slug: result.value.slug,
    });
    return c.json(formDetailSuccessSchema.parse({
      success: true,
      data: result.value,
    }), 201);
  });

  routes.get('/notification-recipient-candidates', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const query = formNotificationRecipientCandidateQuerySchema.safeParse(
      parseQuery(c),
    );
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    return c.json(formNotificationRecipientCandidatesSuccessSchema.parse({
      success: true,
      data: await listNotificationRecipients({
        db: c.env.DB,
        query: query.data,
      }),
    }));
  });

  routes.get('/:id/notification-settings', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const mail = await readMail({ db: c.env.DB });
    const result = await readNotificationSettings({
      db: c.env.DB,
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      mailConfigured: mail.configured,
    });
    if (!result) return errorResponse(c, 404, 'FORM_NOT_FOUND');
    return c.json(formNotificationSettingsSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.put('/:id/notification-settings', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = updateFormNotificationSettingsRequestSchema.safeParse(
      request.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const mail = await readMail({ db: c.env.DB });
    const result = await updateNotificationSettings({
      db: c.env.DB,
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      request: parsed.data,
      mailConfigured: mail.configured,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'FORM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    if (result.kind === 'recipient_unavailable') {
      return errorResponse(c, 409, 'FORM_NOTIFICATION_RECIPIENT_NOT_AVAILABLE');
    }
    return c.json(formNotificationSettingsSuccessSchema.parse({
      success: true,
      data: result.value,
    }));
  });

  routes.get('/:id', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await get({
      edgeDb: requireFormsEdgeDatabase(c.env),
      id: id.data,
    });
    if (!result) return errorResponse(c, 404, 'FORM_NOT_FOUND');
    return c.json(formDetailSuccessSchema.parse({ success: true, data: result }));
  });

  routes.patch('/:id', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = updateFormRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await update({
      edgeDb: requireFormsEdgeDatabase(c.env),
      id: id.data,
      update: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'FORM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    if (result.kind === 'invalid') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    await invalidateCache({
      edgeKv: requireFormsEdgeKv(c.env),
      slug: result.value.slug,
    });
    return c.json(formDetailSuccessSchema.parse({
      success: true,
      data: result.value,
    }));
  });

  routes.delete('/:id', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = deleteFormRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await remove({
      edgeDb: requireFormsEdgeDatabase(c.env),
      id: id.data,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'FORM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    if (result.kind === 'has_submissions') {
      return errorResponse(c, 409, 'FORM_HAS_SUBMISSIONS');
    }
    await invalidateCache({
      edgeKv: requireFormsEdgeKv(c.env),
      slug: result.slug,
    });
    return c.json(formDeleteSuccessSchema.parse({
      success: true,
      data: { deleted: true },
    }));
  });

  routes.get('/:id/fields', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await listFields({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
    });
    if (!result) return errorResponse(c, 404, 'FORM_NOT_FOUND');
    return c.json(formFieldsSuccessSchema.parse({
      success: true,
      data: {
        items: result.items,
        form_updated_at_iso: result.formUpdatedAtIso,
      },
    }));
  });

  routes.put('/:id/fields', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = replaceFormFieldsRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await replaceFields({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      request: parsed.data,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'FORM_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    if (result.kind === 'invalid') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const form = await get({
      edgeDb: requireFormsEdgeDatabase(c.env),
      id: id.data,
    });
    if (!form) return errorResponse(c, 404, 'FORM_NOT_FOUND');
    await invalidateCache({
      edgeKv: requireFormsEdgeKv(c.env),
      slug: form.slug,
    });
    return c.json(formFieldsSuccessSchema.parse({
      success: true,
      data: {
        items: result.value.items,
        form_updated_at_iso: result.value.formUpdatedAtIso,
      },
    }));
  });

  routes.get('/:id/submissions', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = formIdSchema.safeParse(c.req.param('id'));
    const query = formSubmissionsQuerySchema.safeParse(parseQuery(c));
    if (!id.success || !query.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const result = await listSubmissions({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      query: query.data,
    });
    if (!result) return errorResponse(c, 404, 'FORM_NOT_FOUND');
    return c.json(formSubmissionsSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.get('/:id/submissions/:submissionId', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const id = formIdSchema.safeParse(c.req.param('id'));
    const submissionId = formIdSchema.safeParse(c.req.param('submissionId'));
    if (!id.success || !submissionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const result = await getSubmission({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      submissionId: submissionId.data,
    });
    if (!result) return errorResponse(c, 404, 'FORM_SUBMISSION_NOT_FOUND');
    return c.json(formSubmissionDetailSuccessSchema.parse({
      success: true,
      data: result,
    }));
  });

  routes.patch('/:id/submissions/:submissionId', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    const submissionId = formIdSchema.safeParse(c.req.param('submissionId'));
    if (!id.success || !submissionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = updateFormSubmissionRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await updateSubmission({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      submissionId: submissionId.data,
      status: parsed.data.status,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
      now: dependencies.now?.() ?? new Date(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'FORM_SUBMISSION_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    if (result.kind === 'invalid') {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    return c.json(formSubmissionMutationSuccessSchema.parse({
      success: true,
      data: result.value,
    }));
  });

  routes.delete('/:id/submissions/:submissionId', mutationLimit(), async (c) => {
    const id = formIdSchema.safeParse(c.req.param('id'));
    const submissionId = formIdSchema.safeParse(c.req.param('submissionId'));
    if (!id.success || !submissionId.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const request = await readMutationBody(c);
    if ('response' in request) return request.response;
    const parsed = deleteFormSubmissionRequestSchema.safeParse(request.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const result = await removeSubmission({
      edgeDb: requireFormsEdgeDatabase(c.env),
      formId: id.data,
      submissionId: submissionId.data,
      expectedUpdatedAtIso: parsed.data.expected_updated_at_iso,
    });
    if (result === 'not_found') {
      return errorResponse(c, 404, 'FORM_SUBMISSION_NOT_FOUND');
    }
    if (result === 'revision_conflict') {
      return errorResponse(c, 409, 'FORM_REVISION_CONFLICT');
    }
    return c.json(formDeleteSuccessSchema.parse({
      success: true,
      data: { deleted: true },
    }));
  });

  return routes;
}
