// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from './i18n';
import { UserManagementPage } from './UserManagementPage';
import { StudioToaster } from './components/primitives';

const administratorId = '1'.repeat(32);
const invitedUserId = '2'.repeat(32);
const setupUrl = `https://studio.local/activate#token=${'3'.repeat(32)}.${'A'.repeat(43)}`;

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const administrator = {
  id: administratorId,
  email: 'owner@example.com',
  name: 'Studio Owner',
  status: 'active',
  role: 'admin',
  mfa: {
    totp_configured: true,
    webauthn_credentials: 0,
  },
  active_sessions: 1,
  author: null,
  setup: null,
  created_at_iso: '2026-07-31T00:00:00.000Z',
  updated_at_iso: '2026-07-31T00:00:00.000Z',
};

const mfaStatusResponse = {
  success: true,
  data: {
    totp: { configured_at_iso: '2026-07-31T00:00:00.000Z' },
    webauthn: {
      current_rp_id: 'studio.local',
      max_credentials: 10,
      credentials: [],
    },
    step_up: { mfa_required: false, freshness_seconds: 300 },
  },
} as const;

function userListData(
  items: readonly unknown[],
  pagination?: Partial<{
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  }>,
) {
  const counts = { pending: 0, active: 0, inactive: 0 };
  for (const item of items) {
    const status = (item as { status?: keyof typeof counts }).status;
    if (status) counts[status] += 1;
  }
  const total = pagination?.total ?? items.length;
  const perPage = pagination?.per_page ?? 50;
  return {
    items,
    pagination: {
      page: pagination?.page ?? 1,
      per_page: perPage,
      total,
      total_pages: pagination?.total_pages
        ?? (total === 0 ? 0 : Math.ceil(total / perPage)),
    },
    status_counts: {
      all: items.length,
      ...counts,
    },
    summary: {
      total: items.length,
      ...counts,
      administrators: items.filter((item) => (
        (item as { role?: string }).role === 'admin'
      )).length,
    },
  };
}

