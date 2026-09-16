// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { WidgetsPage } from './WidgetsPage';
import { changeLocale } from './i18n';
import { StudioToaster } from './components/primitives';
import { createDefaultWidgetAreaDraft } from '../../contracts/widgets';

const NOW = '2026-08-01T08:00:00.000Z';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function area(items: unknown[] = [], revision = '1'.repeat(32)) {
  return {
    widget_area_id: 'sidebar',
    name: 'Sidebar Widgets',
    enabled: true,
    items,
    revision,
    created_at_iso: NOW,
    updated_at_iso: NOW,
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

describe('WidgetsPage', () => {
  it('shows the virtual default sidebar and stores it on the first save', async () => {
    const draft = createDefaultWidgetAreaDraft();
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/widgets' && (init?.method ?? 'GET') === 'GET') {
        return response({ success: true, data: { items: [] } });
      }
      if (url === '/api/widgets/author-options?search=') {
        return response({ success: true, data: { items: [] } });
      }
      if (url === '/api/widgets/sidebar' && init?.method === 'PUT') {
        return response({ success: true, data: area(draft.items) });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Edit Recent Posts' }))
      .toBeInTheDocument();
    expect(screen.getAllByText('5 items')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Save Widget area' }));
    expect(await screen.findByText('Widget area saved.')).toBeInTheDocument();
    const saveCall = fetchMock.mock.calls.find(([, init]) => (
      init?.method === 'PUT'
    ));
    expect(saveCall?.[0]).toBe('/api/widgets/sidebar');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      name: draft.name,
      enabled: draft.enabled,
      items: draft.items,
      expected_revision: null,
    });
  });

  it('preserves an explicitly stored empty sidebar without restoring defaults', async () => {
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/widgets' && (init?.method ?? 'GET') === 'GET') {
        return response({ success: true, data: { items: [area()] } });
      }
      if (url === '/api/widgets/author-options?search=') {
        return response({ success: true, data: { items: [] } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('This area has no Widgets'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Recent Posts' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Widget area' }))
      .toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => (
      init?.method === 'POST' || init?.method === 'PUT'
    ))).toBe(false);
  });

  it('offers all resolver-backed types and never exposes Image', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => (
      String(path).includes('author-options')
        ? response({ success: true, data: { items: [] } })
        : response({ success: true, data: { items: [area()] } })
    )));
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText('This area has no Widgets');
    await userEvent.setup().click(screen.getByRole('button', {
      name: 'Add a Widget',
    }));
    const typeSelect = await screen.findByLabelText('Widget type');
    expect(typeSelect.querySelectorAll('option')).toHaveLength(8);
    expect(screen.queryByRole('option', { name: 'Image' }))
      .not.toBeInTheDocument();
  });

  it('moves custom area creation into a focused dialog', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => (
      String(path).includes('author-options')
        ? response({ success: true, data: { items: [] } })
        : response({ success: true, data: { items: [area()] } })
    )));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByText('This area has no Widgets');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New area' }));
    expect(screen.getByRole('dialog', { name: 'Create a custom area' }))
      .toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByLabelText('Widget area ID')).toBeInTheDocument();
  });

  it('edits a Widget in a modal and saves the whole area draft', async () => {
    const searchItem = {
      id: 'a'.repeat(32),
      type: 'search',
      title: 'Site Search',
      enabled: true,
      settings: { placeholder: 'Search...', button_label: 'Search' },
    };
    const savedBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/widgets' && (init?.method ?? 'GET') === 'GET') {
        return response({ success: true, data: { items: [area([searchItem])] } });
      }
      if (url === '/api/widgets/author-options?search=') {
        return response({ success: true, data: { items: [] } });
      }
      if (url === '/api/widgets/sidebar' && init?.method === 'PUT') {
        const savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        savedBodies.push(savedBody);
        return response({
          success: true,
          data: area(savedBody.items as unknown[], '2'.repeat(32)),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', {
      name: 'Edit Site Search',
    }));
    expect(screen.queryByLabelText('Widget type')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Title (optional)'));
    await user.type(screen.getByLabelText('Title (optional)'), 'Find content');
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save Widget area' }));
    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toMatchObject({
      name: 'Sidebar Widgets',
      enabled: true,
      expected_revision: '1'.repeat(32),
    });
    expect(savedBodies[0]?.items).toEqual([
      { ...searchItem, title: 'Find content' },
    ]);
  });

  it('ends the local session when authentication is lost', async () => {
    const onSessionEnded = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      response({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED' },
      }, 401),
    )));
    render(
      <MemoryRouter>
        <StudioToaster />
        <WidgetsPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={onSessionEnded}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });
});
