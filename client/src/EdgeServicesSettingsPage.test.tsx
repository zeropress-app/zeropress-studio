// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type { EdgeDatabaseRuntimeState } from '../../contracts/edge-runtime';
import { EdgeIntegrationProvider, useEdgeIntegration } from './EdgeIntegrationContext';
import { EdgeServicesSettingsPage } from './EdgeServicesSettingsPage';
import { changeLocale } from './i18n';

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
  edge_integration: { mode: 'disabled', database_state: null },
};

const disabledDocument = {
  settings: { mode: 'disabled' as const },
  effective_state: 'disabled' as const,
  pending_target_events: 0,
  revision: '0'.repeat(32),
  updated_at_iso: '2026-08-01T00:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ModeProbe() {
  const { mode } = useEdgeIntegration();
  return <output aria-label="Current integration mode">{mode}</output>;
}

const onSessionEnded = vi.fn();

function TestPage() {
  const [mode, setMode] = useState<'enabled' | 'disabled'>('disabled');
  const [databaseState, setDatabaseState] = useState<EdgeDatabaseRuntimeState>('ready');
  return (
    <EdgeIntegrationProvider value={{
      mode,
      databaseState,
      setMode,
      setDatabaseState,
    }}>
      <ModeProbe />
      <EdgeServicesSettingsPage data={session} onSessionEnded={onSessionEnded} />
    </EdgeIntegrationProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  onSessionEnded.mockClear();
  await changeLocale('en');
});

describe('EdgeServicesSettingsPage', () => {
  it('confirms activation and refreshes the shared client mode immediately', async () => {
    const enabledDocument = {
      ...disabledDocument,
      settings: { mode: 'enabled' as const },
      effective_state: 'ready' as const,
      revision: '3'.repeat(32),
      updated_at_iso: '2026-08-01T03:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: disabledDocument }))
      .mockResolvedValueOnce(response({ success: true, data: enabledDocument }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge']}>
        <TestPage />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText('Disabled')).toHaveLength(2);
    const edgeNavigation = screen.getByRole('navigation', {
      name: 'Edge services',
    });
    expect(within(edgeNavigation).getByRole('link', { name: 'Overview' }))
      .toHaveAttribute('aria-current', 'page');
    expect(within(edgeNavigation).getByRole('link', {
      name: 'Mail delivery',
    })).toBeInTheDocument();
    expect(within(edgeNavigation).getByRole('combobox', {
      name: 'Edge services section',
    })).toHaveValue('/settings/edge');
    expect(within(edgeNavigation).queryByRole('link', { name: 'Comments' }))
      .not.toBeInTheDocument();
    expect(within(edgeNavigation).queryByRole('link', {
      name: 'Request security',
    })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current integration mode'))
      .toHaveTextContent('disabled');
    expect(screen.getByText('EDGE_MAINTENANCE_MODE')).toBeInTheDocument();
    expect(screen.getByText('COMMENTS_ENABLED')).toBeInTheDocument();
    expect(screen.getAllByText('Plain variable')).toHaveLength(4);
    await user.click(screen.getByRole('button', {
      name: 'Enable Studio Edge integration',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Enable Edge Services?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Apply change',
    }));

    expect(await screen.findByText('Studio Edge integration is enabled.'))
      .toBeInTheDocument();
    expect(screen.getByLabelText('Current integration mode'))
      .toHaveTextContent('enabled');
    expect(within(edgeNavigation).getByRole('link', { name: 'Comments' }))
      .toBeInTheDocument();
    expect(within(edgeNavigation).getByRole('link', {
      name: 'Request security',
    })).toBeInTheDocument();
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(request.headers).toMatchObject({
      'X-ZeroPress-CSRF': session.csrf_token,
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: { mode: 'enabled' },
      expected_revision: disabledDocument.revision,
    });
  });

  it('runs the bounded manual drain and reloads the resulting pending count', async () => {
    const pendingDocument = {
      ...disabledDocument,
      settings: { mode: 'enabled' as const },
      effective_state: 'projection_pending' as const,
      pending_target_events: 4,
    };
    const readyDocument = {
      ...pendingDocument,
      effective_state: 'ready' as const,
      pending_target_events: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: pendingDocument }))
      .mockResolvedValueOnce(response({
        success: true,
        data: { processed_events: 4, remaining_events: 0 },
      }))
      .mockResolvedValueOnce(response({ success: true, data: readyDocument }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge']}>
        <TestPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Some saved content changes are still waiting to reach Edge.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry changes' }));
    expect(await screen.findByText('Processed 4 events; 0 remain.'))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect(fetchMock.mock.calls[1]?.[0])
      .toBe('/api/settings/edge-services/projections/drain');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toEqual({});
  });

  it('separates an unavailable lifecycle reason from the status facts and recovery action', async () => {
    const unavailableDocument = {
      ...disabledDocument,
      settings: { mode: 'enabled' as const },
      effective_state: 'unavailable' as const,
      unavailable_reason: 'database_upgrade_required' as const,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: unavailableDocument,
    })));
    render(
      <MemoryRouter initialEntries={['/settings/edge']}>
        <TestPage />
      </MemoryRouter>,
    );

    const status = await screen.findByRole('region', {
      name: 'Integration status',
    });
    expect(status.querySelectorAll('.edge-settings-status-facts > div'))
      .toHaveLength(2);
    expect(within(status).getByText('Reason').closest('.studio-callout'))
      .toHaveTextContent('requires a lifecycle upgrade');
    expect(within(status).getByRole('link', {
      name: 'View recovery steps',
    }).closest('.studio-panel-footer')).not.toBeNull();
  });

  it('links lifecycle-specific activation failures to Maintenance & Recovery', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: disabledDocument }))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'EDGE_DATABASE_INSTALL_REQUIRED' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge']}>
        <TestPage />
      </MemoryRouter>,
    );

    await screen.findAllByText('Disabled');
    await user.click(screen.getByRole('button', {
      name: 'Enable Studio Edge integration',
    }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Apply change',
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Edge database is empty.',
    );
    expect(screen.getByRole('link', {
      name: 'View recovery steps',
    })).toHaveAttribute('href', '/system/operations/edge');
  });
});
