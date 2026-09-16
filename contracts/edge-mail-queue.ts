import { z } from 'zod';

/**
 * Edge Worker producers and the Studio producer/consumer must deploy this
 * strict contract as one reviewed release unit. There is intentionally no
 * legacy-message shim.
 */
export const EDGE_MAIL_QUEUE_CONTRACT_VERSION = 1 as const;

const opaqueIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const postRevisionSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const newsletterConfirmationMessageSchema = z.object({
  contract_version: z.literal(EDGE_MAIL_QUEUE_CONTRACT_VERSION),
  type: z.literal('newsletter.confirmation'),
  delivery_id: opaqueIdSchema,
  subscription_id: opaqueIdSchema,
  token: z.string().min(1).max(4_096),
  unsubscribe_token: z.string().regex(/^nu1\.[0-9a-f]{32}$/u),
}).strict();

export const formNotificationMessageSchema = z.object({
  contract_version: z.literal(EDGE_MAIL_QUEUE_CONTRACT_VERSION),
  type: z.literal('form.notification'),
  submission_id: opaqueIdSchema,
  recipient_user_id: opaqueIdSchema,
}).strict();

const postNotificationSnapshotSchema = z.object({
  newsletter_id: opaqueIdSchema,
  post_id: opaqueIdSchema,
  post_revision: postRevisionSchema,
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().max(500),
  public_path: z.string().startsWith('/').max(2_048),
}).strict();

export const newsletterPostNotificationDispatchMessageSchema = z.object({
  contract_version: z.literal(EDGE_MAIL_QUEUE_CONTRACT_VERSION),
  type: z.literal('newsletter.post_notification.dispatch'),
  snapshot: postNotificationSnapshotSchema,
  after_idempotency_key: z.string().min(1).max(255).nullable(),
}).strict();

export const newsletterPostNotificationMessageSchema = z.object({
  contract_version: z.literal(EDGE_MAIL_QUEUE_CONTRACT_VERSION),
  type: z.literal('newsletter.post_notification'),
  delivery_id: opaqueIdSchema,
  snapshot: postNotificationSnapshotSchema,
}).strict();

export const edgeMailQueueMessageSchema = z.discriminatedUnion('type', [
  newsletterConfirmationMessageSchema,
  formNotificationMessageSchema,
  newsletterPostNotificationDispatchMessageSchema,
  newsletterPostNotificationMessageSchema,
]);

export type EdgeMailQueueMessage = z.infer<typeof edgeMailQueueMessageSchema>;
