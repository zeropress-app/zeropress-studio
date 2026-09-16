import {
  formFieldSchema,
  formNotificationRecipientIdentitySchema,
  formNotificationSettingsSchema,
  formSubmissionDetailSchema,
  formSubmissionSchema,
  formSummarySchema,
  type CreateFormRequest,
  type FormField,
  type FormFieldInput,
  type FormListQuery,
  type FormNotificationRecipientCandidateQuery,
  type FormNotificationRecipientIdentity,
  type FormNotificationSettings,
  type FormSubmission,
  type FormSubmissionDetail,
  type FormSubmissionsQuery,
  type FormSummary,
  type ReplaceFormFieldsRequest,
  type UpdateFormNotificationSettingsRequest,
  type UpdateFormRequest,
} from '../../../contracts/forms';
import { StudioOperationalError } from '../lib/operational-error';

type FormRow = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  submit_label?: unknown;
  success_message?: unknown;
  notification_recipient_user_id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  fields_count?: unknown;
  submissions_count?: unknown;
  unread_count?: unknown;
  last_submitted_at?: unknown;
};

type FieldRow = {
  id?: unknown;
  form_id?: unknown;
  field_key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  placeholder?: unknown;
  help_text?: unknown;
  options_json?: unknown;
  sort_order?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  values_count?: unknown;
};

type SubmissionRow = {
  id?: unknown;
  form_id?: unknown;
  status?: unknown;
  summary?: unknown;
  submitter_email?: unknown;
  submitter_name?: unknown;
  source_url?: unknown;
  country_code?: unknown;
  submitted_at?: unknown;
  read_at?: unknown;
  archived_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type SubmissionValueRow = {
  field_id?: unknown;
  field_key?: unknown;
  field_label?: unknown;
  field_type?: unknown;
  field_value?: unknown;
};

type RecipientRow = {
  id?: unknown;
  name?: unknown;
  email?: unknown;
  status?: unknown;
  email_verified?: unknown;
  eligible?: unknown;
};

export type Pagination = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
};

export type ExpectedMutationResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'invalid' };

function queryFailure(
  error: unknown,
  action: string,
  resource = 'EDGE_DB',
): StudioOperationalError {
  return new StudioOperationalError('FORM_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource, action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('FORM_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function dataInvalid(cause?: unknown, resource = 'EDGE_DB'): StudioOperationalError {
  return new StudioOperationalError('FORM_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource, action: 'validate_form_data' },
  });
}

function createId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function parseCount(value: unknown, resource = 'EDGE_DB'): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw dataInvalid(
      new TypeError('D1 returned an invalid Form count.'),
      resource,
    );
  }
  return number;
}

function parseSqlBoolean(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) {
    throw dataInvalid(new TypeError(`D1 returned an invalid ${name}.`));
  }
  return value === 1;
}

