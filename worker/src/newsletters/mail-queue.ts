import {
  EDGE_MAIL_QUEUE_CONTRACT_VERSION,
  edgeMailQueueMessageSchema,
  newsletterPostNotificationDispatchMessageSchema,
  newsletterPostNotificationMessageSchema,
  type EdgeMailQueueMessage,
} from '../../../contracts/edge-mail-queue';
import { isConfiguredAuthSecret } from '../auth/mfa-crypto';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import {
  logOperationalFailure,
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import {
  MailProviderFailure,
  sendMail,
} from '../mail/provider';
import { readMailRuntimeConfiguration } from '../mail/settings-repository';
import type { Env } from '../types';
import { requireNewsletterEdgeDatabase } from './edge-resources';
import { postNotificationIdempotencyPrefix } from './post-notification-repository';

type NewsletterConfirmationRow = {
  delivery_id?: unknown;
  subscription_id?: unknown;
  source_url?: unknown;
  email?: unknown;
  title?: unknown;
  description?: unknown;
};

type FormNotificationRow = {
  submission_id?: unknown;
  source_url?: unknown;
  submitted_at?: unknown;
  title?: unknown;
};

type FormNotificationRecipientRow = {
  email?: unknown;
};

type FormValueRow = {
  field_label?: unknown;
  field_type?: unknown;
  field_value?: unknown;
};

type PostNotificationDispatchRow = {
  id?: unknown;
  idempotency_key?: unknown;
};

type PostNotificationRow = {
  delivery_id?: unknown;
  subscription_id?: unknown;
  source_url?: unknown;
  email?: unknown;
  subscription_status?: unknown;
  newsletter_status?: unknown;
  suppression_id?: unknown;
  delivery_status?: unknown;
  attempt_count?: unknown;
  idempotency_key?: unknown;
};

type RuntimeMailConfiguration = Awaited<ReturnType<
  typeof readMailRuntimeConfiguration
>>;

type MailQueueServiceDependencies = {
  readMailConfiguration?: typeof readMailRuntimeConfiguration;
  send?: typeof sendMail;
  now?: () => Date;
};

function queueQueryFailure(error: unknown, action: string) {
  return new StudioOperationalError('EDGE_MAIL_QUEUE_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function queueWriteFailure(error: unknown, action: string) {
  return new StudioOperationalError('EDGE_MAIL_QUEUE_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action },
  });
}

function safeFailureReason(error: unknown): string {
  if (error instanceof MailProviderFailure) return error.kind;
  if (error instanceof StudioOperationalError) return error.code;
  return 'unexpected_failure';
}

function readChanges(result: D1Result<unknown>): number {
  const value = Number(result.meta?.changes ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Mail queue change count is invalid.');
  }
  return value;
}

function formatEdgeTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Mail queue time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function confirmationUrl(sourceUrl: string, token: string): string {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Newsletter source URL must use HTTP(S).');
  }
  url.hash = `confirm_token=${encodeURIComponent(token)}`;
  return url.toString();
}

function unsubscribeUrl(sourceUrl: string, token: string): string {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Newsletter source URL must use HTTP(S).');
  }
  url.hash = `unsubscribe_token=${encodeURIComponent(token)}`;
  return url.toString();
}

