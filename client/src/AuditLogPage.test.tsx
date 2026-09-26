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
  it.each([
    { locale: 'en', title: 'Record details', steps: 'Operation steps', completed: 'Completed', progress: 'Progress recorded', more: 'Load earlier steps', database: 'Studio database', posts: 'Posts processed' },
    { locale: 'ko', title: '기록 상세', steps: '작업 단계', completed: '완료됨', progress: '진행 기록', more: '이전 단계 더 보기', database: 'Studio 데이터베이스', posts: '처리한 글' },
  ] as const)('browses grouped rebuild steps and each caller in $locale', async (labels) => {
    await changeLocale(labels.locale);
    const progress: AuditLogDetail = { ...detail, id: 'progress', action: 'operations_search', category: 'operations',
      target: { type: 'DB', id: null, label: null },
      metadata: { operation_id: 'rebuild', stage: 'step', search_phase: 'posts', processed_posts: 5, total_posts: 6 },
    };
    const completed: AuditLogDetail = { ...progress, id: 'completed',
      actor: { kind: 'operations', id: null, name: 'Operations token', email: null },
      metadata: { ...progress.metadata, stage: 'completed', search_phase: 'verify', processed_posts: 6, initiator: detail.actor },
      network: { ...detail.network, ip_address: '192.0.2.2' },
    };
    const first: AuditLogDetail = { ...progress, id: 'start', metadata: { operation_id: 'rebuild', stage: 'started' } };
    const api = vi.fn(async (url: string) => {
      if (url.includes('/events?')) return Response.json({ success: true, data: {
        items: url.includes('cursor=') ? [first] : [completed, progress], next_cursor: url.includes('cursor=') ? null : 'earlier',
      } });
      if (url.includes('/completed')) return Response.json({ success: true, data: completed });
      if (url.includes('/progress')) return Response.json({ success: true, data: progress });
      if (url.includes('/start')) return Response.json({ success: true, data: first });
      return Response.json({ success: true, data: { items: [{ ...completed, event_count: 3 }], next_cursor: null } });
    });
    vi.stubGlobal('fetch', api); view();
    expect(await screen.findByText(labels.database)).toBeVisible();
    const row = screen.getByText(labels.completed).closest('tr')!;
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button'));
    const dialog = await screen.findByRole('dialog', { name: labels.title });
    const steps = within(dialog).getByRole('region', { name: labels.steps });
    const step = await within(steps).findByRole('button', { name: new RegExp(labels.progress) });
    step.focus(); await user.keyboard('{Enter}');
    expect(await within(dialog).findByText('192.0.2.1')).toBeVisible();
    expect(within(dialog).getByText('former@example.test')).toBeVisible();
    expect(within(dialog).getByText(labels.posts).nextElementSibling).toHaveTextContent('5');
    expect(step).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(steps).getByRole('button', { name: labels.more }));
    expect(await within(steps).findByRole('button', { name: /Started|시작됨/ })).toBeVisible();
    expect(within(steps).getAllByRole('button', { pressed: false })).toHaveLength(2);
    expect(api.mock.calls.some(([url]) => url.includes('/completed/events?cursor=earlier'))).toBe(true);
  });

  it('shows a neutral start and retries failed step history without hiding the event details', async () => {
    const started: AuditLogDetail = { ...detail, id: 'start', action: 'operations_search', category: 'operations',
      metadata: { operation_id: 'rebuild', stage: 'started' }, target: { type: 'DB', id: null, label: null },
    };
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/events?')) return Response.json(fail ? { success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } }
        : { success: true, data: { items: [started], next_cursor: null } });
      return Response.json(url.includes('/start') ? { success: true, data: started }
        : { success: true, data: { items: [{ ...started, event_count: 1 }], next_cursor: null } });
    }));
    view();
    const label = await screen.findByText('Started');
    expect(label).toHaveClass('studio-pill-neutral');
    await userEvent.click(within(label.closest('tr')!).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('former@example.test')).toBeVisible();
    const steps = within(dialog).getByRole('region', { name: 'Operation steps' });
    expect(await within(steps).findByText('Audit records could not be loaded')).toBeVisible();
    fail = false; await userEvent.click(within(steps).getByRole('button', { name: 'Try again' }));
    expect(await within(steps).findByRole('button', { name: /Started/ })).toBeVisible();
  });
});