function readChanges(result: D1Result<unknown> | undefined): number {
  return parseCount(result?.meta?.changes);
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw dataInvalid();
  const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value}Z`
    : value;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) throw dataInvalid();
  return new Date(timestamp).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : normalizeTimestamp(value);
}

function formatEdgeTimestamp(value: Date, previous?: unknown): string {
  const now = value.getTime();
  const previousTime = previous === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(normalizeTimestamp(previous));
  if (!Number.isFinite(now) || Number.isNaN(previousTime)) {
    throw new TypeError('Form mutation time must be valid.');
  }
  const next = Math.max(Math.floor(now / 1_000) * 1_000, previousTime + 1_000);
  return new Date(next).toISOString().replace('.000Z', 'Z');
}

function parseForm(row: FormRow): FormSummary {
  const parsed = formSummarySchema.safeParse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    submit_label: row.submit_label,
    success_message: row.success_message ?? null,
    fields_count: parseCount(row.fields_count),
    submissions_count: parseCount(row.submissions_count),
    unread_count: parseCount(row.unread_count),
    last_submitted_at_iso: nullableTimestamp(row.last_submitted_at),
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseOptions(value: unknown): Array<{ value: string; label: string }> {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'string') throw dataInvalid();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new TypeError('Field options are not an array.');
    return parsed.map((option) => {
      if (
        !option
        || typeof option !== 'object'
        || !('value' in option)
        || typeof option.value !== 'string'
        || !('label' in option)
        || typeof option.label !== 'string'
      ) throw new TypeError('Field option is invalid.');
      return { value: option.value, label: option.label };
    });
  } catch (error) {
    throw dataInvalid(error);
  }
}

function parseField(row: FieldRow): FormField {
  const parsed = formFieldSchema.safeParse({
    id: row.id,
    form_id: row.form_id,
    field_key: row.field_key,
    label: row.label,
    type: row.type,
    required: parseSqlBoolean(row.required, 'Form field required flag'),
    placeholder: row.placeholder ?? null,
    help_text: row.help_text ?? null,
    options: parseOptions(row.options_json),
    sort_order: Number(row.sort_order),
    status: row.status,
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function sanitizeSourceUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw dataInvalid();
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function parseSubmission(row: SubmissionRow): FormSubmission {
  const parsed = formSubmissionSchema.safeParse({
    id: row.id,
    form_id: row.form_id,
    status: row.status,
    summary: row.summary ?? null,
    submitter_email: row.submitter_email ?? null,
    submitter_name: row.submitter_name ?? null,
    source_url: sanitizeSourceUrl(row.source_url),
    country_code: row.country_code ?? null,
    submitted_at_iso: normalizeTimestamp(row.submitted_at),
    read_at_iso: nullableTimestamp(row.read_at),
    archived_at_iso: nullableTimestamp(row.archived_at),
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseSubmissionDetail(
  row: SubmissionRow,
  values: SubmissionValueRow[],
): FormSubmissionDetail {
  const parsed = formSubmissionDetailSchema.safeParse({
    ...parseSubmission(row),
    values: values.map((value) => ({
      field_id: value.field_id ?? null,
      field_key: value.field_key,
      label: value.field_label,
      type: value.field_type,
      value: value.field_value,
    })),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function pagination(total: number, page: number, perPage: number): Pagination {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
  };
}

const FORM_SELECT = `
  SELECT
    f.*,
    (SELECT COUNT(*) FROM form_fields ff WHERE ff.form_id = f.id)
      AS fields_count,
    (SELECT COUNT(*) FROM form_submissions fs WHERE fs.form_id = f.id)
      AS submissions_count,
    (SELECT COUNT(*) FROM form_submissions fs
      WHERE fs.form_id = f.id AND fs.status = 'unread') AS unread_count,
    (SELECT MAX(submitted_at) FROM form_submissions fs
      WHERE fs.form_id = f.id) AS last_submitted_at
  FROM forms f
`;

export async function listForms(input: {
  edgeDb: D1Database;
  query: FormListQuery;
}): Promise<{ items: FormSummary[]; pagination: Pagination }> {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  if (input.query.status !== 'all') {
    clauses.push('f.status = ?');
    parameters.push(input.query.status);
  }
  if (input.query.search) {
    clauses.push(`(
      instr(lower(f.title), lower(?)) > 0
      OR instr(lower(f.slug), lower(?)) > 0
    )`);
    const search = input.query.search;
    parameters.push(search, search);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, count] = await Promise.all([
      input.edgeDb.prepare(`
        ${FORM_SELECT}
        ${where}
        ORDER BY f.updated_at DESC, f.title ASC, f.id ASC
        LIMIT ? OFFSET ?
      `).bind(...parameters, input.query.per_page, offset).all<FormRow>(),
      input.edgeDb.prepare(`SELECT COUNT(*) AS total FROM forms f ${where}`)
        .bind(...parameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total);
    return {
      items: (rows.results ?? []).map(parseForm),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_forms');
  }
}

export async function getForm(input: {
  edgeDb: D1Database;
  id: string;
}): Promise<FormSummary | null> {
  try {
    const row = await input.edgeDb.prepare(`${FORM_SELECT} WHERE f.id = ?`)
      .bind(input.id).first<FormRow>();
    return row ? parseForm(row) : null;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'get_form');
  }
}

const ELIGIBLE_FORM_RECIPIENT_SQL = `
  u.status = 'active'
  AND u.email_verified = 1
  AND EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE ur.user_id = u.id
      AND ur.role_key IN ('admin', 'editor')
  )
