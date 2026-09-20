// @vitest-environment jsdom

import { StrictMode } from 'react';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationsStatusData } from '../../contracts/operations';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type { SystemStatusResponse } from '../../contracts/system';
import App from './App';
import { INITIAL_CHECKING_MIN_VISIBLE_MS } from './components/InitialCheckingGate';
import { changeLocale } from './i18n';
import { LOCALE_STORAGE_KEY } from './i18n/locale';
import { requestCurrentSession } from './lib/session-client';
import { requestSystemStatus } from './lib/system-client';

vi.mock('./lib/session-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/session-client')>();
  return {
    ...actual,
    requestCurrentSession: vi.fn(),
  };
});

vi.mock('./lib/system-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/system-client')>();
  return {
    ...actual,
    requestSystemStatus: vi.fn(),
  };
});

const operationsToken = 'operations-token-value-000000000000';

type OperationsRoute =
  | 'access'
  | 'database'
  | 'edge'
  | 'recovery'
  | 'danger';

function openOperationsRoute(route: OperationsRoute) {
  window.history.replaceState({}, '', `/system/operations/${route}`);
}

const maintenanceSystemStatus: SystemStatusResponse = {
  success: true,
  data: {
    site_mode: 'maintenance',
    database: {
      state: 'ready',
      schema_version: 1,
      target_schema_version: 1,
    },
    access: { state: 'maintenance' },
    installation_configuration: null,
    operations: { state: 'available' },
  },
};

const operationalSystemStatus: SystemStatusResponse = {
  ...maintenanceSystemStatus,
  data: {
    ...maintenanceSystemStatus.data,
    site_mode: 'operational',
    access: { state: 'operational' },
  },
};

const adminSession: CurrentSessionSuccess = {
  success: true,
  data: {
    user: {
      id: '1'.repeat(32),
      email: 'owner@example.com',
      name: 'Studio Owner',
      roles: ['admin'],
    },
    session: {
      id: '2'.repeat(32),
      created_at_iso: '2026-08-28T00:00:00.000Z',
      last_seen_at_iso: '2026-08-28T00:05:00.000Z',
      idle_expires_at_iso: '2026-08-28T12:05:00.000Z',
      absolute_expires_at_iso: '2026-09-04T00:00:00.000Z',
      network: {
        ip_address: '203.0.113.10',
        asn: null,
        as_organization: null,
        country_code: null,
      },
    },
    csrf_token: 'c'.repeat(43),
    edge_integration: { mode: 'disabled', database_state: null },
  },
};

