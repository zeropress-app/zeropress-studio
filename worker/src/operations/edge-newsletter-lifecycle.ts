import { StudioOperationalError } from '../lib/operational-error';
import type { EdgeCommentLifecycleResult } from './edge-comment-lifecycle';

export const EDGE_NEWSLETTER_EFFECT_KEYS = {
  lists: 'EDGE_DB.newsletter_lists',
  fields: 'EDGE_DB.newsletter_fields',
  subscribers: 'EDGE_DB.newsletter_subscribers',
  subscriptions: 'EDGE_DB.newsletter_subscriptions',
  deliveries: 'EDGE_DB.newsletter_deliveries',
  fieldValues: 'EDGE_DB.newsletter_field_values',
  suppressions: 'EDGE_DB.newsletter_suppressions',
  mailSettings: 'EDGE_DB.edge_mail_settings',
} as const;

type NewsletterCountRow = {
  lists_count?: unknown;
  fields_count?: unknown;
  subscribers_count?: unknown;
  subscriptions_count?: unknown;
  deliveries_count?: unknown;
  field_values_count?: unknown;
  suppressions_count?: unknown;
};

type NewsletterVerificationRow = NewsletterCountRow & {
  default_lists_count?: unknown;
  mail_settings_count?: unknown;
  disabled_confirmation_count?: unknown;
};

function failure(input: {
  cause: unknown;
  action: 'clear_edge_newsletter_content' | 'reset_edge_newsletter_runtime';
  phase: 'mutation' | 'verification';
}) {
  return new StudioOperationalError(
    'MAINTENANCE_EDGE_NEWSLETTER_LIFECYCLE_FAILED',
    {
      cause: input.cause,
      metadata: {
        resource: 'EDGE_DB',
        action: input.action,
        phase: input.phase,
      },
    },
  );
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`EDGE_DB returned an invalid ${name}.`);
  }
  return Number(value);
}

function changes(result: D1Result<unknown> | undefined): number {
  return count(result?.meta?.changes ?? 0, 'changes count');
}

function formatEdgeTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Edge Newsletter reset time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM newsletter_lists) AS lists_count,
    (SELECT COUNT(*) FROM newsletter_fields) AS fields_count,
    (SELECT COUNT(*) FROM newsletter_subscribers) AS subscribers_count,
    (SELECT COUNT(*) FROM newsletter_subscriptions) AS subscriptions_count,
    (SELECT COUNT(*) FROM newsletter_deliveries) AS deliveries_count,
    (SELECT COUNT(*) FROM newsletter_field_values) AS field_values_count,
    (SELECT COUNT(*) FROM newsletter_suppressions) AS suppressions_count
`;

function deletedRows(
  initial: NewsletterCountRow,
  reset: boolean,
): Record<string, number> {
  return {
    [EDGE_NEWSLETTER_EFFECT_KEYS.deliveries]: count(
      initial.deliveries_count,
      'Newsletter delivery count',
    ),
    [EDGE_NEWSLETTER_EFFECT_KEYS.fieldValues]: count(
      initial.field_values_count,
      'Newsletter field-value count',
    ),
    [EDGE_NEWSLETTER_EFFECT_KEYS.subscriptions]: count(
      initial.subscriptions_count,
      'Newsletter subscription count',
    ),
    [EDGE_NEWSLETTER_EFFECT_KEYS.subscribers]: count(
      initial.subscribers_count,
      'Newsletter subscriber count',
    ),
    ...(reset ? {
      [EDGE_NEWSLETTER_EFFECT_KEYS.fields]: count(
        initial.fields_count,
        'Newsletter field count',
      ),
      [EDGE_NEWSLETTER_EFFECT_KEYS.lists]: count(
        initial.lists_count,
        'Newsletter list count',
      ),
      [EDGE_NEWSLETTER_EFFECT_KEYS.suppressions]: count(
        initial.suppressions_count,
        'Newsletter suppression count',
      ),
    } : {}),
  };
}

export async function clearEdgeNewsletterContent(input: {
  edgeDb: D1Database;
}): Promise<EdgeCommentLifecycleResult> {
  const action = 'clear_edge_newsletter_content' as const;
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(COUNT_SQL),
      input.edgeDb.prepare('DELETE FROM newsletter_deliveries'),
      input.edgeDb.prepare('DELETE FROM newsletter_field_values'),
      input.edgeDb.prepare('DELETE FROM newsletter_subscriptions'),
      input.edgeDb.prepare('DELETE FROM newsletter_subscribers'),
    ]);
  } catch (error) {
    throw failure({ cause: error, action, phase: 'mutation' });
  }
  const initial = results[0]?.results?.[0] as NewsletterCountRow | undefined;
  try {
    const verification = await input.edgeDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM newsletter_subscribers) AS subscribers_count,
        (SELECT COUNT(*) FROM newsletter_subscriptions) AS subscriptions_count,
        (SELECT COUNT(*) FROM newsletter_deliveries) AS deliveries_count,
        (SELECT COUNT(*) FROM newsletter_field_values) AS field_values_count
    `).first<NewsletterVerificationRow>();
    if (
      !initial
      || !verification
      || count(verification.subscribers_count, 'remaining subscriber count') !== 0
      || count(verification.subscriptions_count, 'remaining subscription count') !== 0
      || count(verification.deliveries_count, 'remaining delivery count') !== 0
      || count(verification.field_values_count, 'remaining field-value count') !== 0
    ) throw new TypeError('EDGE_DB Newsletter content verification failed.');
    return {
      deletedRows: deletedRows(initial, false),
      insertedRows: {},
      updatedRows: {},
    };
  } catch (error) {
    throw failure({ cause: error, action, phase: 'verification' });
  }
}