function newsletterConfirmationEmail(input: {
  email: string;
  title: string;
  description: string | null;
  sourceUrl: string;
  token: string;
  unsubscribeToken: string;
}) {
  const url = confirmationUrl(input.sourceUrl, input.token);
  const unsubscribe = unsubscribeUrl(
    input.sourceUrl,
    input.unsubscribeToken,
  );
  const description = input.description || 'Please confirm your subscription.';
  const subject = `Confirm your subscription to ${input.title}`;
  return {
    to: input.email,
    subject,
    html: [
      '<!doctype html><html lang="en"><body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827">',
      `<h1>${escapeHtml(input.title)}</h1>`,
      `<p>${escapeHtml(description)}</p>`,
      '<p>Use the button below to confirm your subscription.</p>',
      `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px">Confirm subscription</a></p>`,
      '<p>If the button does not work, open this URL:</p>',
      `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">',
      `<p style="font-size:13px;color:#6b7280">If you did not request this email, <a href="${escapeHtml(unsubscribe)}">unsubscribe this address</a>.</p>`,
      '</body></html>',
    ].join(''),
    text: `${input.title}\n\n${description}\n\nConfirm your subscription:\n${url}\n\nIf you did not request this email, unsubscribe this address:\n${unsubscribe}\n`,
  };
}

function postPublicUrl(sourceUrl: string, publicPath: string): string {
  const source = new URL(sourceUrl);
  if (source.protocol !== 'http:' && source.protocol !== 'https:') {
    throw new TypeError('Newsletter source URL must use HTTP(S).');
  }
  return new URL(publicPath, `${source.origin}/`).toString();
}

function postNotificationEmail(input: {
  email: string;
  title: string;
  excerpt: string;
  publicPath: string;
  sourceUrl: string;
  unsubscribeToken: string;
}) {
  const url = postPublicUrl(input.sourceUrl, input.publicPath);
  const unsubscribe = unsubscribeUrl(
    input.sourceUrl,
    input.unsubscribeToken,
  );
  const excerpt = input.excerpt || 'A new post is available.';
  const subject = `New post: ${input.title}`;
  return {
    to: input.email,
    subject,
    html: [
      '<!doctype html><html lang="en"><body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827">',
      `<h1>${escapeHtml(input.title)}</h1>`,
      `<p>${escapeHtml(excerpt)}</p>`,
      `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px">Read the post</a></p>`,
      '<p>If the button does not work, open this URL:</p>',
      `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">',
      `<p style="font-size:13px;color:#6b7280">You received this because you subscribed to site updates. <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a>.</p>`,
      '</body></html>',
    ].join(''),
    text: `${input.title}\n\n${excerpt}\n\nRead the post:\n${url}\n\nUnsubscribe:\n${unsubscribe}\n`,
  };
}

function fieldValue(value: FormValueRow): string {
  if (typeof value.field_value !== 'string') {
    throw new TypeError('Form notification value is invalid.');
  }
  if (value.field_type !== 'checkbox') return value.field_value;
  try {
    const parsed = JSON.parse(value.field_value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry)).join(', ')
      : value.field_value;
  } catch {
    return value.field_value;
  }
}

function formEmail(input: {
  title: string;
  recipient: string;
  sourceUrl: string | null;
  submittedAt: string;
  values: FormValueRow[];
}) {
  const rows = input.values.map((value) => {
    if (typeof value.field_label !== 'string') {
      throw new TypeError('Form notification field label is invalid.');
    }
    return {
      label: value.field_label,
      value: fieldValue(value),
    };
  });
  const source = input.sourceUrl ? `Source: ${input.sourceUrl}\n` : '';
  return {
    to: input.recipient,
    subject: `[ZeroPress] New form submission: ${input.title}`,
    html: [
      '<!doctype html><html lang="en"><body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827">',
      `<h1>${escapeHtml(input.title)}</h1>`,
      '<p>A new form submission was received.</p>',
      '<table style="border-collapse:collapse;min-width:320px"><tbody>',
      ...rows.map((row) => `<tr><th style="text-align:left;padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(row.label)}</th><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(row.value)}</td></tr>`),
      '</tbody></table>',
      `<p><strong>Submitted at:</strong> ${escapeHtml(input.submittedAt)}</p>`,
      input.sourceUrl
        ? `<p><strong>Source:</strong> <code>${escapeHtml(input.sourceUrl)}</code></p>`
        : '',
      '</body></html>',
    ].join(''),
    text: `New form submission: ${input.title}\n\n${rows.map((row) => `${row.label}: ${row.value}`).join('\n')}\n\nSubmitted at: ${input.submittedAt}\n${source}`,
  };
}

export class EdgeMailQueueService {
  private readonly readMailConfiguration: typeof readMailRuntimeConfiguration;
  private readonly send: typeof sendMail;
  private readonly now: () => Date;

  constructor(
    private readonly env: Env,
    dependencies: MailQueueServiceDependencies = {},
  ) {
    this.readMailConfiguration = dependencies.readMailConfiguration
      ?? readMailRuntimeConfiguration;
    this.send = dependencies.send ?? sendMail;
    this.now = dependencies.now ?? (() => new Date());
  }

