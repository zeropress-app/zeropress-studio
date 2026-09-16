import { StudioOperationalError } from '../lib/operational-error';

export const CANONICAL_NEWSLETTER_SLUG = 'default';

type NewsletterRow = {
  id?: unknown;
  status?: unknown;
};

type CountRow = {
  recipient_count?: unknown;
  pending_count?: unknown;
};

export type PreparePostNotificationResult =
  | { kind: 'unavailable' }
  | {
      kind: 'prepared';
      newsletterId: string;
      idempotencyPrefix: string;
      recipientCount: number;
      newlyQueuedCount: number;
      pendingCount: number;
    };

function queryFailure(error: unknown, action: string) {
  return new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function writeFailure(error: unknown, action: string) {
  return new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
      metadata: {
        resource: 'EDGE_DB',
        action: 'validate_post_notification_counts',
      },
    });
  }
  return parsed;
}

function changes(result: D1Result<unknown>): number {
  return count(result.meta?.changes);
}

export function postNotificationIdempotencyPrefix(input: {
  postId: string;
  postRevision: string;
}): string {
  return `post-notification:${input.postId}:${input.postRevision}:`;
}

export async function preparePostNotification(input: {
  edgeDb: D1Database;
  postId: string;
  postRevision: string;
  subject: string;
  now: Date;
}): Promise<PreparePostNotificationResult> {
  let newsletter: NewsletterRow | null;
  try {
    newsletter = await input.edgeDb.prepare(`
      SELECT id, status
      FROM newsletter_lists
      WHERE slug = ?
      LIMIT 1
    `).bind(CANONICAL_NEWSLETTER_SLUG).first<NewsletterRow>();
  } catch (error) {
    throw queryFailure(error, 'read_post_notification_newsletter');
  }
  if (
    !newsletter
    || typeof newsletter.id !== 'string'
    || newsletter.status !== 'active'
  ) return { kind: 'unavailable' };

  const timestamp = input.now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const prefix = postNotificationIdempotencyPrefix({
    postId: input.postId,
    postRevision: input.postRevision,
  });
  const upperBound = `${prefix}\uffff`;
  let inserted: D1Result<unknown>;
  try {
    inserted = await input.edgeDb.prepare(`
      INSERT OR IGNORE INTO newsletter_deliveries (
        id,
        newsletter_id,
        subscription_id,
        delivery_type,
        content_id,
        idempotency_key,
        subject,
        provider,
        status,
        attempt_count,
        failure_code,
        queued_at,
        last_attempt_at,
        sent_at,
        created_at,
        updated_at
      )
      SELECT
        lower(hex(randomblob(16))),
        subscription.newsletter_id,
        subscription.id,
        'post_notification',
        ?,
        ? || subscription.id,
        ?,
        NULL,
        'queued',
        0,
        NULL,
        ?,
        NULL,
        NULL,
        ?,
        ?
      FROM newsletter_subscriptions subscription
      INNER JOIN newsletter_subscribers subscriber
        ON subscriber.id = subscription.subscriber_id
      WHERE subscription.newsletter_id = ?
        AND subscription.status = 'subscribed'
        AND subscription.source_url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM newsletter_suppressions suppression
          WHERE suppression.email = subscriber.email
        )
    `).bind(
      input.postId,
      prefix,
      input.subject,
      timestamp,
      timestamp,
      timestamp,
      newsletter.id,
    ).run();
  } catch (error) {
    throw writeFailure(error, 'materialize_post_notification_deliveries');
  }

  let counts: CountRow | null;
  try {
    counts = await input.edgeDb.prepare(`
      SELECT
        COUNT(*) AS recipient_count,
        COALESCE(SUM(
          CASE
            WHEN status = 'queued' AND attempt_count = 0 THEN 1
            ELSE 0
          END
        ), 0) AS pending_count
      FROM newsletter_deliveries
      WHERE newsletter_id = ?
        AND delivery_type = 'post_notification'
        AND content_id = ?
        AND idempotency_key >= ?
        AND idempotency_key < ?
    `).bind(
      newsletter.id,
      input.postId,
      prefix,
      upperBound,
    ).first<CountRow>();
  } catch (error) {
    throw queryFailure(error, 'count_post_notification_deliveries');
  }
  return {
    kind: 'prepared',
    newsletterId: newsletter.id,
    idempotencyPrefix: prefix,
    recipientCount: count(counts?.recipient_count),
    newlyQueuedCount: changes(inserted),
    pendingCount: count(counts?.pending_count),
  };
}