`;

function parseRecipientIdentity(row: RecipientRow): FormNotificationRecipientIdentity {
  const parsed = formNotificationRecipientIdentitySchema.safeParse({
    id: row.id,
    name: row.name,
    email: row.email,
  });
  if (!parsed.success) throw dataInvalid(parsed.error, 'DB');
  return parsed.data;
}

async function readRecipientRow(input: {
  db: D1Database;
  userId: string;
}): Promise<RecipientRow | null> {
  try {
    return await input.db.prepare(`
      SELECT u.id, u.name, u.email, u.status, u.email_verified,
        CASE WHEN ${ELIGIBLE_FORM_RECIPIENT_SQL} THEN 1 ELSE 0 END AS eligible
      FROM users u
      WHERE u.id = ?
    `).bind(input.userId).first<RecipientRow>();
  } catch (error) {
    throw queryFailure(error, 'read_form_notification_recipient', 'DB');
  }
}

export async function listFormNotificationRecipientCandidates(input: {
  db: D1Database;
  query: FormNotificationRecipientCandidateQuery;
}): Promise<{
  items: FormNotificationRecipientIdentity[];
  pagination: Pagination;
}> {
  const searchSql = input.query.search
    ? `AND (
        instr(lower(u.name), lower(?)) > 0
        OR instr(lower(u.email), lower(?)) > 0
      )`
    : '';
  const searchParameters = input.query.search
    ? [input.query.search, input.query.search]
    : [];
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, count] = await Promise.all([
      input.db.prepare(`
        SELECT u.id, u.name, u.email
        FROM users u
        WHERE ${ELIGIBLE_FORM_RECIPIENT_SQL}
          ${searchSql}
        ORDER BY lower(u.name) ASC, lower(u.email) ASC, u.id ASC
        LIMIT ? OFFSET ?
      `).bind(
        ...searchParameters,
        input.query.per_page,
        offset,
      ).all<RecipientRow>(),
      input.db.prepare(`
        SELECT COUNT(*) AS total
        FROM users u
        WHERE ${ELIGIBLE_FORM_RECIPIENT_SQL}
          ${searchSql}
      `).bind(...searchParameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total, 'DB');
    return {
      items: (rows.results ?? []).map(parseRecipientIdentity),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_form_notification_recipients', 'DB');
  }
}

export async function readFormNotificationSettings(input: {
  db: D1Database;
  edgeDb: D1Database;
  formId: string;
  mailConfigured: boolean;
}): Promise<FormNotificationSettings | null> {
  let row: FormRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT id, notification_recipient_user_id, updated_at
      FROM forms
      WHERE id = ?
    `).bind(input.formId).first<FormRow>();
  } catch (error) {
    throw queryFailure(error, 'read_form_notification_settings');
  }
  if (!row) return null;
  const recipientUserId = row.notification_recipient_user_id;
  let recipient: FormNotificationSettings['recipient'] = null;
  if (recipientUserId !== null && recipientUserId !== undefined) {
    if (typeof recipientUserId !== 'string') throw dataInvalid();
    const user = await readRecipientRow({ db: input.db, userId: recipientUserId });
    recipient = user && user.eligible === 1
      ? { state: 'available', ...parseRecipientIdentity(user) }
      : {
          state: 'unavailable',
          id: recipientUserId,
          name: user && typeof user.name === 'string' ? user.name : null,
          email: user && typeof user.email === 'string' ? user.email : null,
        };
  }
  const parsed = formNotificationSettingsSchema.safeParse({
    recipient,
    mail_configured: input.mailConfigured,
    form_updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

export async function updateFormNotificationSettings(input: {
  db: D1Database;
  edgeDb: D1Database;
  formId: string;
  request: UpdateFormNotificationSettingsRequest;
  mailConfigured: boolean;
  now: Date;
}): Promise<
  | { kind: 'completed'; value: FormNotificationSettings }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'recipient_unavailable' }
> {
  const current = await readFormNotificationSettings(input);
  if (!current) return { kind: 'not_found' };
  if (current.form_updated_at_iso !== input.request.expected_updated_at_iso) {
    return { kind: 'revision_conflict' };
  }
  if (input.request.recipient_user_id) {
    const recipient = await readRecipientRow({
      db: input.db,
      userId: input.request.recipient_user_id,
    });
    if (!recipient || recipient.eligible !== 1) {
      return { kind: 'recipient_unavailable' };
    }
    parseRecipientIdentity(recipient);
  }
  const nextTimestamp = formatEdgeTimestamp(
    input.now,
    current.form_updated_at_iso,
  );
  try {
    const result = await input.edgeDb.prepare(`
      UPDATE forms
      SET notification_recipient_user_id = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).bind(
      input.request.recipient_user_id,
      nextTimestamp,
      input.formId,
      input.request.expected_updated_at_iso.replace('.000Z', 'Z'),
    ).run();
    if (readChanges(result) !== 1) {
      return await input.edgeDb.prepare('SELECT id FROM forms WHERE id = ?')
        .bind(input.formId).first()
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    const value = await readFormNotificationSettings(input);
    if (!value) throw dataInvalid();
    return { kind: 'completed', value };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_form_notification_settings');
  }
}

export async function createForm(input: {
  edgeDb: D1Database;
  request: CreateFormRequest;
  now: Date;
}): Promise<{ kind: 'completed'; value: FormSummary } | { kind: 'already_exists' }> {
  const id = createId();
  const now = formatEdgeTimestamp(input.now);
  try {
    const existing = await input.edgeDb.prepare('SELECT id FROM forms WHERE slug = ?')
      .bind(input.request.slug).first<{ id?: unknown }>();
    if (existing) return { kind: 'already_exists' };
    await input.edgeDb.prepare(`
      INSERT INTO forms (
        id, slug, title, description, status, submit_label,
        success_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.request.slug,
      input.request.title,
      input.request.description,
      input.request.status,
      input.request.submit_label,
      input.request.success_message,
      now,
      now,
    ).run();
    const value = await getForm({ edgeDb: input.edgeDb, id });
    if (!value) throw dataInvalid();
    return { kind: 'completed', value };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    if (/unique constraint failed:\s*forms\.slug/iu.test(String(error))) {
      return { kind: 'already_exists' };
    }
    throw writeFailure(error, 'create_form');
  }
}

export async function updateForm(input: {
  edgeDb: D1Database;
  id: string;
  update: UpdateFormRequest;
  now: Date;
}): Promise<ExpectedMutationResult<FormSummary>> {
  const existing = await getForm({ edgeDb: input.edgeDb, id: input.id });
  if (!existing) return { kind: 'not_found' };
  const nextTimestamp = formatEdgeTimestamp(input.now, existing.updated_at_iso);
  const next = {
    title: input.update.title ?? existing.title,
    description: input.update.description === undefined
      ? existing.description
      : input.update.description,
    status: input.update.status ?? existing.status,
    submit_label: input.update.submit_label ?? existing.submit_label,
    success_message: input.update.success_message === undefined
      ? existing.success_message
      : input.update.success_message,
  };
  try {
    const result = await input.edgeDb.prepare(`
      UPDATE forms
      SET title = ?, description = ?, status = ?, submit_label = ?,
          success_message = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).bind(
      next.title,
      next.description,
      next.status,
      next.submit_label,
      next.success_message,
      nextTimestamp,
      input.id,
      input.update.expected_updated_at_iso.replace('.000Z', 'Z'),
    ).run();
    if (readChanges(result) !== 1) {
      return await getForm({ edgeDb: input.edgeDb, id: input.id })
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    const value = await getForm({ edgeDb: input.edgeDb, id: input.id });
    if (!value) throw dataInvalid();
    return { kind: 'completed', value };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_form');
  }
}

export async function deleteForm(input: {
  edgeDb: D1Database;
  id: string;
  expectedUpdatedAtIso: string;
}): Promise<
  | { kind: 'completed'; slug: string }
  | { kind: 'not_found' }
  | { kind: 'revision_conflict' }
  | { kind: 'has_submissions' }
> {
  const existing = await getForm({ edgeDb: input.edgeDb, id: input.id });
  if (!existing) return { kind: 'not_found' };
  if (existing.updated_at_iso !== input.expectedUpdatedAtIso) {
    return { kind: 'revision_conflict' };
  }
  if (existing.submissions_count > 0) return { kind: 'has_submissions' };
  try {
    const result = await input.edgeDb.prepare(`
      DELETE FROM forms
      WHERE id = ? AND updated_at = ?
        AND NOT EXISTS (
          SELECT 1 FROM form_submissions WHERE form_id = forms.id
        )
    `).bind(input.id, input.expectedUpdatedAtIso.replace('.000Z', 'Z')).run();
    if (readChanges(result) === 1) {
      return { kind: 'completed', slug: existing.slug };
    }
    const current = await getForm({ edgeDb: input.edgeDb, id: input.id });
    if (!current) return { kind: 'not_found' };
    if (current.submissions_count > 0) return { kind: 'has_submissions' };
    return { kind: 'revision_conflict' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_form');
  }
}

async function readFieldRows(input: {
  edgeDb: D1Database;
  formId: string;
}): Promise<FieldRow[]> {
  const rows = await input.edgeDb.prepare(`
    SELECT ff.*, (
      SELECT COUNT(*) FROM form_submission_values fsv WHERE fsv.field_id = ff.id
    ) AS values_count
    FROM form_fields ff
    WHERE ff.form_id = ?
    ORDER BY ff.sort_order ASC, ff.created_at ASC, ff.id ASC
  `).bind(input.formId).all<FieldRow>();
  return rows.results ?? [];
}

export async function listFormFields(input: {
  edgeDb: D1Database;
  formId: string;
}): Promise<{ items: FormField[]; formUpdatedAtIso: string } | null> {
  const form = await getForm({ edgeDb: input.edgeDb, id: input.formId });
  if (!form) return null;
  try {
    return {
      items: (await readFieldRows(input)).map(parseField),
      formUpdatedAtIso: form.updated_at_iso,
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_form_fields');
  }
}

export async function replaceFormFields(input: {
  edgeDb: D1Database;
  formId: string;
  request: ReplaceFormFieldsRequest;
  now: Date;
}): Promise<ExpectedMutationResult<{
  items: FormField[];
  formUpdatedAtIso: string;
}>> {
  const form = await getForm({ edgeDb: input.edgeDb, id: input.formId });
  if (!form) return { kind: 'not_found' };
  if (form.updated_at_iso !== input.request.expected_updated_at_iso) {
    return { kind: 'revision_conflict' };
  }
  let existingRows: FieldRow[];
  try {
    existingRows = await readFieldRows({ edgeDb: input.edgeDb, formId: input.formId });
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_form_fields_for_replace');
  }
  const existingById = new Map(existingRows.map((field) => [String(field.id), field]));
  const existingByKey = new Map(existingRows.map((field) => [String(field.field_key), field]));
  const explicitIds = new Set(
    input.request.fields
      .map((field) => field.id)
      .filter((id): id is string => Boolean(id)),
  );
  if ([...explicitIds].some((id) => !existingById.has(id))) {
    return { kind: 'invalid' };
  }
  const resolved: Array<FormFieldInput & { id: string }> = input.request.fields.map((field) => {
    if (field.id) return { ...field, id: field.id };
    const existing = existingByKey.get(field.field_key);
    if (existing && !explicitIds.has(String(existing.id))) {
      explicitIds.add(String(existing.id));
      return { ...field, id: String(existing.id) };
    }
    return { ...field, id: createId() };
  });
  const retained = new Set(resolved.map((field) => field.id));
  for (const field of resolved) {
    const existing = existingById.get(field.id);
    if (
      existing
      && parseCount(existing.values_count) > 0
      && (existing.field_key !== field.field_key || existing.type !== field.type)
    ) return { kind: 'invalid' };
  }
  const removed = existingRows.filter((field) => !retained.has(String(field.id)));
  if (removed.some((field) => parseCount(field.values_count) > 0)) {
    return { kind: 'invalid' };
  }
  const nextTimestamp = formatEdgeTimestamp(input.now, form.updated_at_iso);
  const expected = input.request.expected_updated_at_iso.replace('.000Z', 'Z');
  const statements: D1PreparedStatement[] = [];
  if (removed.length > 0) {
    statements.push(input.edgeDb.prepare(`
      DELETE FROM form_fields
      WHERE form_id = ?
        AND id IN (${removed.map(() => '?').join(', ')})
        AND EXISTS (
          SELECT 1 FROM forms WHERE id = ? AND updated_at = ?
        )
    `).bind(
      input.formId,
      ...removed.map((field) => field.id),
      input.formId,
      expected,
    ));
  }
  // Free changed keys first so retained fields may exchange keys atomically.
  const changedKeyIds = resolved.filter((field) => {
    const existing = existingById.get(field.id);
    return existing && existing.field_key !== field.field_key;
  }).map((field) => field.id);
  if (changedKeyIds.length > 0) {
    statements.push(input.edgeDb.prepare(`
      UPDATE form_fields SET field_key = '__replace_' || id
      WHERE form_id = ? AND id IN (${changedKeyIds.map(() => '?').join(', ')})
        AND EXISTS (
          SELECT 1 FROM forms WHERE id = ? AND updated_at = ?
        )
    `).bind(input.formId, ...changedKeyIds, input.formId, expected));
  }
  for (const field of resolved) {
    const existing = existingById.get(field.id);
    if (existing) {
      statements.push(input.edgeDb.prepare(`
        UPDATE form_fields
        SET field_key = ?, label = ?, type = ?, required = ?, placeholder = ?,
            help_text = ?, options_json = ?, sort_order = ?, status = ?,
            updated_at = ?
        WHERE id = ? AND form_id = ?
          AND EXISTS (
            SELECT 1 FROM forms WHERE id = ? AND updated_at = ?
          )
      `).bind(
        field.field_key,
        field.label,
        field.type,
        field.required ? 1 : 0,
        field.placeholder,
        field.help_text,
        JSON.stringify(field.options),
        field.sort_order,
        field.status,
        nextTimestamp,
        field.id,
        input.formId,
        input.formId,
        expected,
      ));
    } else {
      statements.push(input.edgeDb.prepare(`
        INSERT INTO form_fields (
          id, form_id, field_key, label, type, required, placeholder,
          help_text, options_json, sort_order, status, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM forms WHERE id = ? AND updated_at = ?
        )
      `).bind(
        field.id,
        input.formId,
        field.field_key,
        field.label,
        field.type,
        field.required ? 1 : 0,
        field.placeholder,
        field.help_text,
        JSON.stringify(field.options),
        field.sort_order,
        field.status,
        nextTimestamp,
        nextTimestamp,
        input.formId,
        expected,
      ));
    }
  }
  statements.push(input.edgeDb.prepare(`
    UPDATE forms SET updated_at = ? WHERE id = ? AND updated_at = ?
  `).bind(nextTimestamp, input.formId, expected));
  try {
    const results = await input.edgeDb.batch(statements);
    if (readChanges(results.at(-1)) !== 1) {
      return await getForm({ edgeDb: input.edgeDb, id: input.formId })
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    const value = await listFormFields({
      edgeDb: input.edgeDb,
      formId: input.formId,
    });
    if (!value) throw dataInvalid();
    return { kind: 'completed', value };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'replace_form_fields');
  }
}

export async function listFormSubmissions(input: {
  edgeDb: D1Database;
  formId: string;
  query: FormSubmissionsQuery;
}): Promise<{
  items: FormSubmission[];
  pagination: Pagination;
  status_counts: {
    all: number;
    unread: number;
    read: number;
    archived: number;
    spam: number;
  };
} | null> {
  const form = await getForm({ edgeDb: input.edgeDb, id: input.formId });
  if (!form) return null;
  const statusSql = input.query.status === 'all' ? '' : 'AND status = ?';
  const statusParameters = input.query.status === 'all' ? [] : [input.query.status];
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, totalRow, counts] = await Promise.all([
      input.edgeDb.prepare(`
        SELECT id, form_id, status, summary, submitter_email, submitter_name,
          source_url, country_code, submitted_at, read_at, archived_at,
          created_at, updated_at
        FROM form_submissions
        WHERE form_id = ? ${statusSql}
        ORDER BY submitted_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(
        input.formId,
        ...statusParameters,
        input.query.per_page,
        offset,
      ).all<SubmissionRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total FROM form_submissions
        WHERE form_id = ? ${statusSql}
      `).bind(input.formId, ...statusParameters).first<{ total?: unknown }>(),
      input.edgeDb.prepare(`
        SELECT
          COUNT(*) AS all_count,
          SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unread_count,
          SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS read_count,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived_count,
          SUM(CASE WHEN status = 'spam' THEN 1 ELSE 0 END) AS spam_count
        FROM form_submissions WHERE form_id = ?
      `).bind(input.formId).first<Record<string, unknown>>(),
    ]);
    const total = parseCount(totalRow?.total);
    return {
      items: (rows.results ?? []).map(parseSubmission),
      pagination: pagination(total, input.query.page, input.query.per_page),
      status_counts: {
        all: parseCount(counts?.all_count),
        unread: parseCount(counts?.unread_count),
        read: parseCount(counts?.read_count),
        archived: parseCount(counts?.archived_count),
        spam: parseCount(counts?.spam_count),
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_form_submissions');
  }
}

async function readSubmissionRow(input: {
  edgeDb: D1Database;
  formId: string;
  submissionId: string;
}): Promise<SubmissionRow | null> {
  return input.edgeDb.prepare(`
    SELECT id, form_id, status, summary, submitter_email, submitter_name,
      source_url, country_code, submitted_at, read_at, archived_at,
      created_at, updated_at
    FROM form_submissions WHERE id = ? AND form_id = ?
  `).bind(input.submissionId, input.formId).first<SubmissionRow>();
}

export async function getFormSubmission(input: {
  edgeDb: D1Database;
  formId: string;
  submissionId: string;
}): Promise<FormSubmissionDetail | null> {
  try {
    const row = await readSubmissionRow(input);
    if (!row) return null;
    const values = await input.edgeDb.prepare(`
      SELECT field_id, field_key, field_label, field_type, field_value
      FROM form_submission_values
      WHERE submission_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(input.submissionId).all<SubmissionValueRow>();
    return parseSubmissionDetail(row, values.results ?? []);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'get_form_submission');
  }
}

export async function updateFormSubmission(input: {
  edgeDb: D1Database;
  formId: string;
  submissionId: string;
  status: 'unread' | 'read' | 'archived' | 'spam';
  expectedUpdatedAtIso: string;
  now: Date;
}): Promise<ExpectedMutationResult<FormSubmission>> {
  let existing: SubmissionRow | null;
  try {
    existing = await readSubmissionRow(input);
  } catch (error) {
    throw queryFailure(error, 'get_form_submission_for_update');
  }
  if (!existing) return { kind: 'not_found' };
  const existingParsed = parseSubmission(existing);
  if (existingParsed.updated_at_iso !== input.expectedUpdatedAtIso) {
    return { kind: 'revision_conflict' };
  }
  const now = formatEdgeTimestamp(input.now, existing.updated_at);
  const readAt = input.status === 'read'
    ? (existing.read_at ?? now)
    : existing.read_at ?? null;
  const archivedAt = input.status === 'archived'
    ? (existing.archived_at ?? now)
    : existing.archived_at ?? null;
  try {
    const result = await input.edgeDb.prepare(`
      UPDATE form_submissions
      SET status = ?, read_at = ?, archived_at = ?, updated_at = ?
      WHERE id = ? AND form_id = ? AND updated_at = ?
    `).bind(
      input.status,
      readAt,
      archivedAt,
      now,
      input.submissionId,
      input.formId,
      input.expectedUpdatedAtIso.replace('.000Z', 'Z'),
    ).run();
    if (readChanges(result) !== 1) {
      return await readSubmissionRow(input)
        ? { kind: 'revision_conflict' }
        : { kind: 'not_found' };
    }
    const updated = await readSubmissionRow(input);
    if (!updated) throw dataInvalid();
    return { kind: 'completed', value: parseSubmission(updated) };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_form_submission');
  }
}

export async function deleteFormSubmission(input: {
  edgeDb: D1Database;
  formId: string;
  submissionId: string;
  expectedUpdatedAtIso: string;
}): Promise<'completed' | 'not_found' | 'revision_conflict'> {
  try {
    const result = await input.edgeDb.prepare(`
      DELETE FROM form_submissions
      WHERE id = ? AND form_id = ? AND updated_at = ?
    `).bind(
      input.submissionId,
      input.formId,
      input.expectedUpdatedAtIso.replace('.000Z', 'Z'),
    ).run();
    if (readChanges(result) === 1) return 'completed';
    return await readSubmissionRow(input) ? 'revision_conflict' : 'not_found';
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'delete_form_submission');
  }
}