  async process(message: EdgeMailQueueMessage, queueAttempt = 1): Promise<void> {
    if (message.type === 'newsletter.confirmation') {
      await this.processNewsletterConfirmation(message);
      return;
    }
    if (message.type === 'form.notification') {
      await this.processFormNotification(message);
      return;
    }
    if (message.type === 'newsletter.post_notification.dispatch') {
      await this.processPostNotificationDispatch(message);
      return;
    }
    await this.processPostNotification(message, Math.max(1, queueAttempt));
  }

  private async mailConfiguration(): Promise<
    Extract<RuntimeMailConfiguration, { kind: 'configured' }>
  > {
    if (!isConfiguredAuthSecret(this.env.STUDIO_AUTH_SECRET)) {
      throw new StudioOperationalError('AUTH_SECRET_NOT_CONFIGURED', {
        metadata: {
          component: 'worker_configuration',
          action: 'process_edge_mail_queue',
        },
      });
    }
    const configuration = await this.readMailConfiguration({
      db: this.env.DB,
      authSecret: this.env.STUDIO_AUTH_SECRET,
    });
    if (configuration.kind === 'not_configured') {
      throw new StudioOperationalError('EDGE_MAIL_QUEUE_CONFIGURATION_NOT_AVAILABLE', {
        metadata: {
          resource: 'DB',
          action: 'resolve_mail_delivery_configuration',
        },
      });
    }
    return configuration;
  }

  private async optionalMailConfiguration(): Promise<
    Extract<RuntimeMailConfiguration, { kind: 'configured' }> | null
  > {
    if (!isConfiguredAuthSecret(this.env.STUDIO_AUTH_SECRET)) return null;
    const configuration = await this.readMailConfiguration({
      db: this.env.DB,
      authSecret: this.env.STUDIO_AUTH_SECRET,
    });
    return configuration.kind === 'configured' ? configuration : null;
  }

