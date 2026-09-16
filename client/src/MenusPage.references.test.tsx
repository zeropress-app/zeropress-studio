// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { type Menu, type MenuItem, type MenuReferenceSummary, type MenuReference } from '../../contracts/menus';
import { MenusPage } from './MenusPage';
import { changeLocale } from './i18n';
import { referenceSearchResponse } from './test/menu-reference-fixtures';

const POST_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);
const POST: MenuReferenceSummary = {
  kind: 'post', reference_id: POST_ID, title: 'Current Post title', detail: 'current-post',
};
const OTHER: MenuReferenceSummary = {
  kind: 'post', reference_id: OTHER_ID, title: 'Other Post', detail: 'other-post',
};

function item(id: string, referenceId: string, title = 'Authored menu title'): MenuItem {
  return {
    id, title, link: { kind: 'post', reference_id: referenceId }, target: '_self', children: [],
  };
}

function menu(menuId: string, items: MenuItem[]): Menu {
  return {
    menu_id: menuId, name: menuId, enabled: true, items, revision: '1'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00Z', updated_at_iso: '2026-08-01T00:00:00Z',
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function result(items: unknown[]) {
  return json({ success: true, data: { items } });
}

function stubApi(input: {
  menus: Menu[];
  resolve: (references: MenuReference[], request: RequestInit) => Response | Promise<Response>;
}) {
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const url = String(path);
    if (url === '/api/menus/link-references') {
      expect(init?.method).toBe('POST');
      return input.resolve(JSON.parse(String(init?.body)).references, init!);
    }
    if (url.startsWith('/api/posts?')) return referenceSearchResponse(url, []);
    if (url === '/api/menus' && init?.method === 'GET') return result(input.menus);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(onSessionEnded = vi.fn()) {
  render(<MemoryRouter>
    <MenusPage data={{ csrf_token: 'c'.repeat(43) }} onSessionEnded={onSessionEnded} />
  </MemoryRouter>);
}

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Menu reference hydration', () => {
  it('resolves imported identities independently of search and retains them after an empty search', async () => {
    const imported = item('1'.repeat(32), POST_ID);
    imported.children.push(item('2'.repeat(32), POST_ID, 'Second authored title'));
    const resolve = vi.fn().mockImplementation(() => result([{ ...POST, status: 'available' }]));
    const fetchMock = stubApi({
      menus: [menu('primary', [imported]), menu('footer', [])], resolve,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Current Post title — current-post')).toHaveLength(2));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toEqual([{ kind: 'post', reference_id: POST_ID }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Save menu' })).toBeDisabled();
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Edit Authored menu title' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Authored menu title');
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('Current Post title');
    await user.click(screen.getByRole('button', { name: 'Change linked content' }));
    await user.type(screen.getByRole('searchbox'), 'No matching results{Enter}');
    await screen.findByText('No content found');
    await user.click(screen.getByRole('button', { name: 'Back to item' }));
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('Current Post title');
    expect(screen.getByLabelText('Title')).toHaveValue('Authored menu title');
    expect(resolve).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Edit Second authored title' }));
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('current-post');
    await user.type(screen.getByLabelText('Title'), ' edited');
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(screen.getByRole('button', { name: 'Edit Second authored title edited' })).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([path, init]) => (
      init?.method === 'GET' || String(path) === '/api/menus/link-references'
    ))).toBe(true);
  });

  it('does not label an unresolved reference missing while it is loading', async () => {
    let finish!: (response: Response) => void;
    stubApi({
      menus: [menu('primary', [item('1'.repeat(32), POST_ID)])],
      resolve: () => new Promise((resolve) => { finish = resolve; }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Checking reference…');
    expect(screen.queryByText(/Missing reference/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Authored menu title' }));
    const control = screen.getByRole('group', { name: 'Reference' });
    expect(control).toHaveTextContent('Checking reference…');
    await act(async () => finish(result([{ ...POST, status: 'available' }])));
    await waitFor(() => expect(control).toHaveTextContent('Current Post title'));
    expect(control).toHaveTextContent('current-post');
    expect(screen.getByLabelText('Title')).toHaveValue('Authored menu title');
  });

  it('keeps actual missing and Trash references distinct in read-only summaries', async () => {
    stubApi({
      menus: [menu('primary', [item('1'.repeat(32), POST_ID, 'Missing item'), item('2'.repeat(32), OTHER_ID, 'Trashed item')])],
      resolve: () => result([
        { kind: 'post', reference_id: POST_ID, status: 'missing' },
        { kind: 'post', reference_id: OTHER_ID, status: 'trash' },
      ]),
    });
    const user = userEvent.setup();
    renderPage();
    const missing = 'Missing reference (remove or replace before saving)';
    const trash = 'Reference in Trash (restore, remove, or replace before saving)';
    expect(await screen.findByText(missing)).toBeInTheDocument();
    expect(screen.getByText(trash)).toBeInTheDocument();
    for (const [title, label] of [['Missing item', missing], ['Trashed item', trash]]) {
      await user.click(screen.getByRole('button', { name: `Edit ${title}` }));
      expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent(label);
      expect(screen.queryByRole('combobox', { name: 'Reference' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change linked content' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
    }
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
  });

  it.each(['network', 'incomplete response'])(
    'retains the draft after a %s failure and supports an explicit reference-only retry',
    async (failure) => {
      const resolve = vi.fn()
        .mockImplementationOnce(() => failure === 'network'
          ? Promise.reject(new Error('offline'))
          : result([]))
        .mockImplementation(() => result([{ ...POST, status: 'available' }]));
      stubApi({ menus: [menu('primary', [item('1'.repeat(32), POST_ID)])], resolve });
      const user = userEvent.setup();
      renderPage();
      expect(await screen.findByText('Some references could not be checked. Your menu has not been changed.')).toBeInTheDocument();
      expect(screen.getByText('Reference could not be checked')).toBeInTheDocument();
      expect(screen.queryByText(/Missing reference/)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Edit Authored menu title' }));
      await user.type(screen.getByLabelText('Title'), ' edited');
      await user.click(screen.getByRole('button', { name: 'Apply changes' }));
      await user.click(screen.getByRole('button', { name: 'Check references again' }));
      expect(await screen.findByText('Current Post title — current-post')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit Authored menu title edited' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
      expect(resolve).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole('button', { name: 'Edit Authored menu title edited' }));
      expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('current-post');
      expect(screen.getByLabelText('Title')).toHaveValue('Authored menu title edited');
    },
  );

  it('ignores a late response after switching menus, including a disabled imported menu', async () => {
    let finish!: (response: Response) => void;
    let originalSignal: AbortSignal | undefined;
    const resolve = vi.fn().mockImplementation((references: MenuReference[], request: RequestInit) => {
      if (references[0].reference_id === POST_ID) {
        originalSignal = request.signal ?? undefined;
        return new Promise<Response>((done) => { finish = done; });
      }
      return result([{ ...OTHER, status: 'available' }]);
    });
    stubApi({
      menus: [menu('primary', [item('1'.repeat(32), POST_ID)]), {
        ...menu('topmenu', [item('2'.repeat(32), OTHER_ID)]), enabled: false,
      }], resolve,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Checking reference…');
    await user.click(screen.getByRole('button', { name: /^topmenu/ }));
    expect(await screen.findByText('Other Post — other-post')).toBeInTheDocument();
    expect(originalSignal?.aborted).toBe(true);
    await act(async () => finish(result([{ kind: 'post', reference_id: POST_ID, status: 'missing' }])));
    expect(screen.getByText('Other Post — other-post')).toBeInTheDocument();
    expect(screen.queryByText(/Missing reference/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Authored menu title' }));
    expect(screen.getByRole('group', { name: 'Reference' })).toHaveTextContent('Other Post');
  });

  it('ends the session when the exact-reference request loses authentication', async () => {
    stubApi({
      menus: [menu('primary', [item('1'.repeat(32), POST_ID)])],
      resolve: () => json({ success: false, error: { code: 'AUTHENTICATION_REQUIRED' } }, 401),
    });
    const onSessionEnded = vi.fn();
    renderPage(onSessionEnded);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Missing reference/)).not.toBeInTheDocument();
  });
});
