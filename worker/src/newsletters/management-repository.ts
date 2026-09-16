import {
  NEWSLETTER_MAX_FIELDS,
  newsletterDeliverySchema,
  newsletterFieldSchema,
  newsletterRuntimeSchema,
  newsletterSubscriptionDetailSchema,
  newsletterSubscriptionSchema,
  newsletterSummarySchema,
  newsletterSuppressionSchema,
  type CreateNewsletterSuppressionRequest,
  type ExportNewsletterSubscriptionsQuery,
  type NewsletterField,
  type NewsletterFieldInput,
  type NewsletterDelivery,
  type NewsletterDeliveriesQuery,
  type NewsletterListQuery,
  type NewsletterRuntime,
  type NewsletterSubscription,
  type NewsletterSubscriptionDetail,
  type NewsletterSubscriptionsQuery,
  type NewsletterSummary,
  type NewsletterSuppression,
  type NewsletterSuppressionsQuery,
  type ReplaceNewsletterFieldsRequest,
  type UpdateNewsletterRequest,
} from '../../../contracts/newsletters';
import { StudioOperationalError } from '../lib/operational-error';

// Each field contributes 11 parameters and the optimistic aggregate guard
// contributes 2. Eight fields use 90 parameters, below D1's hard limit of 100.
const FIELD_UPSERT_CHUNK_SIZE = 8;
const DISABLE_RUNTIME_MAX_ATTEMPTS = 3;
export const NEWSLETTER_EXPORT_ROW_LIMIT = 400;
export const NEWSLETTER_EXPORT_BYTE_LIMIT = 2 * 1024 * 1024;
const NEWSLETTER_EXPORT_PAGE_SIZE = 25;
const NEWSLETTER_VALUE_LOOKUP_CHUNK_SIZE = 90;
const CSV_ENCODER = new TextEncoder();

type NewsletterRow = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  fields_count?: unknown;
  subscriptions_count?: unknown;
  pending_count?: unknown;
  subscribed_count?: unknown;
  unsubscribed_count?: unknown;
};

type FieldRow = {
  id?: unknown;
  newsletter_id?: unknown;
  field_key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  options_json?: unknown;
  sort_order?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type SubscriptionRow = {
  id?: unknown;
  newsletter_id?: unknown;
  subscriber_id?: unknown;
  email?: unknown;
  status?: unknown;
  confirm_email_status?: unknown;
  confirm_sent_at?: unknown;
  confirmed_at?: unknown;
  subscribed_at?: unknown;
  unsubscribed_at?: unknown;
  source_url?: unknown;
  country_code?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type DeliveryRow = {
  id?: unknown;
  newsletter_id?: unknown;
  subscription_id?: unknown;
  email?: unknown;
  delivery_type?: unknown;
  content_id?: unknown;
  subject?: unknown;
  provider?: unknown;
  status?: unknown;
  attempt_count?: unknown;
  failure_code?: unknown;
  queued_at?: unknown;
  last_attempt_at?: unknown;
  sent_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type FieldValueRow = {
  subscription_id?: unknown;
  field_id?: unknown;
  field_key?: unknown;
  label?: unknown;
  type?: unknown;
  field_value?: unknown;
};

export type NewsletterExportResult = {
  newsletter: NewsletterSummary;
  chunks: Uint8Array[];
  rowCount: number;
  byteCount: number;
  truncated: boolean;
  truncationReason: 'row_limit' | 'byte_limit' | null;
  rowLimit: number;
  byteLimit: number;
};

type SuppressionRow = {
  id?: unknown;
  email?: unknown;
  reason?: unknown;
  source?: unknown;
  note?: unknown;
  created_at?: unknown;
};

type RuntimeRow = {
  newsletter_confirmation_enabled?: unknown;
  updated_at?: unknown;
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

function queryFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function writeFailure(error: unknown, action: string): StudioOperationalError {
  return new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function dataInvalid(cause?: unknown): StudioOperationalError {
  return new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
    cause,
    metadata: { resource: 'EDGE_DB', action: 'validate_newsletter_data' },
  });
}

function createId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function parseCount(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw dataInvalid(new TypeError('D1 returned an invalid newsletter count.'));
  }
  return number;
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

function formatEdgeTimestamp(value: Date, previous?: unknown): string {
  const now = value.getTime();
  const previousTime = previous === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(normalizeTimestamp(previous));
  if (!Number.isFinite(now) || Number.isNaN(previousTime)) {
    throw new TypeError('Newsletter mutation time must be valid.');
  }
  const next = Math.max(Math.floor(now / 1_000) * 1_000, previousTime + 1_000);
  return new Date(next).toISOString().replace('.000Z', 'Z');
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : normalizeTimestamp(value);
}

function parseNewsletter(row: NewsletterRow): NewsletterSummary {
  const parsed = newsletterSummarySchema.safeParse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    fields_count: parseCount(row.fields_count),
    subscriptions_count: parseCount(row.subscriptions_count),
    pending_count: parseCount(row.pending_count),
    subscribed_count: parseCount(row.subscribed_count),
    unsubscribed_count: parseCount(row.unsubscribed_count),
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseOptions(value: unknown): Array<{ value: string; label: string }> {
  if (value === null) return [];
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
      ) {
        throw new TypeError('Field option is invalid.');
      }
      return { value: option.value, label: option.label };
    });
  } catch (error) {
    throw dataInvalid(error);
  }
}