  private async deliver(input: {
    configuration: Extract<RuntimeMailConfiguration, { kind: 'configured' }>;
    message: ReturnType<typeof newsletterConfirmationEmail>
      | ReturnType<typeof formEmail>
      | ReturnType<typeof postNotificationEmail>;
    idempotencyKey?: string;
  }): Promise<void> {
    await this.send({
      provider: input.configuration.settings.provider,
      credential: input.configuration.credential,
      cloudflareAccountId:
        input.configuration.settings.cloudflare_account_id,
      fromEmail: input.configuration.settings.from_email,
      fromName: input.configuration.settings.from_name,
      ...input.message,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async processNewsletterConfirmation(
    message: Extract<EdgeMailQueueMessage, { type: 'newsletter.confirmation' }>,
  ): Promise<void> {
    const edgeDb = requireNewsletterEdgeDatabase(this.env);
    const tokenHash = await sha256Base64Url(message.token);
    const now = formatEdgeTimestamp(this.now());
    let row: NewsletterConfirmationRow | null;
    try {
      row = await edgeDb.prepare(`
        SELECT
          delivery.id AS delivery_id,
          subscription.id AS subscription_id,
          subscription.source_url,
          subscriber.email,
          list.title,
          list.description
        FROM newsletter_subscriptions subscription
        INNER JOIN newsletter_subscribers subscriber
          ON subscriber.id = subscription.subscriber_id
        INNER JOIN newsletter_lists list
          ON list.id = subscription.newsletter_id
        INNER JOIN newsletter_deliveries delivery
          ON delivery.id = ?
          AND delivery.subscription_id = subscription.id
          AND delivery.newsletter_id = list.id
          AND delivery.delivery_type = 'confirmation'
          AND delivery.status IN ('queued', 'failed')
        WHERE subscription.id = ?
          AND subscription.status = 'pending'
          AND list.status = 'active'
          AND subscription.confirm_token_hash = ?
          AND subscription.confirm_expires_at > ?
          AND subscription.confirm_email_status != 'sent'
        LIMIT 1
      `).bind(message.delivery_id, message.subscription_id, tokenHash, now)
        .first<NewsletterConfirmationRow>();
    } catch (error) {
      throw queueQueryFailure(error, 'read_newsletter_confirmation_job');
    }
    if (!row) {
      try {
        await edgeDb.prepare(`
          UPDATE newsletter_deliveries
          SET status = 'skipped',
              failure_code = 'not_deliverable',
              sent_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND subscription_id = ?
            AND delivery_type = 'confirmation'
            AND status IN ('queued', 'failed')
        `).bind(now, message.delivery_id, message.subscription_id).run();
      } catch (error) {
        throw queueWriteFailure(error, 'skip_newsletter_confirmation');
      }
      return;
    }
    if (
      row.delivery_id !== message.delivery_id
      || typeof row.email !== 'string'
      || typeof row.title !== 'string'
      || typeof row.source_url !== 'string'
      || (row.description !== null && typeof row.description !== 'string')
    ) {
      throw new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'validate_newsletter_confirmation_job',
        },
      });
    }

    const mailMessage = newsletterConfirmationEmail({
      email: row.email,
      title: row.title,
      description: row.description as string | null,
      sourceUrl: row.source_url,
      token: message.token,
      unsubscribeToken: message.unsubscribe_token,
    });
    let attemptStarted = false;
    let provider: 'resend' | 'cloudflare' | null = null;
    try {
      try {
        await edgeDb.prepare(`
          UPDATE newsletter_deliveries
          SET status = 'queued',
              subject = ?,
              attempt_count = attempt_count + 1,
              failure_code = NULL,
              last_attempt_at = ?,
              sent_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'failed')
        `).bind(
          mailMessage.subject,
          now,
          now,
          message.delivery_id,
        ).run();
        attemptStarted = true;
      } catch (error) {
        throw queueWriteFailure(error, 'begin_newsletter_confirmation_attempt');
      }
      const configuration = await this.mailConfiguration();
      provider = configuration.settings.provider;
      await this.deliver({
        configuration,
        message: mailMessage,
        idempotencyKey: `newsletter-delivery-${message.delivery_id}`,
      });
      const sentAt = formatEdgeTimestamp(this.now());
      try {
        await edgeDb.batch([
          edgeDb.prepare(`
            UPDATE newsletter_subscriptions
            SET confirm_email_status = 'sent',
                confirm_email_error = NULL,
                confirm_sent_at = ?,
                updated_at = ?
            WHERE id = ?
              AND status = 'pending'
              AND confirm_token_hash = ?
          `).bind(sentAt, sentAt, message.subscription_id, tokenHash),
          edgeDb.prepare(`
            UPDATE newsletter_deliveries
            SET provider = ?,
                status = 'sent',
                failure_code = NULL,
                sent_at = ?,
                updated_at = ?
            WHERE id = ?
              AND status = 'queued'
          `).bind(provider, sentAt, sentAt, message.delivery_id),
        ]);
      } catch (error) {
        throw queueWriteFailure(error, 'mark_newsletter_confirmation_sent');
      }
    } catch (error) {
      const failedAt = formatEdgeTimestamp(this.now());
      try {
        const failureCode = safeFailureReason(error);
        await edgeDb.batch([
          edgeDb.prepare(`
            UPDATE newsletter_subscriptions
            SET confirm_email_status = 'failed',
                confirm_email_error = ?,
                updated_at = ?
            WHERE id = ?
              AND status = 'pending'
              AND confirm_token_hash = ?
          `).bind(
            failureCode,
            failedAt,
            message.subscription_id,
            tokenHash,
          ),
          edgeDb.prepare(`
            UPDATE newsletter_deliveries
            SET provider = ?,
                subject = ?,
                status = 'failed',
                attempt_count = attempt_count + ?,
                failure_code = ?,
                last_attempt_at = COALESCE(last_attempt_at, ?),
                sent_at = NULL,
                updated_at = ?
            WHERE id = ?
              AND status IN ('queued', 'failed')
          `).bind(
            provider,
            mailMessage.subject,
            attemptStarted ? 0 : 1,
            failureCode,
            failedAt,
            failedAt,
            message.delivery_id,
          ),
        ]);
      } catch (writeError) {
        throw queueWriteFailure(
          writeError,
          'mark_newsletter_confirmation_failed',
        );
      }
      throw error;
    }
  }

