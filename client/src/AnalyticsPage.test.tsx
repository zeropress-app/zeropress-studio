// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsSummary } from '../../contracts/analytics';
import { AnalyticsPage } from './AnalyticsPage';
import { changeLocale } from './i18n';

const summary: AnalyticsSummary = {
  period: '24h',
  hostname: 'example.com',
  timezone: 'Asia/Seoul',
  from: '2026-09-20T12:20:00Z',
  to: '2026-09-21T12:20:00Z',
  generated_at_iso: '2026-09-21T12:22:00Z',
  total: { pageviews: 120, visits: 60 },
  daily: [{ date: '2026-09-21', pageviews: 120, visits: 60 }],
  top_paths: [{ value: '/hello/', pageviews: 100, visits: 40 }],
  top_referrers: [{ value: 'search.example', pageviews: 50, visits: 20 }],
};

beforeEach(async () => {
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockApi(responses: unknown[]) {
  const api = vi.fn(async (url: string) => {
    if (
      !/^\/api\/analytics\/summary\?period=(30m|6h|12h|24h|3d|7d|14d|21d|30d)$/u.test(
        url,
      ) ||
      responses.length === 0
    ) {
      throw new Error(`Unexpected request in Analytics test: ${url}`);
    }
    return Response.json(responses.shift());
  });
  vi.stubGlobal('fetch', api);
  return api;
}
function view(onSessionEnded = vi.fn()) {
  return render(
    <MemoryRouter>
      <AnalyticsPage onSessionEnded={onSessionEnded} />
    </MemoryRouter>,
  );
}

describe('AnalyticsPage', () => {
  it('shows the target, totals, rankings and keyboard-accessible daily values; changes the period', async () => {
    const api = mockApi([
      { success: true, data: summary },
      { success: true, data: { ...summary, period: '7d' } },
    ]);
    const user = userEvent.setup();
    view();
    expect(await screen.findByText('example.com · Asia/Seoul')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('24h');
    expect(api).toHaveBeenCalledWith(
      '/api/analytics/summary?period=24h',
      expect.any(Object),
    );
    expect(
      within(screen.getByRole('region', { name: 'Page views' })).getByText(
        '120',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: '/hello/' })).toHaveAttribute(
      'href',
      'https://example.com/hello/',
    );
    await user.click(screen.getByRole('button', { name: 'Visits' }));
    expect(screen.getByRole('img', { name: 'Visits by day' })).toBeVisible();
    await user.click(screen.getByText('View daily values'));
    expect(screen.getByText('2026-09-21')).toBeVisible();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Period' }),
      '7d',
    );
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(
        '/api/analytics/summary?period=7d',
        expect.any(Object),
      ),
    );
    expect(await screen.findByText('example.com · Asia/Seoul')).toBeVisible();
  });

  it.each([
    [
      'en',
      'Period',
      [
        'Last 30 minutes',
        'Last 6 hours',
        'Last 12 hours',
        'Last 24 hours',
        'Last 3 days',
        'Last 7 days',
        'Last 2 weeks',
        'Last 21 days',
        'Last 30 days',
      ],
    ],
    [
      'ko',
      '기간',
      [
        '최근 30분',
        '최근 6시간',
        '최근 12시간',
        '최근 24시간',
        '최근 3일',
        '최근 7일',
        '최근 2주',
        '최근 21일',
        '최근 30일',
      ],
    ],
  ] as const)(
    'offers and requests every preset in %s',
    async (locale, label, labels) => {
      await changeLocale(locale);
      const periods = [
        '30m',
        '6h',
        '12h',
        '24h',
        '3d',
        '7d',
        '14d',
        '21d',
        '30d',
      ];
      const api = mockApi([
        { success: true, data: summary },
        ...periods.map((period) => ({
          success: true,
          data: { ...summary, period },
        })),
      ]);
      const user = userEvent.setup();
      view();
      expect(await screen.findByText('example.com · Asia/Seoul')).toBeVisible();
      const select = screen.getByRole('combobox', { name: label });
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(labels);
      for (const period of periods) {
        await user.selectOptions(select, period);
        expect(
          await screen.findByText('example.com · Asia/Seoul'),
        ).toBeVisible();
        expect(api).toHaveBeenLastCalledWith(
          `/api/analytics/summary?period=${period}`,
          expect.any(Object),
        );
        expect(select).toHaveValue(period);
      }
    },
  );

  it('directs an unconnected installation to settings', async () => {
    mockApi([{ success: false, error: { code: 'ANALYTICS_NOT_CONFIGURED' } }]);
    view();
    expect(
      await screen.findByRole('link', { name: 'Open settings' }),
    ).toHaveAttribute('href', '/settings/site/analytics');
  });

  it('shows an upstream failure and retries without presenting a zero-traffic result', async () => {
    mockApi([
      { success: false, error: { code: 'ANALYTICS_QUERY_LIMITED' } },
      { success: true, data: summary },
    ]);
    const user = userEvent.setup();
    view();
    expect(
      await screen.findByText(/exceeded an Analytics limit/),
    ).toBeVisible();
    expect(screen.queryByText('No traffic recorded')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('example.com · Asia/Seoul')).toBeVisible();
  });

  it('renders a genuine empty result in Korean', async () => {
    await changeLocale('ko');
    mockApi([
      {
        success: true,
        data: {
          ...summary,
          total: { pageviews: 0, visits: 0 },
          daily: [],
          top_paths: [],
          top_referrers: [],
        },
      },
    ]);
    view();
    expect(
      await screen.findByRole('region', { name: '방문 수' }),
    ).toHaveTextContent('0');
    expect(screen.getByRole('combobox', { name: '기간' })).toHaveValue('24h');
    expect(
      screen.getAllByText('기록된 방문이 없습니다').length,
    ).toBeGreaterThan(0);
  });

  it('hands an expired session to the authentication flow', async () => {
    mockApi([{ success: false, error: { code: 'AUTHENTICATION_REQUIRED' } }]);
    const ended = vi.fn();
    view(ended);
    await waitFor(() => expect(ended).toHaveBeenCalledOnce());
  });
});
