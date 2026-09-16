import { describe, expect, it } from 'vitest';
import { edgeMailQueueMessageSchema } from './edge-mail-queue';

const snapshot = {
  newsletter_id: '1'.repeat(32),
  post_id: '2'.repeat(32),
  post_revision: '3'.repeat(32),
  title: 'Public beta',
  excerpt: 'Release notes',
  public_path: '/posts/public-beta/',
};

const messages = [
  {
    contract_version: 1,
    type: 'newsletter.confirmation',
    delivery_id: '4'.repeat(32),
    subscription_id: '5'.repeat(32),
    token: 'test-confirmation-token',
    unsubscribe_token: `nu1.${'5'.repeat(32)}`,
  },
  {
    contract_version: 1,
    type: 'form.notification',
    submission_id: '6'.repeat(32),
    recipient_user_id: '7'.repeat(32),
  },
  {
    contract_version: 1,
    type: 'newsletter.post_notification.dispatch',
    snapshot,
    after_idempotency_key: null,
  },
  {
    contract_version: 1,
    type: 'newsletter.post_notification',
    delivery_id: '8'.repeat(32),
    snapshot,
  },
];

describe.each(messages)('public beta mail contract: $type', (message) => {
  it('accepts the complete current payload as contract 1', () => {
    expect(edgeMailQueueMessageSchema.parse(message)).toEqual(message);
  });

  it.each([undefined, 0, 2, 3, '1'])('rejects contract version %s', (version) => {
    expect(edgeMailQueueMessageSchema.safeParse({
      ...message,
      contract_version: version,
    }).success).toBe(false);
  });

  it('rejects additional fields', () => {
    expect(edgeMailQueueMessageSchema.safeParse({
      ...message,
      recipient: 'untrusted@example.com',
    }).success).toBe(false);
  });
});

it.each(['delivery_id', 'unsubscribe_token'] as const)(
  'requires %s on confirmation messages',
  (field) => {
    const { [field]: _missing, ...incomplete } = messages[0];
    expect(edgeMailQueueMessageSchema.safeParse(incomplete).success).toBe(false);
  },
);