  private async processFormNotification(
    message: Extract<EdgeMailQueueMessage, { type: 'form.notification' }>,
  ): Promise<void> {
    const edgeDb = requireNewsletterEdgeDatabase(this.env);
    let row: FormNotificationRow | null;
    let values: FormValueRow[];
    try {
      row = await edgeDb.prepare(`
        SELECT
          submission.id AS submission_id,
          submission.source_url,
          submission.submitted_at,
          form.title
        FROM form_submissions submission
        INNER JOIN forms form ON form.id = submission.form_id
        WHERE submission.id = ?
        LIMIT 1
      `).bind(message.submission_id).first<FormNotificationRow>();
      if (!row) return;
      const result = await edgeDb.prepare(`
        SELECT field_label, field_type, field_value
        FROM form_submission_values
        WHERE submission_id = ?
        ORDER BY created_at ASC, field_key ASC
      `).bind(message.submission_id).all<FormValueRow>();
      values = result.results ?? [];
    } catch (error) {
      throw queueQueryFailure(error, 'read_form_notification_job');
    }
    if (
      typeof row.title !== 'string'
      || typeof row.submitted_at !== 'string'
      || (row.source_url !== null && typeof row.source_url !== 'string')
    ) {
      throw new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'validate_form_notification_job',
        },
      });
    }
    let recipient: FormNotificationRecipientRow | null;
    try {
      recipient = await this.env.DB.prepare(`
        SELECT u.email
        FROM users u
        WHERE u.id = ?
          AND u.status = 'active'
          AND u.email_verified = 1
          AND EXISTS (
            SELECT 1
            FROM user_roles ur
            WHERE ur.user_id = u.id
              AND ur.role_key IN ('admin', 'editor')
          )
        LIMIT 1
      `).bind(message.recipient_user_id).first<FormNotificationRecipientRow>();
    } catch (error) {
      throw new StudioOperationalError('EDGE_MAIL_QUEUE_DATABASE_QUERY_FAILED', {
        cause: error,
        metadata: { resource: 'DB', action: 'read_form_notification_recipient' },
      });
    }
    if (!recipient || typeof recipient.email !== 'string') return;
    const configuration = await this.optionalMailConfiguration();
    if (!configuration) return;
    await this.deliver({
      configuration,
      message: formEmail({
        title: row.title,
        recipient: recipient.email,
        sourceUrl: row.source_url as string | null,
        submittedAt: row.submitted_at,
        values,
      }),
      idempotencyKey:
        `form-notification-${message.submission_id}-${message.recipient_user_id}`,
    });
  }

  private async processPostNotificationDispatch(
    message: Extract<
      EdgeMailQueueMessage,
      { type: 'newsletter.post_notification.dispatch' }
    >,
  ): Promise<void> {
    const edgeDb = requireNewsletterEdgeDatabase(this.env);
    if (!this.env.MAIL_QUEUE) {
      throw new StudioOperationalError('NEWSLETTER_POST_NOTIFICATION_QUEUE_FAILED', {
        metadata: {
          component: 'worker_binding',
          resource: 'MAIL_QUEUE',
          action: 'fan_out_post_notification',
        },
      });
    }
    const prefix = postNotificationIdempotencyPrefix({
      postId: message.snapshot.post_id,
      postRevision: message.snapshot.post_revision,
    });
    const upperBound = `${prefix}\uffff`;
    let rows: PostNotificationDispatchRow[];
    try {
      const result = await edgeDb.prepare(`
        SELECT id, idempotency_key
        FROM newsletter_deliveries
        WHERE newsletter_id = ?
          AND delivery_type = 'post_notification'
          AND content_id = ?
          AND status = 'queued'
          AND attempt_count = 0
          AND idempotency_key >= ?
          AND idempotency_key < ?
          AND (? IS NULL OR idempotency_key > ?)
        ORDER BY idempotency_key ASC
        LIMIT 100
      `).bind(
        message.snapshot.newsletter_id,
        message.snapshot.post_id,
        prefix,
        upperBound,
        message.after_idempotency_key,
        message.after_idempotency_key,
      ).all<PostNotificationDispatchRow>();
      rows = result.results ?? [];
    } catch (error) {
      throw queueQueryFailure(error, 'list_post_notification_dispatch_batch');
    }
    for (const row of rows) {
      if (
        typeof row.id !== 'string'
        || typeof row.idempotency_key !== 'string'
      ) {
        throw new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
          metadata: {
            resource: 'EDGE_DB',
            action: 'validate_post_notification_dispatch_batch',
          },
        });
      }
    }
    if (rows.length === 0) return;

    const needsContinuation = rows.length === 100;
    const recipientRows = needsContinuation ? rows.slice(0, 99) : rows;
    const jobs: EdgeMailQueueMessage[] = recipientRows.map((row) => (
      newsletterPostNotificationMessageSchema.parse({
        contract_version: EDGE_MAIL_QUEUE_CONTRACT_VERSION,
        type: 'newsletter.post_notification',
        delivery_id: row.id,
        snapshot: message.snapshot,
      })
    ));
    if (needsContinuation) {
      jobs.push(newsletterPostNotificationDispatchMessageSchema.parse({
        ...message,
        after_idempotency_key:
          recipientRows[recipientRows.length - 1].idempotency_key,
      }));
    }
    await this.env.MAIL_QUEUE.sendBatch(jobs.map((body) => ({ body })));
  }

  private async processPostNotification(
    message: Extract<
      EdgeMailQueueMessage,
      { type: 'newsletter.post_notification' }
    >,
    queueAttempt: number,
  ): Promise<void> {
    const edgeDb = requireNewsletterEdgeDatabase(this.env);
    const prefix = postNotificationIdempotencyPrefix({
      postId: message.snapshot.post_id,
      postRevision: message.snapshot.post_revision,
    });
    let row: PostNotificationRow | null;
    try {
      row = await edgeDb.prepare(`
        SELECT
          delivery.id AS delivery_id,
          delivery.subscription_id,
          delivery.status AS delivery_status,
          delivery.attempt_count,
          delivery.idempotency_key,
          subscription.source_url,
          subscription.status AS subscription_status,
          subscriber.email,
          list.status AS newsletter_status,
          suppression.id AS suppression_id
        FROM newsletter_deliveries delivery
        INNER JOIN newsletter_subscriptions subscription
          ON subscription.id = delivery.subscription_id
        INNER JOIN newsletter_subscribers subscriber
          ON subscriber.id = subscription.subscriber_id
        INNER JOIN newsletter_lists list
          ON list.id = delivery.newsletter_id
        LEFT JOIN newsletter_suppressions suppression
          ON suppression.email = subscriber.email
        WHERE delivery.id = ?
          AND delivery.newsletter_id = ?
          AND delivery.delivery_type = 'post_notification'
          AND delivery.content_id = ?
          AND delivery.idempotency_key = ? || subscription.id
        LIMIT 1
      `).bind(
        message.delivery_id,
        message.snapshot.newsletter_id,
        message.snapshot.post_id,
        prefix,
      ).first<PostNotificationRow>();
    } catch (error) {
      throw queueQueryFailure(error, 'read_post_notification_job');
    }
    if (!row) return;
    if (
      row.delivery_id !== message.delivery_id
      || typeof row.subscription_id !== 'string'
      || typeof row.email !== 'string'
      || typeof row.idempotency_key !== 'string'
      || typeof row.attempt_count !== 'number'
      || typeof row.delivery_status !== 'string'
    ) {
      throw new StudioOperationalError('NEWSLETTER_MANAGEMENT_DATA_INVALID', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'validate_post_notification_job',
        },
      });
    }
    if (row.delivery_status === 'sent' || row.delivery_status === 'skipped') {
      return;
    }
    const deliverable = row.subscription_status === 'subscribed'
      && row.newsletter_status === 'active'
      && row.suppression_id === null
      && typeof row.source_url === 'string';
    const now = formatEdgeTimestamp(this.now());
    if (!deliverable) {
      try {
        await edgeDb.prepare(`
          UPDATE newsletter_deliveries
          SET status = 'skipped',
              failure_code = 'not_deliverable',
              sent_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'failed')
        `).bind(now, message.delivery_id).run();
      } catch (error) {
        throw queueWriteFailure(error, 'skip_post_notification');
      }
      return;
    }

    const mailMessage = postNotificationEmail({
      email: row.email,
      title: message.snapshot.title,
      excerpt: message.snapshot.excerpt,
      publicPath: message.snapshot.public_path,
      sourceUrl: row.source_url as string,
      unsubscribeToken: `nu1.${row.subscription_id}`,
    });
    let provider: 'resend' | 'cloudflare' | null = null;
    let claimed = false;
    try {
      let claim: D1Result<unknown>;
      try {
        claim = await edgeDb.prepare(`
          UPDATE newsletter_deliveries
          SET status = 'queued',
              subject = ?,
              attempt_count = ?,
              failure_code = NULL,
              last_attempt_at = ?,
              sent_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'failed')
            AND attempt_count < ?
        `).bind(
          mailMessage.subject,
          queueAttempt,
          now,
          now,
          message.delivery_id,
          queueAttempt,
        ).run();
      } catch (error) {
        throw queueWriteFailure(error, 'begin_post_notification_attempt');
      }
      claimed = readChanges(claim) === 1;
      if (!claimed) return;
      const configuration = await this.mailConfiguration();
      provider = configuration.settings.provider;
      await this.deliver({
        configuration,
        message: mailMessage,
        idempotencyKey: `newsletter-delivery-${message.delivery_id}`,
      });
      const sentAt = formatEdgeTimestamp(this.now());
      try {
        await edgeDb.prepare(`
          UPDATE newsletter_deliveries
          SET provider = ?,
              status = 'sent',
              failure_code = NULL,
              sent_at = ?,
              updated_at = ?
          WHERE id = ?
            AND status = 'queued'
            AND attempt_count = ?
        `).bind(
          provider,
          sentAt,
          sentAt,
          message.delivery_id,
          queueAttempt,
        ).run();
      } catch (error) {
        throw queueWriteFailure(error, 'mark_post_notification_sent');
      }
    } catch (error) {
      if (claimed) {
        const failedAt = formatEdgeTimestamp(this.now());
        try {
          await edgeDb.prepare(`
            UPDATE newsletter_deliveries
            SET provider = ?,
                subject = ?,
                status = 'failed',
                failure_code = ?,
                last_attempt_at = COALESCE(last_attempt_at, ?),
                sent_at = NULL,
                updated_at = ?
            WHERE id = ?
              AND status IN ('queued', 'failed')
              AND attempt_count = ?
          `).bind(
            provider,
            mailMessage.subject,
            safeFailureReason(error),
            failedAt,
            failedAt,
            message.delivery_id,
            queueAttempt,
          ).run();
        } catch (writeError) {
          throw queueWriteFailure(writeError, 'mark_post_notification_failed');
        }
      }
      throw error;
    }
  }
}

