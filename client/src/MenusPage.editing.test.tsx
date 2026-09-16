// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMenuDraft, type Menu, type MenuItem } from '../../contracts/menus';
import { MenusPage } from './MenusPage';
import { StudioToaster } from './components/primitives';
import { changeLocale } from './i18n';
import { referencePost, referenceSearchResponse } from './test/menu-reference-fixtures';

const NOW = '2026-08-31T00:00:00Z';
const REVISION = '1'.repeat(32);
const link = (index: number, title: string, children: MenuItem[] = []): MenuItem => ({
  id: index.toString(16).padStart(32, '0'), title,
  link: { kind: 'custom', url: `/${title.toLowerCase()}/` }, target: '_self', children,
});
const stored = (id: 'primary' | 'footer', items: MenuItem[] = []): Menu => ({
  ...createDefaultMenuDraft(id), items, revision: REVISION, created_at_iso: NOW, updated_at_iso: NOW,
});
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function list(items: unknown[]) { return json({ success: true, data: { items } }); }
function setup(items: MenuItem[] = [], extra?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const primary = stored('primary', items);
  const footer = stored('footer');
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(path);
    const result = extra?.(url, init);
    if (result) return result;
    if (url === '/api/menus' && init.method === 'GET') return list([primary, footer]);
    if (url === '/api/menus/primary' && init.method === 'PUT') {
      const { expected_revision: _expected, ...draft } = JSON.parse(String(init.body));
      return list([{ ...primary, ...draft, revision: '2'.repeat(32) }, footer]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter>
    <StudioToaster />
    <MenusPage data={{ csrf_token: 'c'.repeat(43) }} onSessionEnded={vi.fn()} />
  </MemoryRouter>);
  return fetchMock;
}
const writes = (mock: ReturnType<typeof setup>) => mock.mock.calls.filter(([, init]) => (
  init?.method !== 'GET' && init?.method !== undefined
));
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Menu settings' }));
}
async function removeAction(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
}

