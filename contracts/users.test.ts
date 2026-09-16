import { describe, expect, it } from 'vitest';
import {
  cancelUserInvitationRequestSchema,
  deleteUserAccountRequestSchema,
  inspectUserSetupSuccessSchema,
  managedUserSchema,
  resetUserAccessRequestSchema,
  updateUserNameRequestSchema,
  userDeletionImpactSuccessSchema,
  userListQuerySchema,
  userListSuccessSchema,
  userSetupIssuedSuccessSchema,
} from './users';

const managedUser = {
  id: '1'.repeat(32),
  email: 'author@example.com',
  name: 'Site Author',
  status: 'pending',
  role: 'author',
  mfa: {
    totp_configured: false,
    webauthn_credentials: 0,
  },
  active_sessions: 0,
  author: {
    id: 'Site-Author',
    display_name: 'Site Author',
  },
  setup: {
    purpose: 'credential_recovery',
    status: 'pending',
    expires_at_iso: '2026-07-31T13:00:00.000Z',
  },
  created_at_iso: '2026-07-30T00:00:00.000Z',
  updated_at_iso: '2026-07-31T12:00:00.000Z',
} as const;

describe('user setup and management contracts', () => {
  it('normalizes a bounded, closed user-list query', () => {
    expect(userListQuerySchema.parse({})).toEqual({
      search: '',
      role: 'all',
      status: 'all',
      page: 1,
      per_page: 50,
    });
    expect(userListQuerySchema.parse({
      search: '  Site Author  ',
      role: 'author',
      status: 'pending',
      page: '2',
      per_page: '100',
    })).toEqual({
      search: 'Site Author',
      role: 'author',
      status: 'pending',
      page: 2,
      per_page: 100,
    });
    expect(userListQuerySchema.safeParse({ per_page: 101 }).success)
      .toBe(false);
    expect(userListQuerySchema.safeParse({ search: 'a'.repeat(201) }).success)
      .toBe(false);
    expect(userListQuerySchema.safeParse({ unknown: true }).success)
      .toBe(false);
  });

  it('requires pagination and whole-scope status counts in user lists', () => {
    const response = {
      success: true,
      data: {
        items: [managedUser],
        pagination: {
          page: 1,
          per_page: 50,
          total: 1,
          total_pages: 1,
        },
        status_counts: {
          all: 3,
          pending: 1,
          active: 1,
          inactive: 1,
        },
        summary: {
          total: 3,
          pending: 1,
          active: 1,
          inactive: 1,
          administrators: 1,
        },
      },
    } as const;
    expect(userListSuccessSchema.safeParse(response).success).toBe(true);
    expect(userListSuccessSchema.safeParse({
      ...response,
      data: { items: response.data.items },
    }).success).toBe(false);
    expect(userListSuccessSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        items: Array.from({ length: 101 }, () => managedUser),
      },
    }).success).toBe(false);
    expect(userListSuccessSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        summary: { ...response.data.summary, total: 4 },
      },
    }).success).toBe(false);
  });

  it('distinguishes invitation and credential-recovery setup state', () => {
    expect(managedUserSchema.safeParse(managedUser).success).toBe(true);
    expect(managedUserSchema.safeParse({
      ...managedUser,
      setup: { ...managedUser.setup, purpose: 'unknown' },
    }).success).toBe(false);
    expect(inspectUserSetupSuccessSchema.safeParse({
      success: true,
      data: {
        purpose: 'credential_recovery',
        email: managedUser.email,
        name: managedUser.name,
        role: managedUser.role,
        expires_at_iso: managedUser.setup.expires_at_iso,
      },
    }).success).toBe(true);
  });

  it('keeps access-reset requests and one-time responses closed', () => {
    expect(resetUserAccessRequestSchema.safeParse({
      user_id: managedUser.id,
      management_token: 'm'.repeat(64),
    }).success).toBe(true);
    expect(resetUserAccessRequestSchema.safeParse({
      user_id: managedUser.id,
      management_token: 'm'.repeat(64),
      preserve_passkeys: true,
    }).success).toBe(false);
    expect(userSetupIssuedSuccessSchema.safeParse({
      success: true,
      data: {
        status: 'credential_recovery_created',
        user: managedUser,
        setup_url: `https://studio.example/activate#token=${'a'.repeat(32)}.${'A'.repeat(43)}`,
        expires_at_iso: managedUser.setup.expires_at_iso,
      },
    }).success).toBe(true);
  });

  it('requires optimistic concurrency for private display-name changes', () => {
    expect(updateUserNameRequestSchema.safeParse({
      user_id: managedUser.id,
      name: 'Updated Studio Name',
      expected_updated_at_iso: managedUser.updated_at_iso,
      management_token: 'm'.repeat(64),
    }).success).toBe(true);
    expect(updateUserNameRequestSchema.safeParse({
      user_id: managedUser.id,
      name: 'Updated Studio Name',
      management_token: 'm'.repeat(64),
    }).success).toBe(false);
    expect(updateUserNameRequestSchema.safeParse({
      user_id: managedUser.id,
      name: 'Updated Studio Name',
      expected_updated_at_iso: managedUser.updated_at_iso,
      management_token: 'm'.repeat(64),
      email: 'new@example.com',
    }).success).toBe(false);
  });

  it('keeps destructive user operations explicit, closed, and impact-first', () => {
    expect(userDeletionImpactSuccessSchema.safeParse({
      success: true,
      data: {
        operation: 'delete_account',
        user: { ...managedUser, status: 'inactive', setup: null },
        effects: {
          post_autosaves: 2,
          page_autosaves: 1,
          media_upload_intents: 3,
        },
      },
    }).success).toBe(true);
    expect(cancelUserInvitationRequestSchema.safeParse({
      user_id: managedUser.id,
      confirmation_email: 'AUTHOR@EXAMPLE.COM',
      management_token: 'm'.repeat(64),
    })).toMatchObject({
      success: true,
      data: { confirmation_email: 'author@example.com' },
    });
    expect(deleteUserAccountRequestSchema.safeParse({
      user_id: managedUser.id,
      confirmation_email: managedUser.email,
      acknowledge_recovery_copy_deletion: true,
      management_token: 'm'.repeat(64),
    }).success).toBe(true);
    expect(deleteUserAccountRequestSchema.safeParse({
      user_id: managedUser.id,
      confirmation_email: managedUser.email,
      acknowledge_recovery_copy_deletion: false,
      management_token: 'm'.repeat(64),
    }).success).toBe(false);
    expect(cancelUserInvitationRequestSchema.safeParse({
      user_id: managedUser.id,
      confirmation_email: managedUser.email,
      management_token: 'm'.repeat(64),
      delete_content: true,
    }).success).toBe(false);
  });
});