export async function resetEdgeNewsletterRuntime(input: {
  edgeDb: D1Database;
  now?: Date;
}): Promise<EdgeCommentLifecycleResult> {
  const action = 'reset_edge_newsletter_runtime' as const;
  const now = formatEdgeTimestamp(input.now ?? new Date());
  let results: D1Result<unknown>[];
  try {
    results = await input.edgeDb.batch([
      input.edgeDb.prepare(COUNT_SQL),
      input.edgeDb.prepare('DELETE FROM newsletter_deliveries'),
      input.edgeDb.prepare('DELETE FROM newsletter_field_values'),
      input.edgeDb.prepare('DELETE FROM newsletter_subscriptions'),
      input.edgeDb.prepare('DELETE FROM newsletter_subscribers'),
      input.edgeDb.prepare('DELETE FROM newsletter_fields'),
      input.edgeDb.prepare('DELETE FROM newsletter_lists'),
      input.edgeDb.prepare('DELETE FROM newsletter_suppressions'),
      input.edgeDb.prepare(`
        INSERT INTO newsletter_lists (
          slug, title, description, status, created_at, updated_at
        ) VALUES ('default', 'Newsletter', NULL, 'active', ?, ?)
      `).bind(now, now),
      input.edgeDb.prepare(`
        UPDATE edge_mail_settings
        SET newsletter_confirmation_enabled = 0, updated_at = ?
        WHERE id = 1 AND newsletter_confirmation_enabled != 0
      `).bind(now),
    ]);
  } catch (error) {
    throw failure({ cause: error, action, phase: 'mutation' });
  }
  const initial = results[0]?.results?.[0] as NewsletterCountRow | undefined;
  try {
    const verification = await input.edgeDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM newsletter_lists) AS lists_count,
        (SELECT COUNT(*) FROM newsletter_fields) AS fields_count,
        (SELECT COUNT(*) FROM newsletter_subscribers) AS subscribers_count,
        (SELECT COUNT(*) FROM newsletter_subscriptions) AS subscriptions_count,
        (SELECT COUNT(*) FROM newsletter_deliveries) AS deliveries_count,
        (SELECT COUNT(*) FROM newsletter_field_values) AS field_values_count,
        (SELECT COUNT(*) FROM newsletter_suppressions) AS suppressions_count,
        (
          SELECT COUNT(*) FROM newsletter_lists
          WHERE slug = 'default'
            AND title = 'Newsletter'
            AND description IS NULL
            AND status = 'active'
        ) AS default_lists_count,
        (SELECT COUNT(*) FROM edge_mail_settings WHERE id = 1)
          AS mail_settings_count,
        (
          SELECT COUNT(*) FROM edge_mail_settings
          WHERE id = 1 AND newsletter_confirmation_enabled = 0
        ) AS disabled_confirmation_count
    `).first<NewsletterVerificationRow>();
    if (
      !initial
      || !verification
      || count(verification.lists_count, 'remaining list count') !== 1
      || count(verification.default_lists_count, 'default list count') !== 1
      || count(verification.fields_count, 'remaining field count') !== 0
      || count(verification.subscribers_count, 'remaining subscriber count') !== 0
      || count(verification.subscriptions_count, 'remaining subscription count') !== 0
      || count(verification.deliveries_count, 'remaining delivery count') !== 0
      || count(verification.field_values_count, 'remaining field-value count') !== 0
      || count(verification.suppressions_count, 'remaining suppression count') !== 0
      || count(verification.mail_settings_count, 'mail-settings row count') !== 1
      || count(verification.disabled_confirmation_count, 'disabled confirmation count') !== 1
    ) throw new TypeError('EDGE_DB Newsletter reset verification failed.');
    const mailSettingsChanges = changes(results[9]);
    return {
      deletedRows: deletedRows(initial, true),
      insertedRows: {
        [EDGE_NEWSLETTER_EFFECT_KEYS.lists]: changes(results[8]),
      },
      updatedRows: mailSettingsChanges > 0
        ? { [EDGE_NEWSLETTER_EFFECT_KEYS.mailSettings]: mailSettingsChanges }
        : {},
    };
  } catch (error) {
    throw failure({ cause: error, action, phase: 'verification' });
  }
}
