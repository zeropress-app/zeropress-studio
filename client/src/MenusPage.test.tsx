// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { MenusPage } from './MenusPage';
import { changeLocale } from './i18n';
import { referencePost, referenceSearchResponse } from './test/menu-reference-fixtures';
import { StudioToaster } from './components/primitives';
import { createDefaultMenuDraft, type DefaultMenuId, type Menu } from '../../contracts/menus';

const NOW = '2026-08-01T08:00:00.000Z';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function menus(items: unknown[]) {
  return response({ success: true, data: { items } });
}

function storedDefault(menuId: DefaultMenuId, overrides: Partial<Menu> = {}): Menu {
  return {
    ...createDefaultMenuDraft(menuId),
    revision: '1'.repeat(32),
    created_at_iso: NOW,
    updated_at_iso: NOW,
    ...overrides,
  };
}

function renderPage(onSessionEnded = vi.fn()) {
  return render(
    <MemoryRouter>
      <StudioToaster />
      <MenusPage data={{ csrf_token: 'c'.repeat(43) }} onSessionEnded={onSessionEnded} />
    </MemoryRouter>,
  );
}

function stubMenuApi(
  stored: Menu[],
  onSave?: (request: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const url = String(path);
    if (url === '/api/menus' && (init?.method ?? 'GET') === 'GET') return menus(stored);
    if (url === '/api/menus/primary' && init?.method === 'PUT' && onSave) return onSave(init);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Menu settings' }));
  return screen.getByRole('dialog', { name: 'Menu settings' });
}

async function renameMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await openSettings(user);
  await user.clear(screen.getByLabelText('Menu name'));
  await user.type(screen.getByLabelText('Menu name'), name);
  await user.click(screen.getByRole('button', { name: 'Apply changes' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('MenusPage', () => {
  it.each(['primary', 'footer'] as const)('keeps default slots in memory until explicitly saving %s', async (menuId) => {
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/menus' && (init?.method ?? 'GET') === 'GET') {
        return menus([]);
      }
      if (url === `/api/menus/${menuId}` && init?.method === 'PUT') {
        return menus([storedDefault('primary'), storedDefault('footer')]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Primary Menu' })).toBeInTheDocument();
    expect(screen.getAllByText('Not saved')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
    await openSettings(user);
    expect(screen.getByLabelText('Menu ID')).toHaveValue('primary');
    expect(screen.getByLabelText('Menu ID')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(within(screen.getByLabelText('Link type')).getAllByRole('option')
      .map((option) => option.getAttribute('value'))).toEqual([
      'custom', 'post', 'page', 'category', 'tag',
    ]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const leaveEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaveEvent);
    expect(leaveEvent.defaultPrevented).toBe(false);
    await user.click(screen.getByRole('button', { name: /^Footer Menu/ }));
    expect(screen.getByRole('heading', { name: 'Footer Menu' })).toBeInTheDocument();
    if (menuId === 'primary') {
      await user.click(screen.getByRole('button', { name: /^Primary Menu/ }));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: createDefaultMenuDraft(menuId).name })).toBeInTheDocument();

    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`/api/menus/${menuId}`);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      name: createDefaultMenuDraft(menuId).name,
      enabled: true,
      items: [],
      expected_revision: null,
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Delete menu' }))
      .not.toBeInTheDocument();
  });

  it('supports explicit indent and saves a revision-bound canonical tree', async () => {
    const initialMenu = {
      menu_id: 'docs',
      name: 'Docs Menu',
      enabled: true,
      items: [{
        id: '1'.repeat(32),
        title: 'Parent',
        link: { kind: 'custom', url: '/parent/' },
        target: '_self',
        children: [],
      }, {
        id: '2'.repeat(32),
        title: 'Child',
        link: { kind: 'custom', url: '/child/' },
        target: '_self',
        children: [],
      }],
      revision: '3'.repeat(32),
      created_at_iso: NOW,
      updated_at_iso: NOW,
    };
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/menus' && (init?.method ?? 'GET') === 'GET') {
        return menus([initialMenu]);
      }
      if (url === '/api/menus/docs' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return response({
          success: true,
          data: {
            items: [storedDefault('primary'), storedDefault('footer'), {
              menu_id: 'docs',
              name: body.name,
              enabled: body.enabled,
              items: body.items,
              revision: '4'.repeat(32),
              created_at_iso: NOW,
              updated_at_iso: NOW,
            }],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <MenusPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /^Docs Menu/ }));
    const childCard = screen.getByText('Child').closest('article');
    expect(childCard).not.toBeNull();
    await user.click(within(childCard as HTMLElement).getByRole('button', {
      name: 'Indent',
    }));
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();

    const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
      name: 'Docs Menu',
      enabled: true,
      items: [{
        id: '1'.repeat(32),
        title: 'Parent',
        link: { kind: 'custom', url: '/parent/' },
        target: '_self',
        children: [{
          id: '2'.repeat(32),
          title: 'Child',
          link: { kind: 'custom', url: '/child/' },
          target: '_self',
          children: [],
        }],
      }],
      expected_revision: '3'.repeat(32),
    });
  });

  it('loads selectable Posts only after opening the picker and returns a typed reference to the draft', async () => {
    const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const url = String(path);
      if (url === '/api/menus') return menus([]);
      if (url.startsWith('/api/posts?')) {
        return referenceSearchResponse(url, url.includes('search=Needle')
          ? [{ ...referencePost, title: 'Needle Post', slug: 'needle-post' }] : []);
      }
      if (url === '/api/menus/link-references') return menus([{
        kind: 'post', reference_id: referencePost.id, title: 'Needle Post', detail: 'needle-post', status: 'available',
      }]);
      if (url === '/api/menus/primary' && init?.method === 'PUT') {
        return menus([storedDefault('primary', { items: JSON.parse(String(init.body)).items }), storedDefault('footer')]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    await user.selectOptions(screen.getByLabelText('Link type'), 'post');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Reference' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find a Post' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search content' }), 'Needle{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Select Needle Post' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Add item' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Needle Post');
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('needle-post');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'GET')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Add to end' }));
    await screen.findByText('Needle Post — needle-post');
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const item = JSON.parse(String(write?.[1]?.body)).items[0];
    expect(item.link).toEqual({ kind: 'post', reference_id: referencePost.id });
    expect(item).not.toHaveProperty('meta');
    expect(item).not.toHaveProperty('public_id');
  });

  it('distinguishes untouched default drafts from authored unsaved changes', async () => {
    const fetchMock = stubMenuApi([]);
    const user = userEvent.setup();
    renderPage();
    await renameMenu(user, 'Site navigation');
    await user.click(screen.getByRole('button', { name: /^Footer Menu/ }));
    expect(screen.getByText('Save or discard the current menu before selecting another menu.'))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Site navigation' })).toBeInTheDocument();
    const dirtyLeave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyLeave);
    expect(dirtyLeave.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('heading', { name: 'Primary Menu' })).toBeInTheDocument();
    const cleanLeave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanLeave);
    expect(cleanLeave.defaultPrevented).toBe(false);
    await user.click(screen.getByRole('button', { name: /^Footer Menu/ }));
    expect(screen.getByRole('heading', { name: 'Footer Menu' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fills the missing default without resetting an imported menu, then uses its stored revision', async () => {
    const existing = storedDefault('primary', { name: 'Imported navigation', enabled: false });
    let savedMenu = existing;
    const fetchMock = stubMenuApi([existing], (request) => {
      const body = JSON.parse(String(request.body));
      savedMenu = { ...savedMenu, name: body.name, revision: '2'.repeat(32) };
      return menus([savedMenu, storedDefault('footer')]);
    });
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);
    expect(screen.getByLabelText('Menu name')).toHaveValue('Imported navigation');
    expect(screen.getByRole('checkbox', { name: 'Enable menu' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByText('Not saved')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled());
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Imported navigation' })).toBeInTheDocument();

    await renameMenu(user, 'Imported navigation edited');
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { name: 'Imported navigation', enabled: false, items: [], expected_revision: '1'.repeat(32) },
      { name: 'Imported navigation edited', enabled: false, items: [], expected_revision: '2'.repeat(32) },
    ]);
  });

  it.each([
    {
      label: 'first-save conflict',
      reply: () => response({ success: false, error: { code: 'MENU_ID_CONFLICT' } }, 409),
      message: 'That menu_id already exists. Reload the list before continuing.',
    },
    {
      label: 'incomplete success response',
      reply: () => menus([storedDefault('primary')]),
      message: 'Studio returned an unexpected Menu response.',
    },
  ])('retains an edited default after a $label without an automatic retry', async ({ reply, message }) => {
    const fetchMock = stubMenuApi([], reply);
    const user = userEvent.setup();
    renderPage();
    await renameMenu(user, 'Primary Menu edited');
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Primary Menu edited' })).toBeInTheDocument();
    expect(screen.getAllByText('Not saved')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prevents selection and draft edits while a save is pending', async () => {
    const existing = storedDefault('primary', { items: [{
      id: 'a'.repeat(32),
      title: 'Home',
      link: { kind: 'custom', url: '/' },
      target: '_self',
      children: [],
    }] });
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    stubMenuApi([existing], () => pending);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Primary Menu' });
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(screen.getByRole('button', { name: /^Footer Menu/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Menu settings' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Home' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Actions for Home' })).toBeDisabled();
    await act(async () => finish(menus([existing, storedDefault('footer')])));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Footer Menu/ })).toBeEnabled());
    expect(screen.getByRole('heading', { name: 'Primary Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Home' })).toBeEnabled();
  });

  it('does not turn a failed load into an editable empty database', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    expect(await screen.findByText('Menus could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Primary Menu/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
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
        <MenusPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={onSessionEnded}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });
});
