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
import { MemoryRouter, Route, Routes } from 'react-router';
import { COMMENT_SETTINGS_DEFAULTS } from '../../contracts/comment-settings';
import { GENERAL_SETTINGS_DEFAULTS } from '../../contracts/general-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { CommentSettingsPage } from './CommentSettingsPage';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00.000Z',
    last_seen_at_iso: '2026-08-01T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-01T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-08T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};
const initialDocument = {
  settings: {
    ...COMMENT_SETTINGS_DEFAULTS,
    threading: { ...COMMENT_SETTINGS_DEFAULTS.threading },
    moderation: { ...COMMENT_SETTINGS_DEFAULTS.moderation },
    auth: { ...COMMENT_SETTINGS_DEFAULTS.auth },
  },
  revision: '3'.repeat(32),
  updated_at_iso: null,
};
const generalDocument = {
  settings: {
    ...GENERAL_SETTINGS_DEFAULTS,
    url: 'https://site.example.com',
  },
  revision: '4'.repeat(32),
  updated_at_iso: null,
};
const requestSecurity = {
  status: 'valid' as const,
  revision: '5'.repeat(32),
  current_key: {
    kid: 'k_AAAAAAAAAAAAAAAAAAAAAA',
    created_at_iso: '2026-08-02T00:00:00Z',
  },
  previous_keys: { total_count: 1, active_count: 1 },
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/edge/comments']}>
      <Routes>
        <Route
          path="/settings/edge/comments"
          element={(
            <CommentSettingsPage
              data={session}
              onSessionEnded={vi.fn()}
            />
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('CommentSettingsPage', () => {
  it('keeps Comment Settings usable when General Settings needs repair', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target === '/api/settings/comments') {
        return jsonResponse({ success: true, data: initialDocument });
      }
      if (target === '/api/settings/general') {
        return jsonResponse({
          success: false,
          error: { code: 'SITE_SETTINGS_DATA_INVALID' },
        }, 500);
      }
      if (target === '/api/settings/comments/request-security') {
        return jsonResponse({ success: true, data: requestSecurity });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(await screen.findByRole('switch', { name: 'Enable comments' }))
      .toBeChecked();
    expect(screen.getByText(/You can still edit and save Comment Settings/u))
      .toBeInTheDocument();
    expect(screen.getByText(/Supabase Site URL and Redirect URLs guidance is unavailable/u))
      .toBeInTheDocument();
    expect(screen.queryByText('Comment Settings could not be loaded'))
      .not.toBeInTheDocument();
  });

  it('saves canonical runtime settings using only Studio APIs', async () => {
    const savedSettings = {
      ...initialDocument.settings,
      api_base_url: 'https://edge.example.com/api',
      per_page: 25,
      moderation: { require_approval: false },
    };
    const fetchMock = vi.fn(async (url: string | URL, request?: RequestInit) => {
      const target = String(url);
      if (target === '/api/settings/comments' && request?.method === 'PUT') {
        return jsonResponse({
          success: true,
          data: {
            settings: savedSettings,
            revision: '5'.repeat(32),
            updated_at_iso: '2026-08-02T01:00:00Z',
          },
        });
      }
      if (target === '/api/settings/comments/request-security') {
        return jsonResponse({ success: true, data: requestSecurity });
      }
      if (target === '/api/settings/comments') {
        return jsonResponse({ success: true, data: initialDocument });
      }
      if (target === '/api/settings/general') {
        return jsonResponse({ success: true, data: generalDocument });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const apiBase = await screen.findByRole('textbox', {
      name: 'ZeroPress API base URL',
    });
    expect(apiBase).toHaveClass('studio-field-input');
    expect(screen.getByText('All changes are saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset changes' }))
      .toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enable comments' }))
      .toBeChecked();
    expect(screen.getByRole('switch', { name: 'Enable threaded replies' }))
      .toBeChecked();
    const requireApproval = screen.getByRole('switch', {
      name: 'Require approval for new comments',
    });
    expect(requireApproval).toBeChecked();
    await user.click(requireApproval);
    await user.type(apiBase, 'https://edge.example.com/api/');
    const perPage = screen.getByRole('spinbutton', {
      name: 'Comments per page',
    });
    await user.clear(perPage);
    await user.type(perPage, '25');

    expect(screen.queryByRole('button', { name: 'Test connection' }))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Comment Settings saved/))
      .toBeInTheDocument();

    const updateCall = fetchMock.mock.calls.find((call) => (
      call[0] === '/api/settings/comments'
      && (call[1] as RequestInit | undefined)?.method === 'PUT'
    ));
    expect(updateCall).toBeDefined();
    expect(JSON.parse(String((updateCall?.[1] as RequestInit).body))).toEqual({
      settings: savedSettings,
      expected_revision: initialDocument.revision,
    });
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('/api/')))
      .toBe(true);
  });

  it('keeps invalid URL edits local and does not offer them to the Worker', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === '/api/settings/comments') {
        return jsonResponse({ success: true, data: initialDocument });
      }
      if (String(url) === '/api/settings/general') {
        return jsonResponse({ success: true, data: generalDocument });
      }
      if (String(url) === '/api/settings/comments/request-security') {
        return jsonResponse({ success: true, data: requestSecurity });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    const apiBase = await screen.findByRole('textbox', {
      name: 'ZeroPress API base URL',
    });
    await user.type(apiBase, 'edge/api');
    await waitFor(() => expect(apiBase).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('configures optional Supabase auth with only a public key and preserves the pair when disabled', async () => {
    let updateCount = 0;
    const fetchMock = vi.fn(async (url: string | URL, request?: RequestInit) => {
      const target = String(url);
      if (target === '/api/settings/comments' && request?.method === 'PUT') {
        updateCount += 1;
        const body = JSON.parse(String(request.body)) as {
          settings: typeof initialDocument.settings;
        };
        return jsonResponse({
          success: true,
          data: {
            settings: body.settings,
            revision: String(5 + updateCount).repeat(32),
            updated_at_iso: '2026-08-02T01:00:00Z',
          },
        });
      }
      if (target === '/api/settings/comments') {
        return jsonResponse({ success: true, data: initialDocument });
      }
      if (target === '/api/settings/comments/request-security') {
        return jsonResponse({ success: true, data: requestSecurity });
      }
      if (target === '/api/settings/general') {
        return jsonResponse({ success: true, data: generalDocument });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const authSwitch = await screen.findByRole('switch', {
      name: 'Enable optional Supabase authentication',
    });
    await user.click(authSwitch);
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();

    await user.type(screen.getByRole('textbox', {
      name: 'Supabase project URL',
    }), 'https://omzxeqzkbpagmujymfuq.supabase.co/');
    const publishableKey = screen.getByRole('textbox', {
      name: 'Supabase publishable key',
    });
    await user.type(
      publishableKey,
      'sb_secret_example-key-with-enough-length',
    );
    expect(screen.getByText(/Secret, service-role, and legacy JWT keys/))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
    await user.clear(publishableKey);
    await user.type(
      publishableKey,
      'sb_publishable_example-key-with-enough-length',
    );

    const guidance = screen.getByTestId('supabase-hosted-project-guidance');
    expect(guidance).toHaveTextContent('https://site.example.com');
    expect(guidance).toHaveTextContent('ECC (P-256)');
    expect(screen.getByRole('link', { name: 'Open URL Configuration' }))
      .toHaveAttribute(
        'href',
        'https://supabase.com/dashboard/project/omzxeqzkbpagmujymfuq/auth/url-configuration',
      );

    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(updateCount).toBe(1));
    await user.click(authSwitch);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(updateCount).toBe(2));

    const updateCalls = fetchMock.mock.calls.filter((call) => (
      call[0] === '/api/settings/comments'
      && (call[1] as RequestInit | undefined)?.method === 'PUT'
    ));
    const enabledBody = JSON.parse(String(
      (updateCalls[0]?.[1] as RequestInit).body,
    ));
    const disabledBody = JSON.parse(String(
      (updateCalls[1]?.[1] as RequestInit).body,
    ));
    expect(enabledBody.settings.auth).toEqual({
      enabled: true,
      provider: 'supabase',
      project_url: 'https://omzxeqzkbpagmujymfuq.supabase.co',
      publishable_key: 'sb_publishable_example-key-with-enough-length',
    });
    expect(disabledBody.settings.auth).toEqual({
      ...enabledBody.settings.auth,
      enabled: false,
    });
    expect(JSON.stringify(disabledBody)).not.toContain('sb_secret_');
  });

  it('rotates and recovers Comment Request Security through explicit confirmation', async () => {
    let resource = requestSecurity;
    const fetchMock = vi.fn(async (
      url: string | URL,
      _request?: RequestInit,
    ) => {
      const target = String(url);
      if (target === '/api/settings/comments/request-security/rotate') {
        resource = {
          status: 'valid',
          revision: '6'.repeat(32),
          current_key: {
            kid: 'k_BBBBBBBBBBBBBBBBBBBBBB',
            created_at_iso: '2026-08-02T01:00:00Z',
          },
          previous_keys: { total_count: 2, active_count: 2 },
        };
        return jsonResponse({ success: true, data: resource });
      }
      if (target === '/api/settings/comments/request-security/reset') {
        resource = {
          status: 'valid',
          revision: '7'.repeat(32),
          current_key: {
            kid: 'k_CCCCCCCCCCCCCCCCCCCCCC',
            created_at_iso: '2026-08-02T02:00:00Z',
          },
          previous_keys: { total_count: 0, active_count: 0 },
        };
        return jsonResponse({ success: true, data: resource });
      }
      if (target === '/api/settings/comments/request-security') {
        return jsonResponse({ success: true, data: resource });
      }
      if (target === '/api/settings/comments') {
        return jsonResponse({ success: true, data: initialDocument });
      }
      if (target === '/api/settings/general') {
        return jsonResponse({ success: true, data: generalDocument });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('k_AAAAAAAAAAAAAAAAAAAAAA'))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Rotate keyset',
    }));
    const rotateDialog = screen.getByRole('dialog', {
      name: 'Rotate the comment request keyset?',
    });
    expect(rotateDialog).toHaveTextContent('14 days');
    await user.click(within(rotateDialog).getByRole('button', {
      name: 'Rotate keyset',
    }));
    expect(await screen.findByText('k_BBBBBBBBBBBBBBBBBBBBBB'))
      .toBeInTheDocument();
    const rotateCall = fetchMock.mock.calls.find((call) => (
      call[0] === '/api/settings/comments/request-security/rotate'
    ));
    expect(JSON.parse(String((rotateCall?.[1] as RequestInit).body)))
      .toEqual({ expected_revision: requestSecurity.revision });

    await user.click(screen.getByRole('button', { name: 'Reset keyset' }));
    const resetDialog = screen.getByRole('dialog', {
      name: 'Reset the comment request keyset?',
    });
    expect(resetDialog).toHaveTextContent('immediately discards');
    await user.click(within(resetDialog).getByRole('button', {
      name: 'Reset keyset',
    }));
    expect(await screen.findByText('k_CCCCCCCCCCCCCCCCCCCCCC'))
      .toBeInTheDocument();
    expect(screen.getByText('0 active / 0 total')).toBeInTheDocument();
  });
});