function fallbackFetch(items: readonly unknown[]) {
  return async (request: RequestInfo | URL) => {
    const path = typeof request === 'string'
      ? request
      : request instanceof Request
        ? request.url
        : request.toString();
    if (path.startsWith('/api/users?')) {
      return response({ success: true, data: userListData(items) });
    }
    if (path === '/api/auth/mfa/management/status') {
      return response(mfaStatusResponse);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('UserManagementPage', () => {
  it('creates an invitation through administrator re-confirmation and exposes the link once', async () => {
    const invitedUser = {
      ...administrator,
      id: invitedUserId,
      email: 'author@example.com',
      name: 'Site Author',
      status: 'pending',
      role: 'author',
      mfa: {
        totp_configured: false,
        webauthn_credentials: 0,
      },
      active_sessions: 0,
      setup: {
        purpose: 'invitation',
        status: 'pending',
        expires_at_iso: '2026-08-01T12:00:00.000Z',
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'invite_user',
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'invitation_created',
          user: invitedUser,
          setup_url: setupUrl,
          expires_at_iso: '2026-08-01T12:00:00.000Z',
        },
      }, 201))
      .mockImplementation(fallbackFetch([administrator, invitedUser]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const clipboardWrite = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Studio Owner')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(within(table).getByText('Studio Owner').closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByRole('button', { name: 'Actions for Studio Owner' }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');
    const overview = screen.getByLabelText('Studio user overview');
    expect(within(overview).getByText('All users').parentElement)
      .toHaveTextContent('1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/users?search=&role=all&status=all&page=1&per_page=50',
    );
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Invite a Studio user',
    });
    await user.type(within(dialog).getByLabelText('Display name'), 'Site Author');
    await user.type(within(dialog).getByLabelText('Email address'), 'author@example.com');
    await user.type(within(dialog).getByLabelText(/Your current password/), 'administrator password');
    await user.click(within(dialog).getByRole('button', {
      name: 'Create setup link',
    }));

    const result = await screen.findByRole('dialog', {
      name: 'Setup link created',
    });
    expect(within(result).getByRole('textbox', {
      name: 'One-time setup URL',
    })).toHaveValue(setupUrl);
    await user.click(within(result).getByRole('button', { name: 'Copy link' }));
    expect(clipboardWrite).toHaveBeenCalledWith(setupUrl);
    expect(await screen.findByText('Site Author')).toBeInTheDocument();

    const authorizeBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(authorizeBody).toMatchObject({
      operation: 'invite_user',
      password: 'administrator password',
    });
    const inviteBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);
    expect(inviteBody.management_token).toBe('m'.repeat(64));
  });

  it('edits the private Studio display name through a dedicated confirmation', async () => {
    const renamedAdministrator = {
      ...administrator,
      name: 'Editorial Owner',
      updated_at_iso: '2026-07-31T12:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'change_user_name',
          target_id: administratorId,
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'user_name_updated',
          user: renamedAdministrator,
          revoked_sessions: 0,
          current_session_ended: false,
        },
      }))
      .mockImplementation(fallbackFetch([renamedAdministrator]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const onCurrentUserNameChanged = vi.fn();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
          onCurrentUserNameChanged={onCurrentUserNameChanged}
        />
      </MemoryRouter>,
    );

    const ownerRow = await screen.findByRole('row', { name: /Studio Owner/u });
    await user.click(within(ownerRow).getByRole('button', {
      name: 'Actions for Studio Owner',
    }));
    await user.click(screen.getByRole('menuitem', {
      name: 'Edit display name',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Edit the display name for Studio Owner',
    });
    const nameInput = within(dialog).getByLabelText('Display name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Editorial Owner');
    await user.type(
      within(dialog).getByLabelText(/Your current password/u),
      'administrator password',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Save display name',
    }));

    expect(await screen.findByText(/display name is now Editorial Owner/u))
      .toBeInTheDocument();
    expect(onCurrentUserNameChanged).toHaveBeenCalledWith('Editorial Owner');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toMatchObject({
      operation: 'change_user_name',
      target_id: administratorId,
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({
      user_id: administratorId,
      name: 'Editorial Owner',
      expected_updated_at_iso: administrator.updated_at_iso,
      management_token: 'm'.repeat(64),
    });
  });

  it('moves role and status selection out of the user table', async () => {
    const activeAuthor = {
      ...administrator,
      id: invitedUserId,
      email: 'author@example.com',
      name: 'Site Author',
      role: 'author',
      active_sessions: 2,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator, activeAuthor]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockImplementation(fallbackFetch([administrator, activeAuthor]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const authorRow = await screen.findByRole('row', { name: /Site Author/u });
    expect(within(authorRow).queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(within(authorRow).getByRole('button', {
      name: 'Actions for Site Author',
    }));
    await user.click(screen.getByRole('menuitem', { name: 'Change role' }));
    const roleDialog = screen.getByRole('dialog', {
      name: 'Change Site Author to Author?',
    });
    expect(within(roleDialog).getByText('2', { selector: 'dd' }))
      .toBeInTheDocument();
    await user.selectOptions(within(roleDialog).getByLabelText('New role'), 'editor');
    expect(screen.getByRole('dialog', {
      name: 'Change Site Author to Editor?',
    })).toBeInTheDocument();
    await user.click(within(roleDialog).getByRole('button', { name: 'Cancel' }));

    await user.click(within(authorRow).getByRole('button', {
      name: 'Actions for Site Author',
    }));
    await user.click(screen.getByRole('menuitem', { name: 'Deactivate' }));
    const statusDialog = screen.getByRole('dialog', {
      name: 'Deactivate Site Author?',
    });
    expect(within(statusDialog).getByText('Active', { selector: 'dd' }))
      .toBeInTheDocument();
    expect(within(statusDialog).getByText('Inactive', { selector: 'dd' }))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submits server-side discovery filters and uses bounded pagination', async () => {
    const author = {
      ...administrator,
      id: invitedUserId,
      email: 'writer@example.com',
      name: 'Editorial Writer',
      role: 'author',
    };
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const path = typeof request === 'string'
        ? request
        : request instanceof Request
          ? request.url
          : request.toString();
      if (path === '/api/auth/mfa/management/status') {
        return response(mfaStatusResponse);
      }
      if (path.startsWith('/api/users?')) {
        const query = new URL(path, 'https://studio.local').searchParams;
        const page = Number(query.get('page') ?? '1');
        return response({
          success: true,
          data: {
            ...userListData([author], {
              page,
              total: 51,
              total_pages: 2,
            }),
            status_counts: {
              all: 72,
              pending: 51,
              active: 20,
              inactive: 1,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Editorial Writer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pending\s*51/u }))
      .toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Role'), 'author');
    await user.click(screen.getByRole('button', { name: /Pending\s*51/u }));
    await user.type(screen.getByLabelText('Search users'), 'writer');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/users?search=writer&role=author&status=pending&page=1&per_page=50',
        expect.objectContaining({ method: 'GET' }),
      );
    });
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/users?search=writer&role=author&status=pending&page=2&per_page=50',
        expect.objectContaining({ method: 'GET' }),
      );
    });
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('resets another user access and distinguishes the recovery bearer', async () => {
    const activeAuthor = {
      ...administrator,
      id: invitedUserId,
      email: 'author@example.com',
      name: 'Site Author',
      role: 'author',
      active_sessions: 2,
      author: {
        id: 'Site-Author',
        display_name: 'Site Author',
      },
    };
    const resetAuthor = {
      ...activeAuthor,
      status: 'pending',
      mfa: {
        totp_configured: false,
        webauthn_credentials: 0,
      },
      active_sessions: 0,
      setup: {
        purpose: 'credential_recovery',
        status: 'pending',
        expires_at_iso: '2026-07-31T13:00:00.000Z',
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator, activeAuthor]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'reset_user_access',
          target_id: invitedUserId,
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'credential_recovery_created',
          user: resetAuthor,
          setup_url: setupUrl,
          expires_at_iso: '2026-07-31T13:00:00.000Z',
        },
      }))
      .mockImplementation(fallbackFetch([administrator, resetAuthor]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Site Author')).toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: 'Public Author: Site Author',
    })).toHaveAttribute('href', '/posts?author_id=Site-Author');
    const authorRow = screen.getByRole('row', { name: /Site Author/u });
    expect(within(authorRow).queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(within(authorRow).getByRole('button', {
      name: 'Actions for Site Author',
    }));
    await user.click(screen.getByRole('menuitem', {
      name: 'Reset account access',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Reset access for Site Author?',
    });
    expect(within(dialog).getByText(/Every session, authenticator/))
      .toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/Your current password/),
      'administrator password',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Reset access and create link',
    }));

    const result = await screen.findByRole('dialog', {
      name: 'Account recovery link created',
    });
    expect(within(result).getByText(/expires in one hour/))
      .toBeInTheDocument();
    expect(within(result).getByRole('textbox', {
      name: 'One-time setup URL',
    })).toHaveValue(setupUrl);
    const authorizeBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(authorizeBody).toMatchObject({
      operation: 'reset_user_access',
      target_id: invitedUserId,
    });
    const resetBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);
    expect(resetBody).toEqual({
      user_id: invitedUserId,
      management_token: 'm'.repeat(64),
    });
  });

  it('previews impact before cancelling an unaccepted invitation', async () => {
    const invitedUser = {
      ...administrator,
      id: invitedUserId,
      email: 'author@example.com',
      name: 'Invited Author',
      status: 'pending',
      role: 'author',
      mfa: {
        totp_configured: false,
        webauthn_credentials: 0,
      },
      active_sessions: 0,
      setup: {
        purpose: 'invitation',
        status: 'pending',
        expires_at_iso: '2026-08-01T12:00:00.000Z',
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator, invitedUser]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          operation: 'cancel_invitation',
          user: invitedUser,
          effects: {
            post_autosaves: 0,
            page_autosaves: 0,
            media_upload_intents: 1,
          },
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'cancel_user_invitation',
          target_id: invitedUserId,
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'invitation_cancelled',
          user_id: invitedUserId,
        },
      }))
      .mockImplementation(fallbackFetch([administrator]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Invited Author')).toBeInTheDocument();
    const invitedRow = screen.getByRole('row', { name: /Invited Author/u });
    await user.click(within(invitedRow).getByRole('button', {
      name: 'Actions for Invited Author',
    }));
    await user.click(screen.getByRole('menuitem', {
      name: 'Cancel invitation',
    }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Cancel the invitation for Invited Author?',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/users/deletion-impact');
    expect(within(dialog).getByText(/setup link will be permanently removed/))
      .toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Confirm the target email address'),
      invitedUser.email,
    );
    await user.type(
      within(dialog).getByLabelText(/Your current password/),
      'administrator password',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Cancel invitation permanently',
    }));

    expect(await screen.findByText(/invitation for Invited Author was cancelled/))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/users/invitations/cancel');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body as string)).toEqual({
      user_id: invitedUserId,
      confirmation_email: invitedUser.email,
      management_token: 'm'.repeat(64),
    });
  });

  it('requires impact acknowledgement before deleting an inactive account', async () => {
    const inactiveUser = {
      ...administrator,
      id: invitedUserId,
      email: 'former@example.com',
      name: 'Former Author',
      status: 'inactive',
      role: 'author',
      active_sessions: 0,
      author: {
        id: 'Former-Author',
        display_name: 'Former Author',
      },
      setup: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: userListData([administrator, inactiveUser]),
      }))
      .mockResolvedValueOnce(response(mfaStatusResponse))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          operation: 'delete_account',
          user: inactiveUser,
          effects: {
            post_autosaves: 2,
            page_autosaves: 1,
            media_upload_intents: 1,
          },
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'delete_user_account',
          target_id: invitedUserId,
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'user_account_deleted',
          user_id: invitedUserId,
        },
      }))
      .mockImplementation(fallbackFetch([administrator]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <StudioToaster />
        <UserManagementPage
          data={{
            user: { id: administratorId },
            csrf_token: 'c'.repeat(43),
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Former Author')).toBeInTheDocument();
    const formerRow = screen.getByRole('row', { name: /Former Author/u });
    await user.click(within(formerRow).getByRole('button', {
      name: 'Actions for Former Author',
    }));
    await user.click(screen.getByRole('menuitem', {
      name: 'Delete account',
    }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Permanently delete Former Author?',
    });
    expect(within(dialog).getByText(/The public Author profile and authored content will be kept/))
      .toBeInTheDocument();
    expect(within(dialog).getByText(/3 content recovery copies/))
      .toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Confirm the target email address'),
      inactiveUser.email,
    );
    await user.type(
      within(dialog).getByLabelText(/Your current password/),
      'administrator password',
    );
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', {
      name: 'Delete account permanently',
    }));

    expect(await screen.findByText(/Studio account for Former Author was permanently deleted/))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/users/delete');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body as string)).toEqual({
      user_id: invitedUserId,
      confirmation_email: inactiveUser.email,
      acknowledge_recovery_copy_deletion: true,
      management_token: 'm'.repeat(64),
    });
  });
});
