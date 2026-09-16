import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { StudioHonoEnvironment } from '../types';
import {
  capabilityForMfaManagementOperation,
  hasStudioCapability,
  requireStudioCapability,
} from './authorization';

describe('Studio authorization', () => {
  it('keeps administration privileged while editors manage taxonomy', () => {
    expect(hasStudioCapability(['admin'], 'users.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'authors.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'taxonomies.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'media.read')).toBe(true);
    expect(hasStudioCapability(['admin'], 'posts.contribute')).toBe(true);
    expect(hasStudioCapability(['admin'], 'posts.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'pages.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'menus.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'widgets.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'comments.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'forms.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'newsletters.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'newsletters.export')).toBe(true);
    expect(hasStudioCapability(['admin'], 'imports.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'settings.manage')).toBe(true);
    expect(hasStudioCapability(['admin'], 'publish.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'users.manage')).toBe(false);
    expect(hasStudioCapability(['editor'], 'authors.manage')).toBe(false);
    expect(hasStudioCapability(['editor'], 'taxonomies.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'media.read')).toBe(true);
    expect(hasStudioCapability(['editor'], 'posts.contribute')).toBe(true);
    expect(hasStudioCapability(['editor'], 'posts.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'pages.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'menus.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'widgets.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'comments.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'forms.manage')).toBe(true);
    expect(hasStudioCapability(['editor'], 'newsletters.manage')).toBe(false);
    expect(hasStudioCapability(['editor'], 'newsletters.export')).toBe(false);
    expect(hasStudioCapability(['editor'], 'imports.manage')).toBe(false);
    expect(hasStudioCapability(['editor'], 'settings.manage')).toBe(false);
    expect(hasStudioCapability(['editor'], 'publish.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'users.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'authors.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'taxonomies.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'media.read')).toBe(true);
    expect(hasStudioCapability(['author'], 'posts.contribute')).toBe(true);
    expect(hasStudioCapability(['author'], 'posts.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'pages.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'menus.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'widgets.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'comments.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'forms.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'newsletters.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'newsletters.export')).toBe(false);
    expect(hasStudioCapability(['author'], 'imports.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'settings.manage')).toBe(false);
    expect(hasStudioCapability(['author'], 'publish.manage')).toBe(false);
    expect(hasStudioCapability(['unknown'], 'users.manage')).toBe(false);
  });

  it('maps only user-management grants to the capability boundary', () => {
    expect(capabilityForMfaManagementOperation('invite_user'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('change_user_role'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('change_user_name'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('reset_user_access'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('cancel_user_invitation'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('delete_user_account'))
      .toBe('users.manage');
    expect(capabilityForMfaManagementOperation('change_password')).toBeNull();
    expect(capabilityForMfaManagementOperation('replace_totp')).toBeNull();
  });

  it('rejects an authenticated editor at the Worker boundary', async () => {
    const resolveSession = vi.fn().mockResolvedValue({
      user: { roles: ['editor'] },
    });
    const app = new Hono<StudioHonoEnvironment>();
    app.get('/', async (context) => {
      const result = await requireStudioCapability({
        context,
        capability: 'users.manage',
        resolveSession,
      });
      return result instanceof Response ? result : context.json({ ok: true });
    });
    const response = await app.request('/', {}, { DB: {} } as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
  });
});
