// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import { changeLocale } from '../i18n';
import { DashboardSearchIndexNotice } from './DashboardSearchIndexNotice';

const CSRF = 'c'.repeat(43);
const required: ContentSearchIndexStatus = {
  state: 'rebuild_required', reason: 'schema_upgrade', phase: null, operation_id: null,
  post_public_id_cursor: 0, page_public_id_cursor: 0,
  processed_posts: 0, processed_pages: 0, total_posts: 7, total_pages: 0, available: true,
};
const active: ContentSearchIndexStatus = {
  ...required, state: 'in_progress', phase: 'posts', operation_id: 'a'.repeat(32),
  post_public_id_cursor: 5, processed_posts: 5,
};
const ready: ContentSearchIndexStatus = {
  ...active, state: 'ready', phase: null, operation_id: null,
  post_public_id_cursor: 7, processed_posts: 7,
};
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function status(value = required) { return json({ success: true, data: value }); }
function mutation(value: ContentSearchIndexStatus) {
  return json({ success: true, data: {
    operation: 'rebuild_content_search_index',
    status: value.state === 'ready' ? 'completed' : 'in_progress',
    content_search_index: value,
  } });
}
function setup(initialState = required.state) {
  const onSessionEnded = vi.fn();
  const onStateChange = vi.fn();
  const view = render(<MemoryRouter><DashboardSearchIndexNotice
    initialState={initialState} csrfToken={CSRF}
    onSessionEnded={onSessionEnded} onStateChange={onStateChange}
  /></MemoryRouter>);
  return { ...view, onSessionEnded, onStateChange, user: userEvent.setup() };
}
beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => status()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('dashboard search index rebuild', () => {
  it('confirms before starting, blocks duplicate clicks and completes the shared steps', async () => {
    let completeStep!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { completeStep = resolve; });
    vi.mocked(fetch)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(mutation({ ...active, post_public_id_cursor: 0, processed_posts: 0 }))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(mutation(ready));
    const { user, onStateChange } = setup();
    const start = screen.getByRole('button', { name: 'Rebuild search index' });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Rebuild the search index?' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(start);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rebuild search index' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Rebuilding…' })).toBeDisabled();
    const [, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(init).toMatchObject({
      method: 'POST', body: '{}', credentials: 'same-origin',
      headers: { 'X-ZeroPress-CSRF': CSRF },
    });
    await act(async () => completeStep(mutation(active)));
    expect(await screen.findByText('Search is ready')).toBeVisible();
    expect(onStateChange).toHaveBeenLastCalledWith('ready');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[3]![1]!.body))).toMatchObject({
      operation_id: active.operation_id, expected_post_public_id_cursor: 5,
    });
  });
  it('reads committed progress after a lost response and resumes without restarting', async () => {
    const advanced = { ...active, processed_posts: 7, post_public_id_cursor: 7, phase: 'pages' as const };
    vi.mocked(fetch)
      .mockResolvedValueOnce(status(active))
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(status(advanced))
      .mockResolvedValueOnce(mutation(ready));
    const { user } = setup('in_progress');
    const resume = screen.getByRole('button', { name: 'Continue rebuild' });
    await waitFor(() => expect(resume).toBeEnabled());
    await user.click(resume);
    expect(await screen.findByText('7 Posts · 0 Pages processed · Pages')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('The connection was interrupted');
    await user.click(screen.getByRole('button', { name: 'Continue rebuild' }));
    expect(await screen.findByText('Search is ready')).toBeVisible();
    expect(vi.mocked(fetch).mock.calls[3]![0]).toBe('/api/content-search-index/rebuild/step');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[3]![1]!.body))).toEqual({
      operation_id: active.operation_id, expected_phase: 'pages',
      expected_post_public_id_cursor: 7, expected_page_public_id_cursor: 0,
    });
  });
  it('stops sending steps when the dashboard is left', async () => {
    let completeStep!: (value: Response) => void;
    vi.mocked(fetch).mockResolvedValueOnce(status(active))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { completeStep = resolve; }));
    const { user, unmount } = setup('in_progress');
    const resume = screen.getByRole('button', { name: 'Continue rebuild' });
    await waitFor(() => expect(resume).toBeEnabled());
    await user.click(resume);
    const signal = vi.mocked(fetch).mock.calls[1]![1]!.signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => completeStep(mutation(active)));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('stops for an expired administrator session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(status(active))
      .mockResolvedValueOnce(json({ success: false, error: { code: 'AUTHENTICATION_REQUIRED' } }));
    const { user, onSessionEnded } = setup('in_progress');
    const resume = screen.getByRole('button', { name: 'Continue rebuild' });
    await waitFor(() => expect(resume).toBeEnabled());
    await user.click(resume);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries an unavailable status and offers Operations for recovery in Korean', async () => {
    await changeLocale('ko');
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce(status({
        ...required, state: 'recovery_required', reason: 'integrity_failure', available: false,
      }));
    const { user, onStateChange } = setup();
    expect(await screen.findByText('검색 인덱스 상태를 확인할 수 없습니다')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '상태 확인' }));
    expect(await screen.findByRole('link', { name: '유지보수 및 복구 열기' }))
      .toHaveAttribute('href', '/system/operations/database');
    expect(onStateChange).toHaveBeenLastCalledWith('recovery_required');
  });
});