function apiErrorResponse(code: string, status: number): Response {
  return new Response(JSON.stringify({
    success: false,
    error: { code },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withOperationsPreflight(
  authenticatedFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/auth/password/check') {
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { status: 'clear', source: 'offline' },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return authenticatedFetch(input, init);
  });
}

function statusResponse(
  mode: 'initial' | 'operational' | 'maintenance' | 'recovery' = 'operational',
  databaseState: 'uninstalled' | 'ready' | 'upgrade_required' = 'ready',
): { success: true; data: OperationsStatusData } {
  const maintenance = mode === 'maintenance';
  const ready = databaseState === 'ready';
  const upgradeRequired = databaseState === 'upgrade_required';
  return {
    success: true,
    data: {
      site_mode: mode,
      database: databaseState === 'uninstalled'
        ? {
            state: 'uninstalled',
            target_schema_version: 1,
          }
        : upgradeRequired
        ? {
            state: 'upgrade_required',
            schema_version: 1,
            target_schema_version: 2,
          }
        : {
            state: 'ready',
            schema_version: 1,
            target_schema_version: 1,
          },
      current_ip: '127.0.0.1',
      allowed_ips: ['127.0.0.1'],
      environment: [
        {
          name: 'STUDIO_SITE_MODE',
          exposure: 'value',
          expected_storage: 'plain_variable',
          configured: true,
          value: mode,
        },
        {
          name: 'STUDIO_INSTALL_TOKEN',
          exposure: 'presence',
          expected_storage: 'worker_secret',
          state: databaseState === 'uninstalled' ? 'valid' : 'missing',
        },
        {
          name: 'STUDIO_OPERATIONS_TOKEN',
          exposure: 'presence',
          expected_storage: 'worker_secret',
          state: 'valid',
        },
        {
          name: 'STUDIO_AUTH_SECRET',
          exposure: 'presence',
          expected_storage: 'worker_secret',
          state: 'valid',
        },
      ],
      bindings: {
        DB: { bound: true },
        EDGE_DB: { bound: true },
        EDGE_KV: { bound: true },
        MEDIA_BUCKET: { bound: true },
        KV: { bound: true },
        AUTH_ROUTE_RATE_LIMITER: { bound: true },
      },
      edge_integration: ready
        ? {
            mode: 'enabled',
            document: {
              settings: { mode: 'enabled' },
              effective_state: 'ready',
              pending_target_events: 0,
              revision: 'a'.repeat(32),
              updated_at_iso: '2026-08-12T00:00:00.000Z',
            },
            change_available: mode !== 'recovery',
          }
        : {
            mode: upgradeRequired ? 'enabled' : 'disabled',
            document: null,
            change_available: false,
          },
      edge_database: {
        state: 'ready',
        current_schema_version: 1,
        target_schema_version: 1,
        operation_id: null,
        next_upgrade_steps: [],
        install_available: false,
        adopt_available: false,
        upgrade_available: false,
      },
      edge_target_reconciliation: {
        state: 'not_required',
        operation_id: null,
        phase: null,
        processed_posts: 0,
        processed_pages: 0,
        scanned_edge_targets: 0,
        orphan_targets: 0,
        orphan_comments: 0,
        available: maintenance,
      },
      content_search_index: {
        state: ready ? 'ready' : 'unavailable',
        reason: null,
        phase: null,
        operation_id: null,
        post_public_id_cursor: 0,
        page_public_id_cursor: 0,
        processed_posts: 0,
        processed_pages: 0,
        total_posts: 0,
        total_pages: 0,
        available: ready && (maintenance || mode === 'recovery'),
      },
      cloudflare_access: {
        state: 'disabled',
        disable_available: false,
        confirmation: 'DISABLE CLOUDFLARE ACCESS',
      },
      actions: {
        clear_site_content: {
          available: ready,
          requires_maintenance: false,
          confirmation: 'CLEAR SITE CONTENT',
        },
        reset_studio: {
          available: maintenance && ready,
          requires_maintenance: true,
          confirmation: 'RESET STUDIO',
        },
        uninstall_studio: {
          available: maintenance && ready,
          requires_maintenance: true,
          confirmation: 'UNINSTALL STUDIO',
        },
        recover_administrator: {
          available: mode === 'recovery',
          requires_maintenance: false,
          confirmation: 'RECOVER ADMINISTRATOR',
        },
      },
      database_transfer: {
        requires_administrator_credentials:
          maintenance || (mode === 'operational' && ready),
        export_modes: [
          'structure_and_data',
          'structure_only',
          'data_only',
        ],
        restore_modes: ['structure_and_data', 'data_only'],
        restore_confirmation: 'RESTORE DATABASE',
        databases: {
          studio: {
            bound: true,
            export_available:
              (maintenance && databaseState !== 'uninstalled')
              || mode === 'recovery',
            restore_available: (maintenance && ready) || mode === 'recovery',
          },
          edge: {
            bound: true,
            export_available:
              (maintenance && databaseState !== 'uninstalled')
              || mode === 'recovery'
              || (mode === 'operational' && ready),
            restore_available: (maintenance && ready) || mode === 'recovery',
          },
        },
      },
      database_upgrade: databaseState === 'uninstalled'
        ? {
            state: 'unavailable',
            current_schema_version: null,
            target_schema_version: 1,
            available: false,
            operation_id: null,
            steps: [],
            confirmation: 'UPGRADE STUDIO DATABASE',
            reason: 'database_uninstalled',
          }
        : upgradeRequired
        ? {
            state: 'upgrade_required',
            current_schema_version: 1,
            target_schema_version: 2,
            available: maintenance,
            operation_id: null,
            steps: [{
              id: '001_test_upgrade',
              from_version: 1,
              to_version: 2,
              sha256: 'a'.repeat(64),
              statement_count: 1,
            }],
            confirmation: 'UPGRADE STUDIO DATABASE',
          }
        : {
            state: 'up_to_date',
            current_schema_version: 1,
            target_schema_version: 1,
            available: false,
            operation_id: null,
            steps: [],
            confirmation: 'UPGRADE STUDIO DATABASE',
          },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

beforeEach(async () => {
  localStorage.clear();
  window.history.replaceState({}, '', '/system/operations');
  vi.mocked(requestSystemStatus).mockReset();
  vi.mocked(requestSystemStatus).mockResolvedValue(maintenanceSystemStatus);
  vi.mocked(requestCurrentSession).mockReset();
  vi.mocked(requestCurrentSession).mockResolvedValue({
    success: false,
    error: { code: 'AUTHENTICATION_REQUIRED' },
  });
  await changeLocale('en');
});

describe('Maintenance and Recovery dashboard', () => {
  it.each(['initial', 'operational', 'maintenance', 'recovery'] as const)(
    'hides the token and Studio login immediately when entry is not found in %s',
    async (mode) => {
      openOperationsRoute('edge');
      vi.mocked(requestSystemStatus).mockResolvedValue({
        ...maintenanceSystemStatus,
        data: {
          ...maintenanceSystemStatus.data,
          site_mode: mode,
          access: { state: mode === 'initial' ? 'installation' : mode },
          operations: { state: 'not_found' },
        },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Page not found' }))
        .toBeInTheDocument();
      expect(screen.queryByLabelText('Operations token')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(requestCurrentSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/system/operations/edge');
    },
  );

  it('shows setup guidance before accepting a token and retries public discovery', async () => {
    vi.mocked(requestSystemStatus).mockResolvedValueOnce({
      ...maintenanceSystemStatus,
      data: {
        ...maintenanceSystemStatus.data,
        operations: {
          state: 'setup_required',
          configuration: { allowed_ips: 'valid', token: 'missing' },
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'Set up Operations access',
    })).toBeInTheDocument();
    expect(screen.queryByLabelText('Operations token')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'STUDIO_OPERATIONS_TOKEN' }))
      .toHaveTextContent('Not set');
    await user.click(screen.getByRole('button', { name: 'Check configuration again' }));
    expect(await screen.findByLabelText('Operations token', {}, {
      timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500,
    })).toBeInTheDocument();
    expect(requestSystemStatus).toHaveBeenCalledTimes(2);
    expect(requestCurrentSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows server-authorized operational setup and hides it when the session ends', async () => {
    vi.mocked(requestSystemStatus)
      .mockResolvedValueOnce({
        ...operationalSystemStatus,
        data: {
          ...operationalSystemStatus.data,
          operations: {
            state: 'setup_required',
            configuration: { allowed_ips: 'missing', token: 'missing', client_ip: '203.0.113.10' },
          },
        },
      })
      .mockResolvedValue({
        ...operationalSystemStatus,
        data: { ...operationalSystemStatus.data, operations: { state: 'not_found' } },
      });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Set up Operations access' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check configuration again' }));
    expect(await screen.findByRole('heading', { name: 'Page not found' }, {
      timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500,
    })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Current connection IP')).not.toBeInTheDocument();
    expect(requestCurrentSession).not.toHaveBeenCalled();
  });

  it('hosts IP copy feedback, refreshes the IP on public retry, and removes it when denied', async () => {
    const setupResponse = (client_ip: string): SystemStatusResponse => ({
      ...maintenanceSystemStatus,
      data: {
        ...maintenanceSystemStatus.data,
        operations: {
          state: 'setup_required',
          configuration: { allowed_ips: 'missing', token: 'valid', client_ip },
        },
      },
    });
    vi.mocked(requestSystemStatus)
      .mockResolvedValueOnce(setupResponse('203.0.113.10'))
      .mockResolvedValueOnce(setupResponse('2001:db8::2'))
      .mockResolvedValue({
        ...maintenanceSystemStatus,
        data: { ...maintenanceSystemStatus.data, operations: { state: 'not_found' } },
      });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByLabelText('Current connection IP')).toHaveValue('203.0.113.10');
    await user.click(screen.getByRole('button', { name: 'Copy IP address' }));
    await waitFor(() => {
      expect(screen.getByText('The current connection IP was copied.')).toBeVisible();
    });
    expect(screen.getAllByRole('region', { name: 'Notifications alt+T' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Check configuration again' }));
    expect(screen.queryByLabelText('Current connection IP')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Current connection IP', {}, {
      timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500,
    })).toHaveValue('2001:db8::2');
    expect(screen.queryByText('The current connection IP was copied.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check configuration again' }));
    expect(await screen.findByRole('heading', { name: 'Page not found' }, {
      timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500,
    })).toBeInTheDocument();
    expect(screen.queryByLabelText('Current connection IP')).not.toBeInTheDocument();
    expect(requestSystemStatus).toHaveBeenCalledTimes(3);
    expect(requestCurrentSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not request protected status before the token is submitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      statusResponse('maintenance'),
    ), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    const tokenInput = await screen.findByLabelText('Operations token');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(tokenInput, operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByText('Worker configuration status'))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/system/operations/status',
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${operationsToken}`);
  });

  it('reveals checking after two seconds while public status is pending', async () => {
    vi.useFakeTimers();
    let resolveSystemStatus:
      | ((response: SystemStatusResponse) => void)
      | undefined;
    vi.mocked(requestSystemStatus).mockReturnValue(new Promise((resolve) => {
      resolveSystemStatus = resolve;
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(screen.queryByRole('main')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('heading', { name: 'Getting Studio ready' }))
      .toBeInTheDocument();

    await act(async () => {
      resolveSystemStatus?.(maintenanceSystemStatus);
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS);
    });
    expect(screen.getByLabelText('Operations token'))
      .toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not duplicate the public entry check during Strict Mode replay', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(await screen.findByLabelText('Operations token'))
      .toBeInTheDocument();
    expect(requestSystemStatus).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '한글운영토큰'.repeat(8),
    'short',
    'a token containing spaces'.repeat(2),
  ])('rejects an invalid token format locally with product copy (%#)', async (token) => {
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'INVALID_OPERATIONS_TOKEN',
      401,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const tokenInput = await screen.findByLabelText('Operations token');
    await user.type(tokenInput, token);
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check the Operations token and try again.',
    );
    expect(screen.getByLabelText('Operations token')).toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'Retry availability check',
    })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('presents the Operations entry instructions and appearance control', async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'INVALID_OPERATIONS_TOKEN',
      401,
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      level: 2,
      name: 'Maintenance & Recovery',
    })).toBeInTheDocument();
    expect(screen.getByText('Get Studio running again'))
      .toBeInTheDocument();
    expect(await screen.findByText(
      'Enter the Operations token configured for this Studio.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use dark appearance' }))
      .toBeInTheDocument();
  });

  it('keeps infrastructure settings behind the token boundary when protected tools are disabled', async () => {
    openOperationsRoute('access');
    vi.mocked(requestSystemStatus)
      .mockResolvedValueOnce(operationalSystemStatus)
      .mockResolvedValue({
        ...operationalSystemStatus,
        data: {
          ...operationalSystemStatus.data,
          operations: {
            state: 'setup_required',
            configuration: { allowed_ips: 'missing', token: 'valid', client_ip: '203.0.113.10' },
          },
        },
      });
    vi.mocked(requestCurrentSession).mockResolvedValue(adminSession);
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'NOT_FOUND',
      404,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    const accessRegion = await screen.findByRole('region', {
      name: 'Unlock Studio operations',
    });
    expect(accessRegion).toHaveClass('auth-frame', 'auth-frame-login');
    expect(accessRegion.parentElement)
      .toHaveClass('auth-shell', 'auth-shell-login');
    expect(within(accessRegion).getByRole('heading', {
      level: 1,
      name: 'Get Studio running again',
    })).toBeInTheDocument();
    expect(within(accessRegion).getByRole('heading', {
      level: 2,
      name: 'Studio operations',
    })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Studio access' }))
      .not.toBeInTheDocument();
    expect(screen.getByText(
      'Enter the Operations token to open Studio access settings and protected tools.',
    ))
      .toBeInTheDocument();
    const tokenInput = screen.getByLabelText('Operations token');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(tokenInput, operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Studio operations',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Set up Operations access',
    }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
    expect(requestCurrentSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('Authorization')).toBe(`Bearer ${operationsToken}`);
  });

  it('shows Studio access only after the Operations token is verified', async () => {
    openOperationsRoute('access');
    vi.mocked(requestSystemStatus).mockResolvedValue(
      operationalSystemStatus,
    );
    vi.mocked(requestCurrentSession).mockResolvedValue(adminSession);
    const accessDocument = {
      settings: {
        mode: 'disabled' as const,
        issuer: null,
        audience: null,
        bound_origin: null,
        verified_at_iso: null,
      },
      revision: '1'.repeat(32),
      updated_at_iso: null,
      detection_state: 'not_detected' as const,
      detected: null,
    };
    const authenticatedFetch = vi.fn((path: RequestInfo | URL) => {
      const payload = String(path)
        === '/api/system/operations/cloudflare-access'
        ? { success: true, data: accessDocument }
        : statusResponse('operational');
      return Promise.resolve(new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const fetchMock = withOperationsPreflight(authenticatedFetch);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByLabelText('Operations token'))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Studio access' }))
      .not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => (
      String(path) === '/api/system/operations/cloudflare-access'
    ))).toBe(false);

    await user.type(screen.getByLabelText('Operations token'), operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Studio operations',
    }));

    expect(await screen.findByRole('heading', { name: 'Studio access' }))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe('/system/operations/access');
    const accessCall = fetchMock.mock.calls.find(([path]) => (
      String(path) === '/api/system/operations/cloudflare-access'
    ));
    expect(accessCall).toBeDefined();
    expect(new Headers(accessCall?.[1]?.headers).get('Authorization'))
      .toBe(`Bearer ${operationsToken}`);
  });

  it('uses the normal sign-in journey before opening operational controls', async () => {
    openOperationsRoute('access');
    vi.mocked(requestSystemStatus).mockResolvedValue(
      operationalSystemStatus,
    );
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'AUTHENTICATION_REQUIRED',
      401,
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      level: 2,
      name: 'Sign in to Studio',
    })).toBeInTheDocument();
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
  });

  it('rejects an operational session without administrator capabilities', async () => {
    openOperationsRoute('access');
    vi.mocked(requestSystemStatus).mockResolvedValue(
      operationalSystemStatus,
    );
    vi.mocked(requestCurrentSession).mockResolvedValue({
      ...adminSession,
      data: {
        ...adminSession.data,
        user: {
          ...adminSession.data.user,
          roles: ['editor'],
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(apiErrorResponse(
      'FORBIDDEN',
      403,
    )));

    render(<App />);

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Administrator access is required',
    })).toBeInTheDocument();
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
  });

  it('rechecks the boundary when it becomes unavailable after entry discovery', async () => {
    vi.mocked(requestSystemStatus)
      .mockResolvedValueOnce(maintenanceSystemStatus)
      .mockResolvedValue({
        ...maintenanceSystemStatus,
        data: { ...maintenanceSystemStatus.data, operations: { state: 'not_found' } },
      });
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'NOT_FOUND',
      404,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const tokenInput = await screen.findByLabelText('Operations token');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(tokenInput, operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Page not found',
    }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByRole('region', {
      name: 'Page not found',
    })).toHaveClass('standalone-status');
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Return to Dashboard' }))
      .not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/system/operations');
  });

  it('keeps configuration failures visible and retries only public entry requirements', async () => {
    vi.mocked(requestSystemStatus)
      .mockResolvedValueOnce(maintenanceSystemStatus)
      .mockResolvedValueOnce({
        ...maintenanceSystemStatus,
        data: {
          ...maintenanceSystemStatus.data,
          operations: { state: 'setup_required', configuration: { allowed_ips: 'valid', token: 'invalid' } },
        },
      });
    const fetchMock = vi.fn().mockResolvedValue(apiErrorResponse(
      'OPERATIONS_CONFIGURATION_ERROR',
      503,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const tokenInput = await screen.findByLabelText('Operations token');
    await user.type(tokenInput, operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByRole('heading', { name: 'Set up Operations access' }, {
      timeout: 2_000,
    })).toBeInTheDocument();
    expect(screen.getByRole('region', {
      name: 'Set up Operations access',
    })).toHaveClass('standalone-status');
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Check configuration again',
    }));
    expect(await screen.findByLabelText(
      'Operations token',
      undefined,
      { timeout: 2_000 },
    ))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('Authorization')).toBe(`Bearer ${operationsToken}`);
    expect(requestSystemStatus).toHaveBeenCalledTimes(3);
  });

  it('shows retryable diagnostics for rate limiting and network failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiErrorResponse('RATE_LIMIT_EXCEEDED', 429))
      .mockRejectedValueOnce(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const tokenInput = await screen.findByLabelText('Operations token');
    await user.type(tokenInput, operationsToken);
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many failed Operations authentication attempts. Wait before trying again.',
    );
    await user.click(screen.getByRole('button', {
      name: 'Retry availability check',
    }));
    await user.click(await screen.findByRole(
      'button',
      { name: 'Open Maintenance & Recovery' },
      { timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500 },
    ));
    expect(await screen.findByRole(
      'alert',
      undefined,
      { timeout: 2_000 },
    )).toHaveTextContent('The operations service could not be reached.');
    expect(screen.queryByLabelText('Operations token'))
      .not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('Authorization'))
        .toBe(`Bearer ${operationsToken}`);
    }
  });

  it('uses the shared locale select before and after unlocking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      statusResponse(),
    ), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    const lockedLocale = await screen.findByRole('combobox', {
      name: 'Interface language',
    }) as HTMLSelectElement;
    expect(screen.queryByText('STUDIO_OPERATIONS_TOKEN'))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/Cloudflare Secret, not a plaintext Variable/u))
      .not.toBeInTheDocument();
    expect(Array.from(lockedLocale.options).map((option) => option.value))
      .toEqual(['en', 'ko']);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    expect(await screen.findByText('Worker configuration status'))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 1,
      name: 'Operations overview',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Worker configuration status',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use dark appearance' }))
      .toBeInTheDocument();
    expect(screen.getByRole('group', {
      name: 'Environment variables and Secrets',
    }).closest('.operations-content-card')).not.toBeNull();
    const environmentTable = screen.getByRole('table', {
      name: 'Environment variables and Secrets',
    });
    expect(within(environmentTable).getByRole('columnheader', {
      name: 'Store as',
    })).toBeInTheDocument();
    const installTokenRow = within(environmentTable)
      .getByText('STUDIO_INSTALL_TOKEN')
      .closest('tr');
    expect(installTokenRow).not.toBeNull();
    expect(within(installTokenRow!).getByText('not set'))
      .toHaveClass('studio-pill-positive');
    expect(within(installTokenRow!).getByText('Secret'))
      .toBeInTheDocument();
    const authSecretRow = within(environmentTable)
      .getByText('STUDIO_AUTH_SECRET')
      .closest('tr');
    expect(authSecretRow).not.toBeNull();
    expect(within(authSecretRow!).getByText('set'))
      .toHaveClass('studio-pill-positive');
    const siteModeRow = within(environmentTable)
      .getByText('STUDIO_SITE_MODE')
      .closest('tr');
    expect(siteModeRow).not.toBeNull();
    expect(within(siteModeRow!).getByText('Plain variable'))
      .toBeInTheDocument();
    expect(within(environmentTable).queryByText('DB'))
      .not.toBeInTheDocument();
    expect(within(environmentTable).queryByText('Binding'))
      .not.toBeInTheDocument();
    const summary = screen.getByLabelText('System operation status');
    expect(within(summary).getByText('Operational'))
      .toHaveClass('studio-pill-positive');
    expect(within(summary).getByText('Ready'))
      .toHaveClass('studio-pill-positive');

    const dashboardLocale = screen.getByRole('combobox', {
      name: 'Interface language',
    }) as HTMLSelectElement;
    const lockButton = screen.getByRole('button', { name: 'Lock screen' });
    expect(dashboardLocale.closest('.studio-chrome-select')).not.toBeNull();
    expect(Array.from(dashboardLocale.options).map((option) => option.value))
      .toEqual(['en', 'ko']);
    expect(dashboardLocale).toHaveValue('en');
    expect(lockButton).toHaveAttribute('title', 'Lock screen');

    await user.selectOptions(dashboardLocale, 'ko');
    expect(await screen.findByText('Worker 설정 상태')).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko');
    expect(screen.getByRole('combobox', {
      name: '인터페이스 언어',
    })).toHaveValue('ko');

    await user.click(screen.getByRole('button', { name: '화면 잠그기' }));
    expect(screen.getByLabelText('Operations 토큰')).toHaveValue('');
    expect(screen.getByRole('combobox', {
      name: '인터페이스 언어',
    })).toHaveValue('ko');
    expect(screen.queryByText('최종 환경 설정')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/system/operations/status',
    );
  });

  it('locks and rechecks availability when a BFCache page is restored', async () => {
    const authenticatedFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(statusResponse('maintenance')),
      { headers: { 'Content-Type': 'application/json' } },
    ));
    const fetchMock = withOperationsPreflight(authenticatedFetch);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    expect(await screen.findByText('Worker configuration status')).toBeInTheDocument();

    const pageHide = new Event('pagehide');
    Object.defineProperty(pageHide, 'persisted', { value: true });
    await act(async () => {
      window.dispatchEvent(pageHide);
    });
    expect(await screen.findByLabelText('Operations token')).toHaveValue('');
    expect(screen.queryByText('Worker configuration status')).not.toBeInTheDocument();

    const pageShow = new Event('pageshow');
    Object.defineProperty(pageShow, 'persisted', { value: true });
    await act(async () => {
      window.dispatchEvent(pageShow);
    });
    expect(await screen.findByLabelText(
      'Operations token',
      {},
      { timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500 },
    )).toHaveValue('');
    expect(screen.queryByText('Worker configuration status')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
    expect(requestSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a retained install token from an invalid auth secret', async () => {
    const payload = statusResponse('maintenance');
    payload.data.environment = payload.data.environment.map((entry) => (
      entry.exposure === 'presence'
      && entry.name === 'STUDIO_INSTALL_TOKEN'
        ? { ...entry, state: 'must_be_removed' as const }
        : entry.exposure === 'presence'
          && entry.name === 'STUDIO_AUTH_SECRET'
        ? { ...entry, state: 'invalid' as const }
        : entry
    ));
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(payload),
      { headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    const environmentTable = await screen.findByRole('table', {
      name: 'Environment variables and Secrets',
    });
    const installTokenRow = within(environmentTable)
      .getByText('STUDIO_INSTALL_TOKEN')
      .closest('tr');
    expect(installTokenRow).not.toBeNull();
    expect(within(installTokenRow!).getByText('must be removed'))
      .toHaveClass('studio-pill-critical');

    const authSecretRow = within(environmentTable)
      .getByText('STUDIO_AUTH_SECRET')
      .closest('tr');
    expect(authSecretRow).not.toBeNull();
    expect(within(authSecretRow!).getByText('invalid'))
      .toHaveClass('studio-pill-critical');
  });

  it('keeps the token in memory and executes clear-content with explicit credentials', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'clear_site_content',
          status: 'completed',
          effects: {
            deleted_rows: {
              posts: 5,
              pages: 2,
              menus: 1,
              'EDGE_DB.comments': 3,
              'EDGE_DB.edge_comment_targets': 2,
            },
            inserted_rows: {},
            updated_rows: {},
          },
          resources: { studio: 'completed', edge: 'completed' },
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByLabelText('Operations token'))
      .toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Danger zone',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear content' }))
      .toBeEnabled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: `Bearer ${operationsToken}`,
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Clear content' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('CLEAR SITE CONTENT')).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Administrator email'),
      'owner@example.com',
    );
    await user.type(
      within(dialog).getByLabelText('Administrator password'),
      'administrator-password',
    );
    await user.type(
      within(dialog).getByLabelText(/Type the exact confirmation phrase/),
      'CLEAR SITE CONTENT',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      within(dialog).getByRole('heading', { name: 'Final confirmation' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Clear site content has not started. Confirm once more to execute it.',
      ),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm and execute' }),
    );

    expect(
      await within(dialog).findByText(
        'Clear site content completed. 13 affected rows were reported.',
      ),
    ).toBeInTheDocument();
    const clearReport = within(dialog).getByLabelText(
      'Deleted row report',
    ) as HTMLTextAreaElement;
    expect(clearReport.value).toMatch(/^EDGE_DB\.comments\s+3$/mu);
    expect(clearReport.value).toMatch(
      /^EDGE_DB\.edge_comment_targets\s+2$/mu,
    );
    expect(clearReport.value).toMatch(/^TOTAL\s+13$/mu);
    expect(
      within(dialog).getByRole('heading', { name: 'Operation completed' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const operationCall = fetchMock.mock.calls[1];
    expect(operationCall?.[0]).toBe(
      '/api/system/operations/clear-content',
    );
    expect(operationCall?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${operationsToken}`,
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(String(operationCall?.[1]?.body))).toEqual({
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
      confirmation: 'CLEAR SITE CONTENT',
    });
    expect(String(operationCall?.[1]?.body)).not.toContain(operationsToken);

    await user.click(
      within(dialog).getByRole('button', { name: 'Close' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Clear site content completed. 13 affected rows were reported.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear content' }));
    expect(
      within(screen.getByRole('dialog')).getByLabelText(
        'Administrator password',
      ),
    ).toHaveValue('');
  });

  it('reports reset as a restored default state instead of a deletion count', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'reset_studio',
          status: 'completed',
          effects: {
            deleted_rows: {
              site_settings: 1,
              user_roles: 1,
              roles: 1,
            },
            inserted_rows: {
              site_settings: 1,
              user_roles: 1,
              roles: 1,
            },
            updated_rows: {
              users: 1,
            },
          },
          resources: { studio: 'completed', edge: 'completed' },
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Reset Studio' }));

    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Administrator email'),
      'owner@example.com',
    );
    await user.type(
      within(dialog).getByLabelText('Administrator password'),
      'administrator-password',
    );
    await user.type(
      within(dialog).getByLabelText(/Type the exact confirmation phrase/),
      'RESET STUDIO',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm and execute' }),
    );

    expect(
      await within(dialog).findByText(
        'Studio reset completed. Default settings and permissions were reconfigured.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/affected rows/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('explains that maintenance is the planned lifecycle and upgrade boundary', async () => {
    const authenticatedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse('maintenance')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', withOperationsPreflight(authenticatedFetch));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByText(
      'Studio is paused for maintenance',
    )).toBeInTheDocument();
    expect(screen.getByText(/Backups, upgrades, reset, and uninstall are available here/))
      .toBeInTheDocument();
    const summary = screen.getByLabelText('System operation status');
    expect(summary).toHaveClass(
      'operations-overview-summary',
      'operations-summary-four-columns',
    );
    expect(within(summary).getByText('Maintenance'))
      .toHaveClass('studio-pill-attention');
    expect(within(summary).getByText('Ready'))
      .toHaveClass('studio-pill-positive');

    const navigation = screen.getByRole('navigation', {
      name: 'Operations sections',
    });
    expect(within(navigation).getAllByRole('link')).toHaveLength(6);
    await user.click(within(navigation).getByRole('link', {
      name: /^Studio database/u,
    }));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Studio database',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      name: 'Database backup & restore',
    })).toBeInTheDocument();

    await user.click(within(navigation).getByRole('link', {
      name: /^Edge services/u,
    }));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Edge services',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edge database' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Synchronize Edge targets' }))
      .toBeInTheDocument();

    await user.click(within(navigation).getByRole('link', {
      name: /^Danger zone/u,
    }));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Danger zone',
    })).toBeInTheDocument();
    expect(screen.getByRole('heading', {
      name: 'Clear, reset, or uninstall',
    })).toBeInTheDocument();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
  });

  it('directs an uninstalled Studio through initial setup without showing Studio-dependent lifecycle controls', async () => {
    const payload = statusResponse('initial', 'uninstalled');
    payload.data.edge_database = {
      state: 'uninstalled',
      current_schema_version: null,
      target_schema_version: 1,
      operation_id: null,
      next_upgrade_steps: [],
      install_available: false,
      adopt_available: false,
      upgrade_available: false,
    };
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByText('Studio is ready to install'))
      .toBeInTheDocument();
    expect(screen.getByText(/Return to the Studio home page/))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', {
      level: 1,
      name: 'Operations overview',
    })).toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      level: 2,
      name: 'Backups & search',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      level: 2,
      name: 'Recovery & maintenance',
    })).not.toBeInTheDocument();
    const summary = screen.getByLabelText('System operation status');
    expect(summary).toHaveClass('operations-overview-summary');
    expect(summary).not.toHaveClass('operations-summary-four-columns');
    expect(within(summary).queryByText('Edge integration'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Upgrade Studio database' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Edge database' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Uninstall Edge database' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      name: 'Synchronize Edge targets',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      name: 'Database backup & restore',
    })).not.toBeInTheDocument();
  });

  it('keeps the recovery-only restore path visible for an uninstalled Studio database', async () => {
    openOperationsRoute('database');
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse(
        'recovery',
        'uninstalled',
      )), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      name: 'Database backup & restore',
    })).toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      name: 'Synchronize Edge targets',
    })).not.toBeInTheDocument();
  });

  it('highlights an upgrade-required database as an attention state', async () => {
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse(
        'maintenance',
        'upgrade_required',
      )), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    const summary = await screen.findByLabelText('System operation status');
    expect(within(summary).getByText('Maintenance'))
      .toHaveClass('studio-pill-attention');
    expect(within(summary).getByText('Upgrade required'))
      .toHaveClass('studio-pill-attention');
    expect(screen.queryByRole('heading', { name: 'Clear, reset, or uninstall' }))
      .not.toBeInTheDocument();
  });

  it('shows and copies the table-level uninstall report', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'uninstall_studio',
          expected_effects: {
            deleted_rows: {
              site_settings: 1,
              user_roles: 0,
              roles: 2,
              users: 99,
              zeropress_schema_state: 1,
            },
          },
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'uninstall_studio',
          status: 'completed',
          effects: {
            deleted_rows: {
              site_settings: 1,
              user_roles: 0,
              roles: 2,
              users: 100,
              zeropress_schema_state: 1,
            },
            inserted_rows: {},
            updated_rows: {},
          },
          resources: {
            studio: 'completed',
            edge: 'not_applicable',
          },
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();
    const clipboardWrite = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Uninstall Studio' }));

    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Administrator email'),
      'owner@example.com',
    );
    await user.type(
      within(dialog).getByLabelText('Administrator password'),
      'administrator-password',
    );
    await user.type(
      within(dialog).getByLabelText(/Type the exact confirmation phrase/),
      'UNINSTALL STUDIO',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    expect(
      await within(dialog).findByText(
        'Expected result — 5 tables will be removed',
      ),
    ).toBeInTheDocument();
    const expectedReport = within(dialog).getByLabelText(
      'Expected removal report',
    ) as HTMLTextAreaElement;
    expect(expectedReport.value).toMatch(/^users\s+99$/mu);
    expect(expectedReport.value).toMatch(/^TOTAL\s+103$/mu);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/system/operations/uninstall-studio/preview',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${operationsToken}`,
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    )).toEqual({
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
      confirmation: 'UNINSTALL STUDIO',
    });

    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm and execute' }),
    );

    expect(
      await within(dialog).findByText(
        'Studio uninstall completed. 5 tables were removed.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/affected rows/)).not.toBeInTheDocument();

    const report = within(dialog).getByLabelText(
      'Removed table report',
    ) as HTMLTextAreaElement;
    const reportLines = report.value.split('\n');
    expect(report).toHaveAttribute('readonly');
    expect(reportLines.slice(1, -2).map((line) =>
      line.trim().split(/\s+/u)
    )).toEqual([
      ['site_settings', '1'],
      ['user_roles', '0'],
      ['roles', '2'],
      ['users', '100'],
      ['zeropress_schema_state', '1'],
    ]);
    expect(reportLines.at(-1)?.trim().split(/\s+/u)).toEqual([
      'TOTAL',
      '104',
    ]);

    await user.click(
      within(dialog).getByRole('button', { name: 'Copy report' }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith(report.value);
    expect(
      within(dialog).getByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('The deletion report was copied.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps uninstall blocked when the expected result cannot be loaded', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Uninstall Studio' }));

    const dialog = screen.getByRole('dialog');
    const email = within(dialog).getByLabelText('Administrator email');
    const password = within(dialog).getByLabelText('Administrator password');
    const confirmation = within(dialog).getByLabelText(
      /Type the exact confirmation phrase/,
    );
    await user.type(email, 'owner@example.com');
    await user.type(password, 'administrator-password');
    await user.type(confirmation, 'UNINSTALL STUDIO');
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    expect(
      await within(dialog).findByRole('alert'),
    ).toHaveTextContent(
      'The operation could not be completed. Review the Worker operational logs.',
    );
    expect(
      within(dialog).queryByRole('button', {
        name: 'Confirm and execute',
      }),
    ).not.toBeInTheDocument();
    expect(email).toHaveValue('owner@example.com');
    expect(password).toHaveValue('administrator-password');
    expect(confirmation).toHaveValue('UNINSTALL STUDIO');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects uninstall credentials before final confirmation and preserves retry fields', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('maintenance'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { code: 'INVALID_OPERATIONS_CREDENTIALS' },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Uninstall Studio' }));

    const dialog = screen.getByRole('dialog');
    const email = within(dialog).getByLabelText('Administrator email');
    const password = within(dialog).getByLabelText('Administrator password');
    const confirmation = within(dialog).getByLabelText(
      /Type the exact confirmation phrase/,
    );
    await user.type(email, 'owner@example.com');
    await user.type(password, 'wrong-password');
    await user.type(confirmation, 'UNINSTALL STUDIO');
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    expect(
      await within(dialog).findByRole('alert'),
    ).toHaveTextContent(
      'The administrator credentials or administrator role could not be verified.',
    );
    expect(
      within(dialog).queryByRole('heading', {
        name: 'Final confirmation',
      }),
    ).not.toBeInTheDocument();
    expect(email).toHaveValue('owner@example.com');
    expect(password).toHaveValue('wrong-password');
    expect(confirmation).toHaveValue('UNINSTALL STUDIO');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${operationsToken}`,
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    )).toEqual({
      administrator_email: 'owner@example.com',
      administrator_password: 'wrong-password',
      confirmation: 'UNINSTALL STUDIO',
    });
  });

  it('shows local request validation in the dialog and preserves retry fields', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Clear content' }));

    const dialog = screen.getByRole('dialog');
    const email = within(dialog).getByLabelText('Administrator email');
    const password = within(dialog).getByLabelText('Administrator password');
    const confirmation = within(dialog).getByLabelText(
      /Type the exact confirmation phrase/,
    );
    await user.type(email, 'a');
    await user.type(password, 'aa');
    await user.type(confirmation, 'CLEAR SITE CONTENT');
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );

    expect(
      within(dialog).getByRole('alert'),
    ).toHaveTextContent(
      'Enter a valid administrator email, password, and exact confirmation phrase.',
    );
    expect(email).toHaveValue('a');
    expect(password).toHaveValue('aa');
    expect(confirmation).toHaveValue('CLEAR SITE CONTENT');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shows rejected credentials in the dialog and keeps all retry fields', async () => {
    openOperationsRoute('danger');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { code: 'INVALID_OPERATIONS_CREDENTIALS' },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Danger zone' });
    await user.click(screen.getByRole('button', { name: 'Clear content' }));

    const dialog = screen.getByRole('dialog');
    const email = within(dialog).getByLabelText('Administrator email');
    const password = within(dialog).getByLabelText('Administrator password');
    const confirmation = within(dialog).getByLabelText(
      /Type the exact confirmation phrase/,
    );
    await user.type(email, 'owner@example.com');
    await user.type(password, 'wrong-password');
    await user.type(confirmation, 'CLEAR SITE CONTENT');
    await user.click(
      within(dialog).getByRole('button', { name: 'Execute operation' }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm and execute' }),
    );

    expect(
      await within(dialog).findByRole('alert'),
    ).toHaveTextContent(
      'The administrator credentials or administrator role could not be verified.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(email).toHaveValue('owner@example.com');
    expect(password).toHaveValue('wrong-password');
    expect(confirmation).toHaveValue('CLEAR SITE CONTENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear content' }));
    const reopenedDialog = screen.getByRole('dialog');
    expect(
      within(reopenedDialog).getByLabelText('Administrator email'),
    ).toHaveValue('owner@example.com');
    expect(
      within(reopenedDialog).getByLabelText('Administrator password'),
    ).toHaveValue('');
    expect(
      within(reopenedDialog).getByLabelText(
        /Type the exact confirmation phrase/,
      ),
    ).toHaveValue('');
  });

  it('shows only the operationally available content reset outside maintenance mode', async () => {
    openOperationsRoute('danger');
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse('operational')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Danger zone',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear content' }))
      .toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Reset Studio' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Uninstall Studio' }))
      .not.toBeInTheDocument();
  });

  it('offers Edge backup without restore controls in operational mode', async () => {
    openOperationsRoute('database');
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse('operational')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Database backup & restore',
    })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Edge DB' })).toBeEnabled();
    expect(screen.queryByRole('option', { name: 'Studio DB' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Restore database backup' }))
      .not.toBeInTheDocument();
  });

  it('offers only the Edge upgrade lifecycle action in operational mode', async () => {
    openOperationsRoute('edge');
    const payload = statusResponse('operational');
    payload.data.edge_database = {
      state: 'upgrade_required',
      current_schema_version: 1,
      target_schema_version: 1,
      operation_id: null,
      next_upgrade_steps: [],
      install_available: false,
      adopt_available: false,
      upgrade_available: true,
    };
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Edge database',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade Edge database' }))
      .toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Uninstall Edge database' }))
      .not.toBeInTheDocument();
  });

  it('shows required Edge reconciliation as read-only with maintenance prerequisites in operational mode', async () => {
    openOperationsRoute('edge');
    const payload = statusResponse('operational');
    payload.data.edge_target_reconciliation = {
      ...payload.data.edge_target_reconciliation,
      state: 'required',
      available: false,
    };
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      name: 'Synchronize Edge targets',
    })).toBeInTheDocument();
    expect(screen.getByText('Maintenance mode is required'))
      .toBeInTheDocument();
    expect(screen.getByText(/Set STUDIO_SITE_MODE to maintenance/))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start reconciliation' }))
      .not.toBeInTheDocument();
  });

  it('does not expose active reconciliation controls outside maintenance mode', async () => {
    openOperationsRoute('edge');
    const payload = statusResponse('operational');
    payload.data.edge_target_reconciliation = {
      state: 'orphan_review',
      operation_id: 'a'.repeat(32),
      phase: 'orphan_review',
      processed_posts: 454,
      processed_pages: 9,
      scanned_edge_targets: 0,
      orphan_targets: 0,
      orphan_comments: 0,
      available: false,
    };
    const authenticatedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', withOperationsPreflight(authenticatedFetch));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByText('Maintenance mode is required'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more orphans' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalize reconciliation' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel operation' }))
      .not.toBeInTheDocument();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
  });

  it('hides destructive operations for an uninstalled database and explains reinstallation', async () => {
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(statusResponse(
        'maintenance',
        'uninstalled',
      )), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByText('Studio is not installed'))
      .toBeInTheDocument();
    expect(screen.getByText(/set STUDIO_SITE_MODE to initial/))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clear, reset, or uninstall' }))
      .not.toBeInTheDocument();
  });

  it('shows a precise EDGE_DB requirement for affected maintenance actions', async () => {
    openOperationsRoute('danger');
    const payload = statusResponse('maintenance');
    payload.data.bindings.EDGE_DB.bound = false;
    payload.data.actions.clear_site_content.available = false;
    payload.data.actions.reset_studio.available = false;
    vi.stubGlobal('fetch', withOperationsPreflight(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      name: 'Clear, reset, or uninstall',
    })).toBeInTheDocument();
    expect(screen.getAllByText(
      'A bound EDGE_DB is required for this operation.',
    )).toHaveLength(2);
    const unavailableButtons = screen.getAllByRole('button', {
      name: 'Unavailable in this state',
    });
    expect(unavailableButtons).toHaveLength(2);
    expect(unavailableButtons.every((button) => button.hasAttribute('disabled')))
      .toBe(true);
    expect(screen.getByRole('button', { name: 'Uninstall Studio' }))
      .toBeEnabled();
  });

  it('recovers an administrator without requiring the inaccessible account credentials', async () => {
    openOperationsRoute('recovery');
    const administratorId = '0123456789abcdef0123456789abcdef';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('recovery'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          mode: 'existing_administrator',
          administrators: [
            {
              id: administratorId,
              email: 'owner@example.com',
              name: 'Studio Owner',
              status: 'active',
              mfa_configured: true,
            },
          ],
          confirmation: 'RECOVER ADMINISTRATOR',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'recover_administrator',
          status: 'completed',
          mfa_reset: true,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(
      screen.getByRole('button', { name: 'Open Maintenance & Recovery' }),
    );

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Administrator recovery',
    })).toBeInTheDocument();
    expect(screen.getByText(
      'Restore an administrator’s password and authentication methods to regain access.',
    )).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', {
        name: 'Recover administrator access',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Clear, reset, or uninstall' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Administrator account')).toHaveValue(
      administratorId,
    );
    await user.type(
      screen.getByLabelText('New administrator password'),
      'harbor lantern canyon marble circuit',
    );
    await user.type(
      screen.getByLabelText('Confirm new administrator password'),
      'harbor lantern canyon marble circuit',
    );
    expect(
      screen.getByLabelText(/Reset the authenticator/),
    ).toBeChecked();
    await user.type(
      screen.getByLabelText(/Type the exact confirmation phrase/),
      'RECOVER ADMINISTRATOR',
    );
    await user.click(
      screen.getByRole('button', { name: 'Review recovery' }),
    );

    expect(
      screen.getByRole('heading', {
        name: 'Final recovery confirmation',
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await user.click(
      screen.getByRole('button', { name: 'Recover administrator' }),
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Administrator access recovered',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/must complete fresh MFA enrollment/))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const recoveryCall = fetchMock.mock.calls[2];
    expect(recoveryCall?.[0]).toBe(
      '/api/system/operations/administrator-recovery',
    );
    expect(JSON.parse(String(recoveryCall?.[1]?.body))).toEqual({
      administrator_id: administratorId,
      new_password: 'harbor lantern canyon marble circuit',
      reset_mfa: true,
      confirmation: 'RECOVER ADMINISTRATOR',
    });
    expect(String(recoveryCall?.[1]?.body)).not.toContain(
      'administrator_password',
    );
  });

  it('bootstraps one mandatory-MFA administrator when no administrator-role user remains', async () => {
    openOperationsRoute('recovery');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('recovery'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          mode: 'bootstrap_administrator',
          administrators: [],
          confirmation: 'CREATE RECOVERY ADMINISTRATOR',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          method: 'totp',
          secret: 'ABCDEFGHIJKLMNOP234567ABCDEFGHIJ',
          issuer: 'Margin · Studio',
          account_name: 'new-owner@example.com',
          otpauth_uri: 'otpauth://totp/Margin%20%C2%B7%20Studio%3Anew-owner%40example.com?secret=ABCDEFGHIJKLMNOP234567ABCDEFGHIJ&issuer=Margin%20%C2%B7%20Studio&algorithm=SHA1&digits=6&period=30',
          enrollment_token: 'a'.repeat(64),
          expires_at_iso: '2026-08-13T01:00:00.000Z',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'bootstrap_recovery_administrator',
          status: 'completed',
          mfa_enrolled: true,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByText(/No user currently has the administrator role/))
      .toBeInTheDocument();
    await user.type(
      screen.getByLabelText('New administrator name'),
      'Recovery Owner',
    );
    await user.type(
      screen.getByLabelText('New administrator email'),
      'new-owner@example.com',
    );
    await user.type(
      screen.getByLabelText('New administrator password'),
      'harbor lantern canyon marble circuit',
    );
    await user.type(
      screen.getByLabelText('Confirm new administrator password'),
      'harbor lantern canyon marble circuit',
    );
    await user.click(screen.getByLabelText(
      /I created and safely stored a current Studio DB backup/,
    ));
    await user.type(
      screen.getByLabelText(/Type the exact confirmation phrase/),
      'CREATE RECOVERY ADMINISTRATOR',
    );
    await user.click(screen.getByRole('button', {
      name: 'Continue to mandatory MFA',
    }));

    expect(await screen.findByText('new-owner@example.com'))
      .toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Current 6-digit authenticator code'),
      '123456',
    );
    await user.click(screen.getByRole('button', {
      name: 'Review administrator creation',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Final administrator creation confirmation',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Create recovery administrator',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Recovery administrator created',
    })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      '/api/system/operations/administrator-recovery/bootstrap/mfa/setup',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      administrator_email: 'new-owner@example.com',
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      '/api/system/operations/administrator-recovery/bootstrap',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      administrator_name: 'Recovery Owner',
      administrator_email: 'new-owner@example.com',
      new_password: 'harbor lantern canyon marble circuit',
      backup_acknowledged: true,
      mfa: {
        enrollment_token: 'a'.repeat(64),
        totp_code: '123456',
      },
      confirmation: 'CREATE RECOVERY ADMINISTRATOR',
    });
  });

  it('keeps the recovery panel visible when its initial account query is unavailable', async () => {
    openOperationsRoute('recovery');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        statusResponse('recovery'),
      ), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { code: 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE' },
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', withOperationsPreflight(fetchMock));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));

    expect(await screen.findByRole('heading', {
      name: 'Recover administrator access',
    })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /requires STUDIO_SITE_MODE=recovery and a ready or supported upgrade-required Studio database/,
    );
    expect(screen.queryByLabelText('Administrator account'))
      .not.toBeInTheDocument();
  });

  it('changes Studio Edge integration mode from the operations dashboard with administrator re-verification', async () => {
    openOperationsRoute('edge');
    const enabled = statusResponse('maintenance');
    const disabled = statusResponse('maintenance');
    disabled.data.edge_integration = {
      mode: 'disabled',
      document: {
        settings: { mode: 'disabled' },
        effective_state: 'disabled',
        pending_target_events: 0,
        revision: 'b'.repeat(32),
        updated_at_iso: '2026-08-12T01:00:00.000Z',
      },
      change_available: true,
    };
    let statusReads = 0;
    const authenticatedFetch = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === '/api/system/operations/status') {
        const payload = statusReads === 0 ? enabled : disabled;
        statusReads += 1;
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/system/operations/edge-integration') {
        return new Response(JSON.stringify({
          success: true,
          data: disabled.data.edge_integration.document,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return apiErrorResponse('NOT_FOUND', 404);
    });
    vi.stubGlobal('fetch', withOperationsPreflight(authenticatedFetch));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    expect(await screen.findByRole('heading', {
      name: 'Edge services connection',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Disable Studio Edge integration',
    }));
    const modeDialog = screen.getByRole('dialog');
    await user.type(within(modeDialog).getByLabelText('Administrator email'), 'owner@example.com');
    await user.type(within(modeDialog).getByLabelText('Administrator password'), 'administrator-password');
    await user.type(
      within(modeDialog).getByLabelText('Type the exact confirmation phrase:'),
      'DISABLE EDGE INTEGRATION',
    );
    await user.click(within(modeDialog).getByRole('button', {
      name: 'Apply mode change',
    }));

    expect(await screen.findByText('Studio Edge integration is disabled.'))
      .toBeInTheDocument();
    const mutation = authenticatedFetch.mock.calls.find(
      ([input]) => String(input) === '/api/system/operations/edge-integration',
    );
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({
      mode: 'disabled',
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
      expected_revision: 'a'.repeat(32),
      confirmation: 'DISABLE EDGE INTEGRATION',
    });
  });

  it('previews and reports a separate Edge database uninstall without claiming to remove Cloudflare resources', async () => {
    openOperationsRoute('edge');
    const payload = statusResponse('maintenance');
    payload.data.edge_integration = {
      mode: 'disabled',
      document: {
        settings: { mode: 'disabled' },
        effective_state: 'disabled',
        pending_target_events: 0,
        revision: 'd'.repeat(32),
        updated_at_iso: '2026-08-12T00:00:00.000Z',
      },
      change_available: true,
    };
    const deletedRows = {
      'EDGE_DB.comments': 12,
      'EDGE_DB.edge_comment_targets': 3,
      'EDGE_DB.zeropress_edge_schema_state': 1,
    };
    let uninstalled = false;
    const authenticatedFetch = vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path === '/api/system/operations/status') {
        if (uninstalled) {
          payload.data.edge_database = {
            ...payload.data.edge_database,
            state: 'uninstalled',
            current_schema_version: null,
          };
        }
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.endsWith('/edge-database/uninstall/preview')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            operation: 'uninstall_edge_database',
            expected_effects: { deleted_rows: deletedRows },
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (path.endsWith('/edge-database/uninstall')) {
        uninstalled = true;
        return new Response(JSON.stringify({
          success: true,
          data: {
            operation: 'uninstall_edge_database',
            status: 'completed',
            effects: { deleted_rows: deletedRows },
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return apiErrorResponse('NOT_FOUND', 404);
    });
    vi.stubGlobal('fetch', withOperationsPreflight(authenticatedFetch));
    const user = userEvent.setup();

    render(<App />);
    await user.type(
      await screen.findByLabelText('Operations token'),
      operationsToken,
    );
    await user.click(screen.getByRole('button', { name: 'Open Maintenance & Recovery' }));
    expect(await screen.findByText(
      /Cloudflare resources, KV, R2, queued mail, and Studio data will be kept/,
    )).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Uninstall Edge database',
    }));
    const uninstallDialog = screen.getByRole('dialog');
    await user.type(within(uninstallDialog).getByLabelText('Administrator email'), 'owner@example.com');
    await user.type(within(uninstallDialog).getByLabelText('Administrator password'), 'administrator-password');
    await user.click(within(uninstallDialog).getByLabelText(/created and safely stored a reviewed Edge SQL backup/));
    await user.click(within(uninstallDialog).getByLabelText(/EDGE_MAINTENANCE_MODE=true/));
    await user.click(within(uninstallDialog).getByLabelText(/queued mail work is separate/));
    await user.type(
      within(uninstallDialog).getByLabelText('Type the exact confirmation phrase:'),
      'UNINSTALL EDGE DATABASE',
    );
    await user.click(within(uninstallDialog).getByRole('button', {
      name: 'Review expected result',
    }));

    expect(await screen.findByDisplayValue(/EDGE_DB\.comments\s+12/))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Confirm and uninstall Edge database',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Edge database uninstall completed',
    }))
      .toBeInTheDocument();
    expect(screen.getByDisplayValue(/EDGE_DB\.edge_comment_targets\s+3/))
      .toBeInTheDocument();
  });
});
