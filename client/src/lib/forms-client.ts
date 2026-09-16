import { studioFetch } from './studio-fetch';
import {
  formDeleteResponseSchema,
  formDetailResponseSchema,
  formFieldsResponseSchema,
  formListResponseSchema,
  formNotificationRecipientCandidatesResponseSchema,
  formNotificationSettingsResponseSchema,
  formSubmissionDetailResponseSchema,
  formSubmissionMutationResponseSchema,
  formSubmissionsResponseSchema,
  type CreateFormRequest,
  type FormListQuery,
  type FormNotificationRecipientCandidateQuery,
  type FormSubmissionsQuery,
  type ReplaceFormFieldsRequest,
  type UpdateFormRequest,
} from '../../../contracts/forms';

const FORMS_TIMEOUT_MS = 30_000;

export type FormsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class FormsClientError extends Error {
  constructor(public readonly code: FormsClientErrorCode) {
    super(code);
    this.name = 'FormsClientError';
  }
}

async function requestApi<T>(input: {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: boolean; data?: T };
}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FORMS_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(input.path, {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(input.csrfToken ? { 'X-ZeroPress-CSRF': input.csrfToken } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new FormsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new FormsClientError('INVALID_RESPONSE');
    return parsed.data as T;
  } catch (error) {
    if (error instanceof FormsClientError) throw error;
    if (controller.signal.aborted) throw new FormsClientError('TIMEOUT');
    throw new FormsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function queryString(values: Record<string, unknown>): string {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) => (
      typeof value === 'string' || typeof value === 'number'
        ? [[key, String(value)]]
        : []
    )),
  ).toString();
}

function schemaParser<T>(schema: {
  safeParse(value: unknown): { success: boolean; data?: T };
}) {
  return (value: unknown) => schema.safeParse(value);
}

export function requestForms(query: FormListQuery, signal?: AbortSignal) {
  return requestApi({
    path: `/api/forms?${queryString(query)}`,
    signal,
    parse: schemaParser(formListResponseSchema),
  });
}

export function requestForm(id: string, signal?: AbortSignal) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}`,
    signal,
    parse: schemaParser(formDetailResponseSchema),
  });
}

export function requestCreateForm(
  csrfToken: string,
  request: CreateFormRequest,
) {
  return requestApi({
    path: '/api/forms',
    method: 'POST',
    csrfToken,
    body: request,
    parse: schemaParser(formDetailResponseSchema),
  });
}

export function requestUpdateForm(
  csrfToken: string,
  id: string,
  request: UpdateFormRequest,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}`,
    method: 'PATCH',
    csrfToken,
    body: request,
    parse: schemaParser(formDetailResponseSchema),
  });
}

export function requestDeleteForm(
  csrfToken: string,
  id: string,
  expectedUpdatedAtIso: string,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}`,
    method: 'DELETE',
    csrfToken,
    body: { expected_updated_at_iso: expectedUpdatedAtIso },
    parse: schemaParser(formDeleteResponseSchema),
  });
}

export function requestFormNotificationRecipientCandidates(
  query: FormNotificationRecipientCandidateQuery,
  signal?: AbortSignal,
) {
  return requestApi({
    path: `/api/forms/notification-recipient-candidates?${queryString(query)}`,
    signal,
    parse: schemaParser(formNotificationRecipientCandidatesResponseSchema),
  });
}

export function requestFormNotificationSettings(
  id: string,
  signal?: AbortSignal,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/notification-settings`,
    signal,
    parse: schemaParser(formNotificationSettingsResponseSchema),
  });
}

export function requestUpdateFormNotificationSettings(
  csrfToken: string,
  id: string,
  recipientUserId: string | null,
  expectedUpdatedAtIso: string,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/notification-settings`,
    method: 'PUT',
    csrfToken,
    body: {
      recipient_user_id: recipientUserId,
      expected_updated_at_iso: expectedUpdatedAtIso,
    },
    parse: schemaParser(formNotificationSettingsResponseSchema),
  });
}

export function requestFormFields(id: string, signal?: AbortSignal) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/fields`,
    signal,
    parse: schemaParser(formFieldsResponseSchema),
  });
}

export function requestReplaceFormFields(
  csrfToken: string,
  id: string,
  request: ReplaceFormFieldsRequest,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/fields`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse: schemaParser(formFieldsResponseSchema),
  });
}

export function requestFormSubmissions(
  id: string,
  query: FormSubmissionsQuery,
  signal?: AbortSignal,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/submissions?${queryString(query)}`,
    signal,
    parse: schemaParser(formSubmissionsResponseSchema),
  });
}

export function requestFormSubmission(
  id: string,
  submissionId: string,
  signal?: AbortSignal,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submissionId)}`,
    signal,
    parse: schemaParser(formSubmissionDetailResponseSchema),
  });
}

export function requestUpdateFormSubmission(
  csrfToken: string,
  id: string,
  submissionId: string,
  status: 'unread' | 'read' | 'archived' | 'spam',
  expectedUpdatedAtIso: string,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submissionId)}`,
    method: 'PATCH',
    csrfToken,
    body: { status, expected_updated_at_iso: expectedUpdatedAtIso },
    parse: schemaParser(formSubmissionMutationResponseSchema),
  });
}

export function requestDeleteFormSubmission(
  csrfToken: string,
  id: string,
  submissionId: string,
  expectedUpdatedAtIso: string,
) {
  return requestApi({
    path: `/api/forms/${encodeURIComponent(id)}/submissions/${encodeURIComponent(submissionId)}`,
    method: 'DELETE',
    csrfToken,
    body: { expected_updated_at_iso: expectedUpdatedAtIso },
    parse: schemaParser(formDeleteResponseSchema),
  });
}
