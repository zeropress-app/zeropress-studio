import { describe, expect, it } from 'vitest';
import {
  currentSessionResponseSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  revokeOtherSessionsRequestSchema,
  revokeOtherSessionsResponseSchema,
  revokeSessionRequestSchema,
  revokeSessionResponseSchema,
  sessionListResponseSchema,
} from './session';

const currentSession = {
  success: true,
  data: {
    user: {
      id: '0123456789abcdef0123456789abcdef',
      email: 'admin@example.com',
      name: 'Studio Owner',
      roles: ['admin'],
    },
    session: {
      id: 'fedcba9876543210fedcba9876543210',
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: '2026-07-31T00:05:00.000Z',
      idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
      absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
      network: {
        ip_address: '2001:db8::1',
        asn: 13335,
        as_organization: 'Cloudflare, Inc.',
        country_code: 'KR',
      },
    },
    csrf_token: 'c'.repeat(43),
    edge_integration: { mode: 'enabled', database_state: 'ready' },
  },
} as const;

describe('session contracts', () => {
  it('accepts the canonical current-session response with a full IP address', () => {
    expect(currentSessionResponseSchema.safeParse(currentSession).success)
      .toBe(true);
  });

  it('requires an explicit Edge database state and uses null while disabled', () => {
    const { database_state: _omitted, ...withoutDatabaseState } =
      currentSession.data.edge_integration;
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        edge_integration: withoutDatabaseState,
      },
    }).success).toBe(false);
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        edge_integration: { mode: 'disabled', database_state: null },
      },
    }).success).toBe(true);
  });

  it('requires both idle and absolute expiry in the current session', () => {
    const { idle_expires_at_iso: _omitted, ...sessionWithoutIdleExpiry } =
      currentSession.data.session;
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        session: sessionWithoutIdleExpiry,
      },
    }).success).toBe(false);
  });

  it('accepts only an absolute HTTP(S) site URL when one is present', () => {
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        site_url: 'https://example.com',
      },
    }).success).toBe(true);
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        site_url: 'javascript:alert(1)',
      },
    }).success).toBe(false);
  });

  it('accepts only a canonical non-empty site title when one is present', () => {
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        site_title: 'Editorial Magazine',
      },
    }).success).toBe(true);
    for (const siteTitle of [
      '',
      ' Editorial Magazine ',
      'a'.repeat(201),
    ]) {
      expect(currentSessionResponseSchema.safeParse({
        ...currentSession,
        data: {
          ...currentSession.data,
          site_title: siteTitle,
        },
      }).success).toBe(false);
    }
  });

  it('accepts only a public or authenticated Media preview avatar URL', () => {
    for (const avatarPreviewUrl of [
      'https://media.example.com/authors/owner.png',
      `/api/media/${'1'.repeat(32)}/preview?revision=${'2'.repeat(32)}`,
    ]) {
      expect(currentSessionResponseSchema.safeParse({
        ...currentSession,
        data: {
          ...currentSession.data,
          user: {
            ...currentSession.data.user,
            avatar_preview_url: avatarPreviewUrl,
          },
        },
      }).success).toBe(true);
    }
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        user: {
          ...currentSession.data.user,
          avatar_preview_url: 'javascript:alert(1)',
        },
      },
    }).success).toBe(false);
  });

  it('keeps session responses closed and role keys normalized', () => {
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        access_token: 'must-not-be-exposed',
      },
    }).success).toBe(false);
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        user: {
          ...currentSession.data.user,
          roles: ['Administrator'],
        },
      },
    }).success).toBe(false);
    expect(currentSessionResponseSchema.safeParse({
      ...currentSession,
      data: {
        ...currentSession.data,
        session: {
          ...currentSession.data.session,
          network: {
            ...currentSession.data.session.network,
            country_code: 'Korea',
          },
        },
      },
    }).success).toBe(false);
  });

  it('accepts only an empty logout request and stable response', () => {
    expect(logoutRequestSchema.safeParse({}).success).toBe(true);
    expect(logoutRequestSchema.safeParse({ reason: 'manual' }).success)
      .toBe(false);
    expect(logoutResponseSchema.safeParse({
      success: true,
      data: { status: 'logged_out' },
    }).success).toBe(true);
  });

  it('validates a closed, bounded active-session list', () => {
    const item = {
      id: '00112233445566778899aabbccddeeff',
      is_current: true,
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: '2026-07-31T00:05:00.000Z',
      idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
      absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
      user_agent: 'Mozilla/5.0',
      network: {
        ip_address: '203.0.113.10',
        asn: null,
        as_organization: null,
        country_code: null,
      },
    };
    expect(sessionListResponseSchema.safeParse({
      success: true,
      data: {
        items: [item],
        max_sessions: 5,
      },
    }).success).toBe(true);
    expect(sessionListResponseSchema.safeParse({
      success: true,
      data: {
        items: [{ ...item, secret_digest: 'must-not-leak' }],
        max_sessions: 5,
      },
    }).success).toBe(false);
  });

  it('keeps session revocation requests and results explicit', () => {
    const targetId = '00112233445566778899aabbccddeeff';
    expect(revokeSessionRequestSchema.safeParse({
      session_id: targetId,
    }).success).toBe(true);
    expect(revokeSessionRequestSchema.safeParse({
      session_id: targetId,
      user_id: 'must-not-be-accepted',
    }).success).toBe(false);
    expect(revokeSessionResponseSchema.safeParse({
      success: true,
      data: {
        status: 'session_revoked',
        revoked: true,
        current_session_ended: false,
      },
    }).success).toBe(true);
    expect(revokeOtherSessionsRequestSchema.safeParse({}).success).toBe(true);
    expect(revokeOtherSessionsRequestSchema.safeParse({
      keep_session_id: targetId,
    }).success).toBe(false);
    expect(revokeOtherSessionsResponseSchema.safeParse({
      success: true,
      data: {
        status: 'other_sessions_revoked',
        revoked_count: 4,
      },
    }).success).toBe(true);
  });
});