function parseField(row: FieldRow): NewsletterField {
  const parsed = newsletterFieldSchema.safeParse({
    id: row.id,
    newsletter_id: row.newsletter_id,
    field_key: row.field_key,
    label: row.label,
    type: row.type,
    required: row.required === 1,
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

function parseSubscription(row: SubscriptionRow): NewsletterSubscription {
  const parsed = newsletterSubscriptionSchema.safeParse({
    id: row.id,
    newsletter_id: row.newsletter_id,
    email: row.email,
    status: row.status,
    confirmation_status: row.confirm_email_status ?? 'not_sent',
    confirm_sent_at_iso: nullableTimestamp(row.confirm_sent_at),
    confirmed_at_iso: nullableTimestamp(row.confirmed_at),
    subscribed_at_iso: nullableTimestamp(row.subscribed_at),
    unsubscribed_at_iso: nullableTimestamp(row.unsubscribed_at),
    source_url: sanitizeSourceUrl(row.source_url),
    country_code: row.country_code ?? null,
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseDelivery(row: DeliveryRow): NewsletterDelivery {
  const parsed = newsletterDeliverySchema.safeParse({
    id: row.id,
    newsletter_id: row.newsletter_id,
    subscription_id: row.subscription_id,
    email: row.email,
    delivery_type: row.delivery_type,
    content_id: row.content_id ?? null,
    subject: row.subject ?? null,
    provider: row.provider ?? null,
    status: row.status,
    attempt_count: parseCount(row.attempt_count),
    failure_code: row.failure_code ?? null,
    queued_at_iso: normalizeTimestamp(row.queued_at),
    last_attempt_at_iso: nullableTimestamp(row.last_attempt_at),
    sent_at_iso: nullableTimestamp(row.sent_at),
    created_at_iso: normalizeTimestamp(row.created_at),
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseSubscriptionDetail(
  row: SubscriptionRow,
  values: FieldValueRow[],
): NewsletterSubscriptionDetail {
  const parsed = newsletterSubscriptionDetailSchema.safeParse({
    ...parseSubscription(row),
    values: values.map((value) => ({
      field_id: value.field_id,
      field_key: value.field_key,
      label: value.label,
      type: value.type,
      value: value.field_value,
    })),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

function parseSuppression(row: SuppressionRow): NewsletterSuppression {
  const parsed = newsletterSuppressionSchema.safeParse({
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    note: row.note ?? null,
    created_at_iso: normalizeTimestamp(row.created_at),
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

function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index].codePointAt(0)!;
    if (point < 0x10FFFF) {
      return `${points.slice(0, index).join('')}${String.fromCodePoint(point + 1)}`;
    }
  }
  return null;
}

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function csvCell(value: string | null): string {
  let safe = value ?? '';
  // Spreadsheet programs can ignore leading whitespace before a formula
  // sigil. Preserve the source text while forcing the cell to plain text.
  if (/^[\s\u0000-\u001F\u007F\uFEFF]*[=+\-@]/u.test(safe)) {
    safe = `'${safe}`;
  }
  return `"${safe.replaceAll('"', '""')}"`;
}

function encodeCsvRecord(values: Array<string | null>, bom = false): Uint8Array {
  const prefix = bom ? '\uFEFF' : '';
  return CSV_ENCODER.encode(
    `${prefix}${values.map(csvCell).join(',')}\r\n`,
  );
}

const NEWSLETTER_SELECT = `
  SELECT
    nl.*,
    COALESCE((
      SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)
      FROM newsletter_fields nf WHERE nf.newsletter_id = nl.id
    ), 0) AS fields_count,
    COALESCE((SELECT COUNT(*) FROM newsletter_subscriptions ns WHERE ns.newsletter_id = nl.id), 0) AS subscriptions_count,
    COALESCE((SELECT COUNT(*) FROM newsletter_subscriptions ns WHERE ns.newsletter_id = nl.id AND ns.status = 'pending'), 0) AS pending_count,
    COALESCE((SELECT COUNT(*) FROM newsletter_subscriptions ns WHERE ns.newsletter_id = nl.id AND ns.status = 'subscribed'), 0) AS subscribed_count,
    COALESCE((SELECT COUNT(*) FROM newsletter_subscriptions ns WHERE ns.newsletter_id = nl.id AND ns.status = 'unsubscribed'), 0) AS unsubscribed_count
  FROM newsletter_lists nl
`;

const SUBSCRIPTION_SELECT = `
  SELECT
    ns.id,
    ns.newsletter_id,
    ns.subscriber_id,
    subscriber.email,
    ns.status,
    ns.confirm_email_status,
    ns.confirm_sent_at,
    ns.confirmed_at,
    ns.subscribed_at,
    ns.unsubscribed_at,
    ns.source_url,
    ns.country_code,
    ns.created_at,
    ns.updated_at
  FROM newsletter_subscriptions ns
  INNER JOIN newsletter_subscribers subscriber ON subscriber.id = ns.subscriber_id
`;

// Start email-prefix searches at the subscriber email UNIQUE index, then use
// UNIQUE(newsletter_id, subscriber_id) for the subscription lookup. A regular
// INNER JOIN lets SQLite choose a newsletter-wide subscription scan first.
const SUBSCRIPTION_SEARCH_SELECT = `
  SELECT
    ns.id,
    ns.newsletter_id,
    ns.subscriber_id,
    subscriber.email,
    ns.status,
    ns.confirm_email_status,
    ns.confirm_sent_at,
    ns.confirmed_at,
    ns.subscribed_at,
    ns.unsubscribed_at,
    ns.source_url,
    ns.country_code,
    ns.created_at,
    ns.updated_at
  FROM newsletter_subscribers subscriber
  CROSS JOIN newsletter_subscriptions ns ON ns.subscriber_id = subscriber.id
`;

async function readNewsletterRow(
  edgeDb: D1Database,
  id: string,
): Promise<NewsletterRow | null> {
  try {
    return await edgeDb.prepare(`
      ${NEWSLETTER_SELECT}
      WHERE nl.id = ?
      LIMIT 1
    `).bind(id).first<NewsletterRow>();
  } catch (error) {
    throw queryFailure(error, 'read_newsletter');
  }
}

async function readFieldRows(
  edgeDb: D1Database,
  newsletterId: string,
): Promise<FieldRow[]> {
  try {
    const result = await edgeDb.prepare(`
      SELECT id, newsletter_id, field_key, label, type, required, options_json,
             sort_order, status, created_at, updated_at
      FROM newsletter_fields
      WHERE newsletter_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `).bind(newsletterId).all<FieldRow>();
    return result.results ?? [];
  } catch (error) {
    throw queryFailure(error, 'read_newsletter_fields');
  }
}

export async function listNewsletters(input: {
  edgeDb: D1Database;
  query: NewsletterListQuery;
}): Promise<{ items: NewsletterSummary[]; pagination: Pagination }> {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (input.query.status !== 'all') {
    conditions.push('nl.status = ?');
    parameters.push(input.query.status);
  }
  if (input.query.search) {
    conditions.push(`(
      instr(lower(nl.title), lower(?)) > 0
      OR instr(lower(nl.slug), lower(?)) > 0
    )`);
    parameters.push(input.query.search, input.query.search);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, count] = await Promise.all([
      input.edgeDb.prepare(`
        ${NEWSLETTER_SELECT}
        ${where}
        ORDER BY nl.updated_at DESC, nl.title ASC, nl.id ASC
        LIMIT ? OFFSET ?
      `).bind(...parameters, input.query.per_page, offset).all<NewsletterRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total FROM newsletter_lists nl ${where}
      `).bind(...parameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total);
    return {
      items: (rows.results ?? []).map(parseNewsletter),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_newsletters');
  }
}

export async function getNewsletter(input: {
  edgeDb: D1Database;
  id: string;
}): Promise<NewsletterSummary | null> {
  const row = await readNewsletterRow(input.edgeDb, input.id);
  return row ? parseNewsletter(row) : null;
}

export async function updateNewsletter(input: {
  edgeDb: D1Database;
  id: string;
  update: UpdateNewsletterRequest;
  now?: Date;
}): Promise<ExpectedMutationResult<NewsletterSummary>> {
  const row = await readNewsletterRow(input.edgeDb, input.id);
  if (!row) return { kind: 'not_found' };
  if (normalizeTimestamp(row.updated_at) !== input.update.expected_updated_at_iso) {
    return { kind: 'revision_conflict' };
  }
  const nextTimestamp = formatEdgeTimestamp(input.now ?? new Date(), row.updated_at);
  let result: D1Result<unknown>;
  try {
    result = await input.edgeDb.prepare(`
      UPDATE newsletter_lists
      SET title = ?, description = ?, status = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).bind(
      input.update.title ?? row.title,
      input.update.description === undefined
        ? row.description ?? null
        : input.update.description || null,
      input.update.status ?? row.status,
      nextTimestamp,
      input.id,
      row.updated_at,
    ).run();
  } catch (error) {
    throw writeFailure(error, 'update_newsletter');
  }
  if (readChanges(result) !== 1) return { kind: 'revision_conflict' };
  const updated = await getNewsletter({ edgeDb: input.edgeDb, id: input.id });
  if (!updated) throw dataInvalid();
  return { kind: 'completed', value: updated };
}

export async function listNewsletterFields(input: {
  edgeDb: D1Database;
  newsletterId: string;
}): Promise<{ items: NewsletterField[]; newsletterUpdatedAtIso: string } | null> {
  const newsletter = await readNewsletterRow(input.edgeDb, input.newsletterId);
  if (!newsletter) return null;
  const fields = await readFieldRows(input.edgeDb, input.newsletterId);
  return {
    items: fields.map(parseField),
    newsletterUpdatedAtIso: normalizeTimestamp(newsletter.updated_at),
  };
}

export async function replaceNewsletterFields(input: {
  edgeDb: D1Database;
  newsletterId: string;
  request: ReplaceNewsletterFieldsRequest;
  now?: Date;
}): Promise<ExpectedMutationResult<{
  items: NewsletterField[];
  newsletterUpdatedAtIso: string;
}>> {
  const newsletter = await readNewsletterRow(input.edgeDb, input.newsletterId);
  if (!newsletter) return { kind: 'not_found' };
  if (normalizeTimestamp(newsletter.updated_at) !== input.request.expected_updated_at_iso) {
    return { kind: 'revision_conflict' };
  }
  const existingRows = await readFieldRows(input.edgeDb, input.newsletterId);
  const existing = existingRows.map(parseField);
  const existingById = new Map(existing.map((field) => [field.id, field]));
  const existingByKey = new Map(existing.map((field) => [field.field_key, field]));
  const suppliedIds = input.request.fields.flatMap((field) => field.id ? [field.id] : []);
  if (suppliedIds.length > 0) {
    let claimed: Array<{ id?: unknown; newsletter_id?: unknown }>;
    try {
      const result = await input.edgeDb.prepare(`
        SELECT id, newsletter_id FROM newsletter_fields
        WHERE id IN (${suppliedIds.map(() => '?').join(', ')})
      `).bind(...suppliedIds).all<{ id?: unknown; newsletter_id?: unknown }>();
      claimed = result.results ?? [];
    } catch (error) {
      throw queryFailure(error, 'validate_newsletter_field_ids');
    }
    const ownerById = new Map(claimed.map((field) => [field.id, field.newsletter_id]));
    if (suppliedIds.some((id) => ownerById.get(id) !== input.newsletterId)) {
      return { kind: 'invalid' };
    }
  }
  const explicitIds = new Set(suppliedIds);
  const reusableByKey = new Map(existing
    .filter((field) => !explicitIds.has(field.id))
    .map((field) => [field.field_key, field.id]));
  const resolved: Array<NewsletterFieldInput & { id: string }> = input.request.fields
    .map((field) => {
      if (field.id) return { ...field, id: field.id };
      const reusable = reusableByKey.get(field.field_key);
      if (reusable) {
        reusableByKey.delete(field.field_key);
        return { ...field, id: reusable };
      }
      return { ...field, id: createId() };
    });
  const newCount = resolved.filter((field) => !existingById.has(field.id)).length;
  if (existing.length + newCount > NEWSLETTER_MAX_FIELDS) {
    return { kind: 'invalid' };
  }
  const retainedIds = new Set(resolved.map((field) => field.id));
  for (const field of resolved) {
    const owner = existingByKey.get(field.field_key);
    if (owner && owner.id !== field.id && !retainedIds.has(owner.id)) {
      return { kind: 'invalid' };
    }
  }
  const semanticChanges = resolved.filter((field) => {
    const previous = existingById.get(field.id);
    return previous
      && (previous.field_key !== field.field_key || previous.type !== field.type);
  });
  if (semanticChanges.length > 0) {
    let used: D1Result<{ field_id?: unknown }>;
    try {
      used = await input.edgeDb.prepare(`
        SELECT DISTINCT field_id FROM newsletter_field_values
        WHERE field_id IN (${semanticChanges.map(() => '?').join(', ')})
      `).bind(...semanticChanges.map((field) => field.id)).all<{ field_id?: unknown }>();
    } catch (error) {
      throw queryFailure(error, 'validate_newsletter_field_history');
    }
    if ((used.results ?? []).length > 0) return { kind: 'invalid' };
  }
  const nextTimestamp = formatEdgeTimestamp(input.now ?? new Date(), newsletter.updated_at);
  const statements: D1PreparedStatement[] = [];
  if (retainedIds.size === 0) {
    statements.push(input.edgeDb.prepare(`
      UPDATE newsletter_fields
      SET status = 'disabled', updated_at = ?
      WHERE newsletter_id = ?
        AND EXISTS (
          SELECT 1 FROM newsletter_lists
          WHERE id = ? AND updated_at = ?
        )
    `).bind(
      nextTimestamp,
      input.newsletterId,
      input.newsletterId,
      newsletter.updated_at,
    ));
  } else {
    statements.push(input.edgeDb.prepare(`
      UPDATE newsletter_fields
      SET status = 'disabled', updated_at = ?
      WHERE newsletter_id = ?
        AND id NOT IN (${[...retainedIds].map(() => '?').join(', ')})
        AND EXISTS (
          SELECT 1 FROM newsletter_lists
          WHERE id = ? AND updated_at = ?
        )
    `).bind(
      nextTimestamp,
      input.newsletterId,
      ...retainedIds,
      input.newsletterId,
      newsletter.updated_at,
    ));
  }
  const changedKeys = resolved.filter((field) => (
    existingById.has(field.id)
    && existingById.get(field.id)?.field_key !== field.field_key
  ));
  if (changedKeys.length > 0) {
    statements.push(input.edgeDb.prepare(`
      UPDATE newsletter_fields
      SET field_key = '__replace_' || id
      WHERE newsletter_id = ?
        AND id IN (${changedKeys.map(() => '?').join(', ')})
        AND EXISTS (
          SELECT 1 FROM newsletter_lists
          WHERE id = ? AND updated_at = ?
        )
    `).bind(
      input.newsletterId,
      ...changedKeys.map((field) => field.id),
      input.newsletterId,
      newsletter.updated_at,
    ));
  }
  for (let offset = 0; offset < resolved.length; offset += FIELD_UPSERT_CHUNK_SIZE) {
    const chunk = resolved.slice(offset, offset + FIELD_UPSERT_CHUNK_SIZE);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const bindings = chunk.flatMap((field) => [
      field.id,
      input.newsletterId,
      field.field_key,
      field.label,
      field.type,
      field.required ? 1 : 0,
      field.options.length > 0 ? JSON.stringify(field.options) : null,
      field.sort_order,
      field.status,
      nextTimestamp,
      nextTimestamp,
    ]);
    statements.push(input.edgeDb.prepare(`
      WITH incoming (
        id, newsletter_id, field_key, label, type, required, options_json,
        sort_order, status, created_at, updated_at
      ) AS (VALUES ${values})
      INSERT INTO newsletter_fields (
        id, newsletter_id, field_key, label, type, required, options_json,
        sort_order, status, created_at, updated_at
      )
      SELECT
        id, newsletter_id, field_key, label, type, required, options_json,
        sort_order, status, created_at, updated_at
      FROM incoming
      WHERE EXISTS (
        SELECT 1 FROM newsletter_lists
        WHERE id = ? AND updated_at = ?
      )
      ON CONFLICT(id) DO UPDATE SET
        field_key = excluded.field_key,
        label = excluded.label,
        type = excluded.type,
        required = excluded.required,
        options_json = excluded.options_json,
        sort_order = excluded.sort_order,
        status = excluded.status,
        updated_at = excluded.updated_at
      WHERE newsletter_fields.newsletter_id = excluded.newsletter_id
    `).bind(
      ...bindings,
      input.newsletterId,
      newsletter.updated_at,
    ));
  }
  statements.push(input.edgeDb.prepare(`
    UPDATE newsletter_lists
    SET updated_at = ?
    WHERE id = ? AND updated_at = ?
  `).bind(nextTimestamp, input.newsletterId, newsletter.updated_at));
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch(statements);
  } catch (error) {
    throw writeFailure(error, 'replace_newsletter_fields');
  }
  if (readChanges(results.at(-1)) !== 1) return { kind: 'revision_conflict' };
  const items = (await readFieldRows(input.edgeDb, input.newsletterId)).map(parseField);
  return {
    kind: 'completed',
    value: {
      items,
      newsletterUpdatedAtIso: normalizeTimestamp(nextTimestamp),
    },
  };
}

function subscriptionWhere(
  newsletterId: string,
  query: NewsletterSubscriptionsQuery,
): { sql: string; parameters: Array<string | number> } {
  const conditions = ['ns.newsletter_id = ?'];
  const parameters: Array<string | number> = [newsletterId];
  if (query.status !== 'all') {
    conditions.push('ns.status = ?');
    parameters.push(query.status);
  }
  if (query.search) {
    const upper = prefixUpperBound(query.search);
    if (upper) {
      conditions.push('subscriber.email >= ? AND subscriber.email < ?');
      parameters.push(query.search, upper);
    } else {
      conditions.push('subscriber.email = ?');
      parameters.push(query.search);
    }
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, parameters };
}

function exportWhere(
  newsletterId: string,
  query: ExportNewsletterSubscriptionsQuery,
  cursorCreatedAt: string | null,
  cursorId: string | null,
): { sql: string; parameters: Array<string | number> } {
  const conditions = ['ns.newsletter_id = ?'];
  const parameters: Array<string | number> = [newsletterId];
  if (query.status !== 'all') {
    conditions.push('ns.status = ?');
    parameters.push(query.status);
  }
  if (query.from) {
    conditions.push('ns.created_at >= ?');
    parameters.push(`${query.from}T00:00:00`);
  }
  if (query.to) {
    conditions.push('ns.created_at < ?');
    parameters.push(`${nextUtcDate(query.to)}T00:00:00`);
  }
  if (cursorCreatedAt && cursorId) {
    conditions.push('(ns.created_at, ns.id) > (?, ?)');
    parameters.push(cursorCreatedAt, cursorId);
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, parameters };
}

async function valuesForExport(input: {
  edgeDb: D1Database;
  subscriptionIds: string[];
}): Promise<Map<string, Map<string, string>>> {
  const output = new Map<string, Map<string, string>>();
  try {
    for (
      let offset = 0;
      offset < input.subscriptionIds.length;
      offset += NEWSLETTER_VALUE_LOOKUP_CHUNK_SIZE
    ) {
      const ids = input.subscriptionIds.slice(
        offset,
        offset + NEWSLETTER_VALUE_LOOKUP_CHUNK_SIZE,
      );
      if (ids.length === 0) continue;
      const result = await input.edgeDb.prepare(`
        SELECT subscription_id, field_id, field_value
        FROM newsletter_field_values
        WHERE subscription_id IN (${ids.map(() => '?').join(', ')})
      `).bind(...ids).all<FieldValueRow>();
      for (const row of result.results ?? []) {
        if (
          typeof row.subscription_id !== 'string'
          || typeof row.field_id !== 'string'
          || typeof row.field_value !== 'string'
        ) throw dataInvalid();
        let values = output.get(row.subscription_id);
        if (!values) {
          values = new Map<string, string>();
          output.set(row.subscription_id, values);
        }
        values.set(row.field_id, row.field_value);
      }
    }
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_newsletter_export_values');
  }
  return output;
}

export async function exportNewsletterSubscriptions(input: {
  edgeDb: D1Database;
  newsletterId: string;
  query: ExportNewsletterSubscriptionsQuery;
}): Promise<NewsletterExportResult | null> {
  const newsletter = await getNewsletter({
    edgeDb: input.edgeDb,
    id: input.newsletterId,
  });
  if (!newsletter) return null;
  const fields = (await readFieldRows(input.edgeDb, input.newsletterId))
    .map(parseField);
  const fieldIds = fields.map((field) => field.id);
  const chunks = [encodeCsvRecord([
    'email',
    'status',
    'confirmation_status',
    'confirm_sent_at',
    'confirmed_at',
    'subscribed_at',
    'unsubscribed_at',
    'source_url',
    'country_code',
    'created_at',
    'updated_at',
    ...fields.map((field) => `field:${field.field_key}`),
  ], true)];
  let rowCount = 0;
  let byteCount = chunks[0].byteLength;
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  let hasMore = true;
  let truncationReason: NewsletterExportResult['truncationReason'] = null;

  try {
    while (hasMore && !truncationReason) {
      // Fetch one look-ahead row at the limit so truncation is reported only
      // when another matching row actually exists.
      const remaining = NEWSLETTER_EXPORT_ROW_LIMIT + 1 - rowCount;
      const pageSize = Math.min(NEWSLETTER_EXPORT_PAGE_SIZE, remaining);
      const where = exportWhere(
        input.newsletterId,
        input.query,
        cursorCreatedAt,
        cursorId,
      );
      const page = await input.edgeDb.prepare(`
        ${SUBSCRIPTION_SELECT}
        ${where.sql}
        ORDER BY ns.created_at ASC, ns.id ASC
        LIMIT ?
      `).bind(...where.parameters, pageSize).all<SubscriptionRow>();
      const rows = page.results ?? [];
      const values = fieldIds.length > 0
        ? await valuesForExport({
            edgeDb: input.edgeDb,
            subscriptionIds: rows.flatMap((row) => (
              typeof row.id === 'string' ? [row.id] : []
            )),
          })
        : new Map<string, Map<string, string>>();

      for (const row of rows) {
        if (rowCount >= NEWSLETTER_EXPORT_ROW_LIMIT) {
          truncationReason = 'row_limit';
          break;
        }
        if (typeof row.id !== 'string') throw dataInvalid();
        const subscription = parseSubscription(row);
        const rowValues = values.get(row.id) ?? new Map<string, string>();
        const chunk = encodeCsvRecord([
          subscription.email,
          subscription.status,
          subscription.confirmation_status,
          subscription.confirm_sent_at_iso,
          subscription.confirmed_at_iso,
          subscription.subscribed_at_iso,
          subscription.unsubscribed_at_iso,
          subscription.source_url,
          subscription.country_code,
          subscription.created_at_iso,
          subscription.updated_at_iso,
          ...fieldIds.map((fieldId) => rowValues.get(fieldId) ?? ''),
        ]);
        if (byteCount + chunk.byteLength > NEWSLETTER_EXPORT_BYTE_LIMIT) {
          truncationReason = 'byte_limit';
          break;
        }
        chunks.push(chunk);
        rowCount += 1;
        byteCount += chunk.byteLength;
      }

      hasMore = rows.length === pageSize;
      const last = rows.at(-1);
      if (!last) break;
      if (typeof last.created_at !== 'string' || typeof last.id !== 'string') {
        throw dataInvalid();
      }
      cursorCreatedAt = last.created_at;
      cursorId = last.id;
    }
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'export_newsletter_subscriptions');
  }

  return {
    newsletter,
    chunks,
    rowCount,
    byteCount,
    truncated: truncationReason !== null,
    truncationReason,
    rowLimit: NEWSLETTER_EXPORT_ROW_LIMIT,
    byteLimit: NEWSLETTER_EXPORT_BYTE_LIMIT,
  };
}

export async function listNewsletterSubscriptions(input: {
  edgeDb: D1Database;
  newsletterId: string;
  query: NewsletterSubscriptionsQuery;
}): Promise<{ items: NewsletterSubscription[]; pagination: Pagination } | null> {
  if (!(await readNewsletterRow(input.edgeDb, input.newsletterId))) return null;
  const where = subscriptionWhere(input.newsletterId, input.query);
  const offset = (input.query.page - 1) * input.query.per_page;
  const select = input.query.search
    ? SUBSCRIPTION_SEARCH_SELECT
    : SUBSCRIPTION_SELECT;
  const countFrom = input.query.search
    ? `FROM newsletter_subscribers subscriber
       CROSS JOIN newsletter_subscriptions ns
         ON ns.subscriber_id = subscriber.id`
    : `FROM newsletter_subscriptions ns
       INNER JOIN newsletter_subscribers subscriber
         ON subscriber.id = ns.subscriber_id`;
  try {
    const [rows, count] = await Promise.all([
      input.edgeDb.prepare(`
        ${select}
        ${where.sql}
        ORDER BY ns.created_at DESC, ns.id DESC
        LIMIT ? OFFSET ?
      `).bind(...where.parameters, input.query.per_page, offset).all<SubscriptionRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total
        ${countFrom}
        ${where.sql}
      `).bind(...where.parameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total);
    return {
      items: (rows.results ?? []).map(parseSubscription),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_newsletter_subscriptions');
  }
}

export async function listNewsletterDeliveries(input: {
  edgeDb: D1Database;
  newsletterId: string;
  query: NewsletterDeliveriesQuery;
}): Promise<{ items: NewsletterDelivery[]; pagination: Pagination } | null> {
  if (!(await readNewsletterRow(input.edgeDb, input.newsletterId))) return null;
  const conditions = ['delivery.newsletter_id = ?'];
  const parameters: Array<string | number> = [input.newsletterId];
  if (input.query.status !== 'all') {
    conditions.push('delivery.status = ?');
    parameters.push(input.query.status);
  }
  if (input.query.type !== 'all') {
    conditions.push('delivery.delivery_type = ?');
    parameters.push(input.query.type);
  }
  if (input.query.content_id) {
    conditions.push('delivery.content_id = ?');
    parameters.push(input.query.content_id);
  }
  if (input.query.search) {
    const upper = prefixUpperBound(input.query.search);
    conditions.push(upper
      ? 'subscriber.email >= ? AND subscriber.email < ?'
      : 'subscriber.email >= ?');
    parameters.push(input.query.search);
    if (upper) parameters.push(upper);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const from = `FROM newsletter_deliveries delivery
    INNER JOIN newsletter_subscriptions subscription
      ON subscription.id = delivery.subscription_id
    INNER JOIN newsletter_subscribers subscriber
      ON subscriber.id = subscription.subscriber_id`;
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, count] = await Promise.all([
      input.edgeDb.prepare(`
        SELECT delivery.id,
               delivery.newsletter_id,
               delivery.subscription_id,
               subscriber.email,
               delivery.delivery_type,
               delivery.content_id,
               delivery.subject,
               delivery.provider,
               delivery.status,
               delivery.attempt_count,
               delivery.failure_code,
               delivery.queued_at,
               delivery.last_attempt_at,
               delivery.sent_at,
               delivery.created_at,
               delivery.updated_at
        ${from}
        ${where}
        ORDER BY delivery.created_at DESC, delivery.id DESC
        LIMIT ? OFFSET ?
      `).bind(...parameters, input.query.per_page, offset).all<DeliveryRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total
        ${from}
        ${where}
      `).bind(...parameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total);
    return {
      items: (rows.results ?? []).map(parseDelivery),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_newsletter_deliveries');
  }
}

async function readSubscriptionRow(input: {
  edgeDb: D1Database;
  newsletterId: string;
  subscriptionId: string;
}): Promise<SubscriptionRow | null> {
  try {
    return await input.edgeDb.prepare(`
      ${SUBSCRIPTION_SELECT}
      WHERE ns.id = ? AND ns.newsletter_id = ?
      LIMIT 1
    `).bind(input.subscriptionId, input.newsletterId).first<SubscriptionRow>();
  } catch (error) {
    throw queryFailure(error, 'read_newsletter_subscription');
  }
}

export async function getNewsletterSubscription(input: {
  edgeDb: D1Database;
  newsletterId: string;
  subscriptionId: string;
}): Promise<NewsletterSubscriptionDetail | null> {
  const row = await readSubscriptionRow(input);
  if (!row) return null;
  try {
    const values = await input.edgeDb.prepare(`
      SELECT nfv.field_id, nf.field_key, nf.label, nf.type, nfv.field_value
      FROM newsletter_field_values nfv
      INNER JOIN newsletter_fields nf ON nf.id = nfv.field_id
      WHERE nfv.subscription_id = ?
      ORDER BY nf.sort_order ASC, nf.created_at ASC, nf.id ASC
    `).bind(input.subscriptionId).all<FieldValueRow>();
    return parseSubscriptionDetail(row, values.results ?? []);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'read_newsletter_subscription_values');
  }
}

export async function unsubscribeNewsletterSubscription(input: {
  edgeDb: D1Database;
  newsletterId: string;
  subscriptionId: string;
  now?: Date;
}): Promise<NewsletterSubscription | null> {
  const existing = await readSubscriptionRow(input);
  if (!existing) return null;
  if (existing.status !== 'unsubscribed') {
    const now = formatEdgeTimestamp(input.now ?? new Date(), existing.updated_at);
    try {
      await input.edgeDb.prepare(`
        UPDATE newsletter_subscriptions
        SET status = 'unsubscribed',
            confirm_token_hash = NULL,
            confirm_expires_at = NULL,
            confirm_email_error = NULL,
            unsubscribed_at = COALESCE(unsubscribed_at, ?),
            updated_at = ?
        WHERE id = ? AND newsletter_id = ?
          AND status IN ('pending', 'subscribed')
      `).bind(now, now, input.subscriptionId, input.newsletterId).run();
    } catch (error) {
      throw writeFailure(error, 'unsubscribe_newsletter_subscription');
    }
  }
  const updated = await readSubscriptionRow(input);
  return updated ? parseSubscription(updated) : null;
}

export async function deleteNewsletterSubscription(input: {
  edgeDb: D1Database;
  newsletterId: string;
  subscriptionId: string;
}): Promise<{ subscriberDeleted: boolean } | null> {
  const existing = await readSubscriptionRow(input);
  if (!existing || typeof existing.subscriber_id !== 'string') return null;
  try {
    await input.edgeDb.batch([
      input.edgeDb.prepare(
        'DELETE FROM newsletter_field_values WHERE subscription_id = ?',
      ).bind(input.subscriptionId),
      input.edgeDb.prepare(`
        DELETE FROM newsletter_subscriptions
        WHERE id = ? AND newsletter_id = ?
      `).bind(input.subscriptionId, input.newsletterId),
      input.edgeDb.prepare(`
        DELETE FROM newsletter_subscribers
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM newsletter_subscriptions WHERE subscriber_id = ?
          )
      `).bind(existing.subscriber_id, existing.subscriber_id),
    ]);
    const subscriber = await input.edgeDb.prepare(`
      SELECT id FROM newsletter_subscribers WHERE id = ? LIMIT 1
    `).bind(existing.subscriber_id).first<{ id?: unknown }>();
    return { subscriberDeleted: !subscriber };
  } catch (error) {
    throw writeFailure(error, 'delete_newsletter_subscription');
  }
}

function suppressionWhere(
  query: NewsletterSuppressionsQuery,
): { sql: string; parameters: Array<string | number> } {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (query.reason !== 'all') {
    conditions.push('reason = ?');
    parameters.push(query.reason);
  }
  if (query.search) {
    const upper = prefixUpperBound(query.search);
    if (upper) {
      conditions.push('email >= ? AND email < ?');
      parameters.push(query.search, upper);
    } else {
      conditions.push('email = ?');
      parameters.push(query.search);
    }
  }
  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    parameters,
  };
}

export async function listNewsletterSuppressions(input: {
  edgeDb: D1Database;
  query: NewsletterSuppressionsQuery;
}): Promise<{ items: NewsletterSuppression[]; pagination: Pagination }> {
  const where = suppressionWhere(input.query);
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const [rows, count] = await Promise.all([
      input.edgeDb.prepare(`
        SELECT id, email, reason, source, note, created_at
        FROM newsletter_suppressions
        ${where.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(...where.parameters, input.query.per_page, offset).all<SuppressionRow>(),
      input.edgeDb.prepare(`
        SELECT COUNT(*) AS total FROM newsletter_suppressions ${where.sql}
      `).bind(...where.parameters).first<{ total?: unknown }>(),
    ]);
    const total = parseCount(count?.total);
    return {
      items: (rows.results ?? []).map(parseSuppression),
      pagination: pagination(total, input.query.page, input.query.per_page),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_newsletter_suppressions');
  }
}

async function readSuppression(input: {
  edgeDb: D1Database;
  id?: string;
  email?: string;
}): Promise<SuppressionRow | null> {
  try {
    return await input.edgeDb.prepare(`
      SELECT id, email, reason, source, note, created_at
      FROM newsletter_suppressions
      WHERE ${input.id ? 'id' : 'email'} = ?
      LIMIT 1
    `).bind(input.id ?? input.email).first<SuppressionRow>();
  } catch (error) {
    throw queryFailure(error, 'read_newsletter_suppression');
  }
}

export async function createNewsletterSuppression(input: {
  edgeDb: D1Database;
  request: CreateNewsletterSuppressionRequest;
  now?: Date;
}): Promise<{
  suppression: NewsletterSuppression;
  created: boolean;
  unsubscribedCount: number;
}> {
  const existing = await readSuppression({ edgeDb: input.edgeDb, email: input.request.email });
  const id = typeof existing?.id === 'string' ? existing.id : createId();
  const now = formatEdgeTimestamp(input.now ?? new Date());
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(`
        INSERT INTO newsletter_suppressions (id, email, reason, source, note, created_at)
        VALUES (?, ?, 'manual', 'studio', ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          note = CASE
            WHEN newsletter_suppressions.reason = 'manual'
             AND newsletter_suppressions.source = 'studio'
            THEN excluded.note
            ELSE newsletter_suppressions.note
          END
      `).bind(id, input.request.email, input.request.note || null, now),
      input.edgeDb.prepare(`
        UPDATE newsletter_subscriptions
        SET status = 'unsubscribed',
            confirm_token_hash = NULL,
            confirm_expires_at = NULL,
            confirm_email_error = NULL,
            unsubscribed_at = COALESCE(unsubscribed_at, ?),
            updated_at = ?
        WHERE subscriber_id IN (
          SELECT id FROM newsletter_subscribers WHERE email = ?
        ) AND status IN ('pending', 'subscribed')
      `).bind(now, now, input.request.email),
      input.edgeDb.prepare(`
        UPDATE newsletter_subscriptions
        SET confirm_token_hash = NULL,
            confirm_expires_at = NULL,
            confirm_email_error = NULL,
            updated_at = ?
        WHERE subscriber_id IN (
          SELECT id FROM newsletter_subscribers WHERE email = ?
        ) AND status = 'unsubscribed'
          AND (
            confirm_token_hash IS NOT NULL
            OR confirm_expires_at IS NOT NULL
            OR confirm_email_error IS NOT NULL
          )
      `).bind(now, input.request.email),
    ]);
  } catch (error) {
    throw writeFailure(error, 'create_newsletter_suppression');
  }
  const saved = await readSuppression({ edgeDb: input.edgeDb, email: input.request.email });
  if (!saved) throw dataInvalid();
  return {
    suppression: parseSuppression(saved),
    created: !existing && saved.id === id,
    unsubscribedCount: readChanges(results[1]),
  };
}

export async function deleteNewsletterSuppression(input: {
  edgeDb: D1Database;
  id: string;
}): Promise<boolean> {
  const existing = await readSuppression({ edgeDb: input.edgeDb, id: input.id });
  if (!existing) return false;
  try {
    await input.edgeDb.prepare(
      'DELETE FROM newsletter_suppressions WHERE id = ?',
    ).bind(input.id).run();
    return true;
  } catch (error) {
    throw writeFailure(error, 'delete_newsletter_suppression');
  }
}

export async function readNewsletterRuntime(input: {
  edgeDb: D1Database;
  mailConfigured: boolean;
}): Promise<NewsletterRuntime> {
  const row = await readNewsletterRuntimeRow(input.edgeDb);
  const confirmationEnabled = row.newsletter_confirmation_enabled === 1;
  const parsed = newsletterRuntimeSchema.safeParse({
    confirmation_enabled: confirmationEnabled,
    mail_configured: input.mailConfigured,
    ready: confirmationEnabled && input.mailConfigured,
    updated_at_iso: normalizeTimestamp(row.updated_at),
  });
  if (!parsed.success) throw dataInvalid(parsed.error);
  return parsed.data;
}

async function readNewsletterRuntimeRow(
  edgeDb: D1Database,
): Promise<Required<RuntimeRow>> {
  let row: RuntimeRow | null;
  try {
    row = await edgeDb.prepare(`
      SELECT newsletter_confirmation_enabled, updated_at
      FROM edge_mail_settings
      WHERE id = 1
      LIMIT 1
    `).first<RuntimeRow>();
  } catch (error) {
    throw queryFailure(error, 'read_newsletter_runtime');
  }
  if (!row || (row.newsletter_confirmation_enabled !== 0 && row.newsletter_confirmation_enabled !== 1)) {
    throw dataInvalid();
  }
  if (typeof row.updated_at !== 'string') throw dataInvalid();
  return {
    newsletter_confirmation_enabled: row.newsletter_confirmation_enabled,
    updated_at: row.updated_at,
  };
}

export async function updateNewsletterRuntime(input: {
  edgeDb: D1Database;
  confirmationEnabled: boolean;
  expectedUpdatedAtIso: string;
  mailConfigured: boolean;
  now?: Date;
}): Promise<
  | { kind: 'completed'; value: NewsletterRuntime }
  | { kind: 'revision_conflict' }
  | { kind: 'mail_not_configured' }
> {
  if (input.confirmationEnabled && !input.mailConfigured) {
    return { kind: 'mail_not_configured' };
  }
  const currentRow = await readNewsletterRuntimeRow(input.edgeDb);
  const currentUpdatedAtIso = normalizeTimestamp(currentRow.updated_at);
  if (currentUpdatedAtIso !== input.expectedUpdatedAtIso) {
    return { kind: 'revision_conflict' };
  }
  const next = formatEdgeTimestamp(input.now ?? new Date(), currentRow.updated_at);
  let result: D1Result<unknown>;
  try {
    result = await input.edgeDb.prepare(`
      UPDATE edge_mail_settings
      SET newsletter_confirmation_enabled = ?, updated_at = ?
      WHERE id = 1 AND updated_at = ?
    `).bind(
      input.confirmationEnabled ? 1 : 0,
      next,
      currentRow.updated_at,
    ).run();
  } catch (error) {
    throw writeFailure(error, 'update_newsletter_runtime');
  }
  if (readChanges(result) !== 1) return { kind: 'revision_conflict' };
  return {
    kind: 'completed',
    value: newsletterRuntimeSchema.parse({
      confirmation_enabled: input.confirmationEnabled,
      mail_configured: input.mailConfigured,
      ready: input.confirmationEnabled && input.mailConfigured,
      updated_at_iso: normalizeTimestamp(next),
    }),
  };
}

export async function disableNewsletterRuntime(input: {
  edgeDb: D1Database;
  now?: Date;
}): Promise<void> {
  for (let attempt = 0; attempt < DISABLE_RUNTIME_MAX_ATTEMPTS; attempt += 1) {
    const current = await readNewsletterRuntimeRow(input.edgeDb);
    if (current.newsletter_confirmation_enabled === 0) return;
    const next = formatEdgeTimestamp(input.now ?? new Date(), current.updated_at);
    try {
      const result = await input.edgeDb.prepare(`
        UPDATE edge_mail_settings
        SET newsletter_confirmation_enabled = 0,
            updated_at = ?
        WHERE id = 1
          AND newsletter_confirmation_enabled != 0
          AND updated_at = ?
      `).bind(next, current.updated_at).run();
      if (readChanges(result) === 1) return;
    } catch (error) {
      throw writeFailure(error, 'disable_newsletter_runtime');
    }
  }
  throw writeFailure(
    new Error('Newsletter runtime changed during fail-closed disable.'),
    'disable_newsletter_runtime',
  );
}
