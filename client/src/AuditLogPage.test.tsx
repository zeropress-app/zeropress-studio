// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuditLogPage } from './AuditLogPage';
import { changeLocale } from './i18n';
import type { AuditLogDetail } from '../../contracts/audit-logs';
const detail: AuditLogDetail = {
  id: 'record-1', occurred_at: '2026-09-22T01:00:00.000Z', action: 'content_delete', category: 'content', outcome: 'success',
  actor: { kind: 'user', id: 'former-id', name: 'Former owner', email: 'former@example.test' },
  target: { type: 'post', id: 'post-1', label: '<img src=x onerror=alert(1)>' }, metadata: {},
  network: { ip_address: '192.0.2.1', ip_recorded_at: '2026-09-22T01:00:00.000Z', ip_hash: `v1.${'a'.repeat(64)}`,
    user_agent: 'Synthetic browser', country: 'KR', region: null, city: null, timezone: null, asn: null, organization: null },
};
const list = { success: true, data: { items: [detail], next_cursor: null } };
beforeEach(async () => { await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function view() { render(<MemoryRouter><AuditLogPage onSessionEnded={vi.fn()} /></MemoryRouter>); }
describe('AuditLogPage', () => {
  it('shows a saved actor and safely renders details, then filters by IP with keyboard controls', async () => {
    const api = vi.fn(async (url: string) => Response.json(url.includes('/record-1') ? { success: true, data: detail } : list));
    vi.stubGlobal('fetch', api); view();
    expect(await screen.findByText('Former owner')).toBeVisible();
    const user = userEvent.setup();
    const open = screen.getByRole('button', { name: /^Record details:/ });
    open.focus(); await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Record details' });
    expect(await within(dialog).findByText('former@example.test')).toBeVisible();
    expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(dialog.querySelector('img')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Show records from this IP' }));
    expect(await screen.findByText('Filtering by IP hash:')).toBeVisible();
    expect(api.mock.calls.at(-1)?.[0]).toContain('ip_hash=v1.');
  });
  it('distinguishes a failed query from an empty result and retries', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(fail
      ? { success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } }
      : { success: true, data: { items: [], next_cursor: null } }, { status: fail ? 503 : 200 })));
    view(); expect(await screen.findByText('Audit records could not be loaded')).toBeVisible();
    expect(screen.queryByText('No matching records')).toBeNull();
    fail = false; await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No matching records')).toBeVisible();
  });
  it('applies actor and result filters and uses a cursor to load more', async () => {
    const api = vi.fn(async (url: string) => Response.json({ success: true, data: {
      items: [{ ...detail, id: url.includes('cursor=') ? 'second' : detail.id }], next_cursor: url.includes('cursor=') ? null : 'cursor-value',
    } }));
    vi.stubGlobal('fetch', api); view(); await screen.findByText('Former owner');
    const user = userEvent.setup(); await user.type(screen.getByLabelText('Name or email'), 'former@');
    await user.selectOptions(screen.getByLabelText('Result'), 'success');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('Former owner');
    expect(api.mock.calls.at(-1)?.[0]).toContain('actor=former%40');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findAllByText('Former owner')).toHaveLength(2);
    expect(api.mock.calls.at(-1)?.[0]).toContain('cursor=cursor-value');
  });
  it('localizes the screen and outcomes in Korean', async () => {
    await changeLocale('ko'); vi.stubGlobal('fetch', vi.fn(async () => Response.json(list))); view();
    expect(await screen.findByRole('heading', { name: '감사 기록', level: 1 })).toBeVisible();
    expect(await screen.findByText('콘텐츠 영구 삭제')).toBeVisible();
    expect(screen.getAllByText('성공').length).toBeGreaterThan(0);
  });
});