function logQueueFailure(input: {
  error: unknown;
  type: EdgeMailQueueMessage['type'];
  attempt: number;
}) {
  const metadata = {
    trigger: 'queue',
    queue: 'mail',
    message_type: input.type,
    attempt: input.attempt,
    disposition: 'retry',
  };
  if (input.error instanceof MailProviderFailure && input.error.operationalError) {
    logStudioOperationalError(input.error.operationalError, metadata);
    return;
  }
  if (input.error instanceof StudioOperationalError) {
    logStudioOperationalError(input.error, metadata);
    return;
  }
  logOperationalFailure('EDGE_MAIL_QUEUE_PROCESSING_FAILED', {
    cause: input.error,
    metadata,
  });
}

export async function handleEdgeMailQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  createService: (env: Env) => EdgeMailQueueService =
    (serviceEnv) => new EdgeMailQueueService(serviceEnv),
  inspectRuntime: typeof inspectEdgeDatabaseRuntimeState =
    inspectEdgeDatabaseRuntimeState,
): Promise<void> {
  if (batch.messages.length === 0) return;
  const runtime = await inspectRuntime({ edgeDb: env.EDGE_DB });
  if (runtime.state !== 'ready') {
    logOperationalFailure('EDGE_MAIL_QUEUE_PROCESSING_FAILED', {
      metadata: {
        trigger: 'queue',
        queue: 'mail',
        disposition: 'retry',
        reason: `edge_database_${runtime.state}`,
        message_count: batch.messages.length,
      },
    });
    for (const message of batch.messages) message.retry();
    return;
  }
  const service = createService(env);
  for (const message of batch.messages) {
    const parsed = edgeMailQueueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      logOperationalFailure('EDGE_MAIL_QUEUE_MESSAGE_INVALID', {
        metadata: {
          trigger: 'queue',
          queue: 'mail',
          attempt: message.attempts,
          disposition: 'discard',
        },
      });
      message.ack();
      continue;
    }
    try {
      await service.process(parsed.data, message.attempts);
      message.ack();
    } catch (error) {
      logQueueFailure({
        error,
        type: parsed.data.type,
        attempt: message.attempts,
      });
      message.retry();
    }
  }
}