beforeEach(async () => { localStorage.clear(); await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Menus compact editor', () => {
  it('shows compact rows, typed icons, counts, and parent information without expanded forms', async () => {
    const fetchMock = setup([link(1, 'Home', [link(2, 'About')])]);
    expect(await screen.findByRole('article', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Under Home · Level 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Primary Menu/ })).toHaveTextContent('2 items');
    expect(screen.getByRole('button', { name: /^Footer Menu/ })).toHaveTextContent('0 items');
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Menu name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Meta JSON (optional)')).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Home' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('applies settings only to the draft and guards selection through the narrow-screen selector', async () => {
    const user = userEvent.setup();
    const fetchMock = setup();
    await openSettings(user);
    expect(screen.getByLabelText('Menu ID')).toBeDisabled();
    expect(screen.getByLabelText('Menu ID')).toHaveValue('primary');
    expect(screen.queryByRole('button', { name: 'Delete menu' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Menu name'));
    await user.type(screen.getByLabelText('Menu name'), 'Canceled');
    await user.click(screen.getByRole('checkbox', { name: 'Enable menu' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Primary Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled();

    await openSettings(user);
    expect(screen.getByRole('checkbox', { name: 'Enable menu' })).toBeChecked();
    await user.clear(screen.getByLabelText('Menu name'));
    await user.type(screen.getByLabelText('Menu name'), 'Site navigation');
    await user.click(screen.getByRole('checkbox', { name: 'Enable menu' }));
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(writes(fetchMock)).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText('Select a menu'), 'footer');
    expect(screen.getByLabelText('Select a menu')).toHaveValue('primary');
    expect(screen.getByText('Save or discard the current menu before selecting another menu.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    expect(JSON.parse(String(writes(fetchMock)[0][1]?.body))).toEqual({
      name: 'Site navigation', enabled: false, items: [], expected_revision: REVISION,
    });
  });

  it('keeps failed custom creation inside the dialog and creates only on explicit submit', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const fetchMock = setup([], (url, init) => {
      if (url !== '/api/menus' || init.method !== 'POST') return;
      attempts++;
      if (attempts === 1) return json({ success: false, error: { code: 'MENU_ID_CONFLICT' } }, 409);
      return json({ success: true, data: {
        ...JSON.parse(String(init.body)), revision: REVISION, created_at_iso: NOW, updated_at_iso: NOW,
      } });
    });
    await user.click(await screen.findByRole('button', { name: 'New' }));
    await user.type(screen.getByLabelText('Menu name'), 'Documentation');
    await user.type(screen.getByLabelText('Menu ID'), 'docs');
    expect(writes(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Create menu' }));
    const dialog = screen.getByRole('dialog', { name: 'New menu' });
    expect(await within(dialog).findByText('That menu_id already exists. Reload the list before continuing.')).toBeInTheDocument();
    expect(screen.getByLabelText('Menu name')).toHaveValue('Documentation');
    await user.type(screen.getByLabelText('Menu ID'), '-extra');
    await user.click(screen.getByRole('button', { name: 'Create menu' }));
    expect(await screen.findByRole('heading', { name: 'Documentation' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(2);
    expect(JSON.parse(String(writes(fetchMock)[1][1]?.body))).toEqual({
      menu_id: 'docs-extra', name: 'Documentation', enabled: true, items: [],
    });
  });

  it('cancels an item dialog cleanly, then preserves children and validates metadata before applying', async () => {
    const user = userEvent.setup();
    const root = { ...link(1, 'Home', [link(2, 'About')]), meta: { featured: true } };
    const fetchMock = setup([root]);
    await user.click(await screen.findByRole('button', { name: 'Actions for Home' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit item' }));
    expect(screen.getByLabelText('Link type')).toBeDisabled();
    await user.type(screen.getByLabelText('Title'), ' canceled');
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit Home' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled();
    const cleanLeave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanLeave);
    expect(cleanLeave.defaultPrevented).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Edit Home' }));
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Welcome');
    await user.click(screen.getByRole('checkbox', { name: 'Open in a new tab' }));
    await user.click(screen.getByText('Advanced metadata'));
    await user.clear(screen.getByLabelText('Meta JSON (optional)'));
    await user.type(screen.getByLabelText('Meta JSON (optional)'), 'invalid');
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByText('One or more Meta JSON values are invalid.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit item' })).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Meta JSON (optional)'));
    await user.type(screen.getByLabelText('Meta JSON (optional)'), '{{"featured":false,"order":3}');
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByRole('button', { name: 'Edit Welcome' })).toHaveFocus();
    expect(screen.getByRole('article', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Under Welcome · Level 2')).toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    expect(JSON.parse(String(writes(fetchMock)[0][1]?.body)).items).toEqual([
      { ...root, title: 'Welcome', target: '_blank', meta: { featured: false, order: 3 } },
    ]);
  });

  it('adds an item to the end without writing until Save menu', async () => {
    const user = userEvent.setup();
    const fetchMock = setup([link(1, 'Home')]);
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    await user.type(screen.getByLabelText('Title'), 'Docs');
    await user.clear(screen.getByLabelText('Custom URL'));
    await user.type(screen.getByLabelText('Custom URL'), 'https://docs.example.test/');
    await user.click(screen.getByRole('checkbox', { name: 'Open in a new tab' }));
    await user.click(screen.getByRole('button', { name: 'Add to end' }));
    expect(screen.getAllByRole('article').map((row) => row.getAttribute('aria-label'))).toEqual(['Home', 'Docs']);
    expect(screen.getByRole('button', { name: /^Primary Menu/ })).toHaveTextContent('2 items');
    expect(writes(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    const items = JSON.parse(String(writes(fetchMock)[0][1]?.body)).items;
    expect(items[1]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u), title: 'Docs',
      link: { kind: 'custom', url: 'https://docs.example.test/' }, target: '_blank', children: [],
    });
  });

  it('confirms subtree removal, restores it on discard, and never deletes linked content', async () => {
    const user = userEvent.setup();
    const fetchMock = setup([link(1, 'Home', [link(2, 'About')])]);
    await screen.findByRole('article', { name: 'Home' });
    await removeAction(user, 'Home');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit Home' })).toHaveFocus();
    expect(screen.getByRole('article', { name: 'About' })).toBeInTheDocument();
    await removeAction(user, 'Home');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No links yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toHaveFocus();
    expect(writes(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('article', { name: 'About' })).toBeInTheDocument();
    await removeAction(user, 'Home');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(1);
    expect(writes(fetchMock)[0][0]).toBe('/api/menus/primary');
    expect(JSON.parse(String(writes(fetchMock)[0][1]?.body)).items).toEqual([]);
  });

  it('retains ten-level editing and prevents an indent beyond the contract', async () => {
    let children = [link(10, 'Leaf'), link(11, 'Last')];
    for (let depth = 9; depth > 0; depth--) children = [link(depth, `Level${depth}`, children)];
    const user = userEvent.setup();
    const fetchMock = setup(children);
    const row = await screen.findByRole('article', { name: 'Last' });
    expect(within(row).getByText('Under Level9 · Level 10')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Indent' })).toBeDisabled();
    await user.click(within(row).getByRole('button', { name: 'Outdent' }));
    expect(within(screen.getByRole('article', { name: 'Last' })).getByText('Under Level8 · Level 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Last' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText('Menu saved.')).toBeInTheDocument();
    let saved = JSON.parse(String(writes(fetchMock)[0][1]?.body)).items as MenuItem[];
    for (let depth = 1; depth < 9; depth++) saved = saved[0].children;
    expect(saved.map((item) => item.title)).toEqual(['Level9', 'Last']);
    expect(saved[1].id).toBe(link(11, 'Last').id);
  });

  it('abandons a pending picker request when returning to the item and changing type', async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    let requestPath = '';
    const user = userEvent.setup();
    setup([], (url, init) => {
      if (!url.startsWith('/api/posts?')) return;
      signal = init.signal ?? undefined;
      requestPath = url;
      return new Promise((resolve) => { finish = resolve; });
    });
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    await user.selectOptions(screen.getByLabelText('Link type'), 'post');
    await user.click(screen.getByRole('button', { name: 'Find a Post' }));
    await screen.findByText('Loading content…');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Find a Post' })).toHaveFocus();
    await user.selectOptions(screen.getByLabelText('Link type'), 'custom');
    expect(signal?.aborted).toBe(true);
    await user.type(screen.getByLabelText('Title'), 'Authored title');
    await act(async () => finish(referenceSearchResponse(requestPath, [referencePost])));
    expect(screen.getByLabelText('Title')).toHaveValue('Authored title');
    expect(screen.getByLabelText('Link type')).toHaveValue('custom');
    expect(screen.queryByText('Found Post')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
