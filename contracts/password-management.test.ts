import { describe, expect, it } from 'vitest';
import {
  changePasswordRequestSchema,
  changePasswordSuccessSchema,
} from './password-management';

describe('password management contracts', () => {
  it('requires a bounded new password and an operation grant', () => {
    expect(changePasswordRequestSchema.safeParse({
      management_token: 'm'.repeat(64),
      new_password: 'Harbor lantern canyon marble circuit 942!',
    }).success).toBe(true);
    expect(changePasswordRequestSchema.safeParse({
      management_token: 'm'.repeat(64),
      new_password: 'too short',
    }).success).toBe(false);
    expect(changePasswordRequestSchema.safeParse({
      management_token: 'm'.repeat(64),
      new_password: 'Harbor lantern canyon marble circuit 942!',
      current_password: 'must not be repeated here',
    }).success).toBe(false);
  });

  it('makes current-session termination explicit', () => {
    expect(changePasswordSuccessSchema.parse({
      success: true,
      data: {
        status: 'password_changed',
        revoked_sessions: 5,
        current_session_ended: true,
      },
    })).toMatchObject({
      data: { current_session_ended: true },
    });
  });
});
