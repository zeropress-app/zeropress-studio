import type { AnalyticsSettingsDocument } from '../../contracts/analytics';
import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_INITIAL_REVISION,
} from '../../contracts/analytics';
import {
  GENERAL_SETTINGS_DEFAULTS,
  GENERAL_SETTINGS_INITIAL_REVISION,
} from '../../contracts/general-settings';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.use({ studioProfile: 'operational' });

test('connects synthetic analytics, retries failures and presents localized traffic on mobile', async ({
  page,
  studioRuntime,
  context,
}) => {
  const unexpected: string[] = [];
  const periods: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let nextSummaryFails = false;
  let settings: AnalyticsSettingsDocument = {
    settings: { ...ANALYTICS_DEFAULTS },
    token_configured: false,
    configured: false,
    revision: ANALYTICS_INITIAL_REVISION,
    updated_at_iso: null,
  };
  // Every Analytics endpoint stays in this synthetic browser API. Unrecognized
  // calls fail the test instead of reaching the Worker or a Cloudflare account.
  await context.route(
    /^https:\/\/(?:api|dash)\.cloudflare\.com\//,
    async (route) => {
      unexpected.push(route.request().url());
      await route.abort();
    },
  );
  await page.route(
    /\/api\/(?:analytics(?:\/|\?)|settings\/analytics(?:\/|\?|$))/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.pathname === '/api/settings/analytics' &&
        request.method() === 'GET'
      ) {
        await route.fulfill({ json: { success: true, data: settings } });
      } else if (
        url.pathname === '/api/settings/analytics' &&
        request.method() === 'PUT'
      ) {
        const body = request.postDataJSON();
        updates.push(body);
        expect(request.headers()['x-zeropress-csrf']).toBeTruthy();
        settings = {
          settings: body.settings,
          token_configured: true,
          configured: true,
          revision: 'c'.repeat(32),
          updated_at_iso: '2026-09-21T12:00:00Z',
        };
        await route.fulfill({ json: { success: true, data: settings } });
      } else if (
        url.pathname === '/api/settings/analytics/test-connection' &&
        request.method() === 'POST'
      ) {
        expect(request.postDataJSON().credential).toBe(
          'synthetic-analytics-token',
        );
        await route.fulfill({
          json: { success: true, data: { status: 'no_data' } },
        });
      } else if (
        url.pathname === '/api/analytics/summary' &&
        request.method() === 'GET'
      ) {
        const period = url.searchParams.get('period');
        periods.push(period ?? '');
        if (!settings.configured || nextSummaryFails) {
          const code = nextSummaryFails
            ? 'ANALYTICS_UNAVAILABLE'
            : 'ANALYTICS_NOT_CONFIGURED';
          nextSummaryFails = false;
          await route.fulfill({
            status: 503,
            json: { success: false, error: { code } },
          });
          return;
        }
        const ranges: Record<
          string,
          { from: string; firstDay: number; days: number }
        > = {
          '24h': { from: '2026-09-20T12:20:00Z', firstDay: 20, days: 2 },
          '7d': { from: '2026-09-14T12:20:00Z', firstDay: 14, days: 8 },
          '30m': { from: '2026-09-21T11:50:00Z', firstDay: 21, days: 1 },
        };
        const range = ranges[period ?? ''];
        if (!range) {
          unexpected.push(request.url());
          await route.abort();
          return;
        }
        const daily = Array.from({ length: range.days }, (_, index) => ({
          date: new Date(Date.UTC(2026, 8, range.firstDay + index))
            .toISOString()
            .slice(0, 10),
          pageviews: 200 + index * 10,
          visits: 50 + index * 3,
        }));
        await route.fulfill({
          json: {
            success: true,
            data: {
              period,
              hostname: 'example.com',
              timezone: 'Asia/Seoul',
              from: range.from,
              to: '2026-09-21T12:20:00Z',
              generated_at_iso: '2026-09-21T12:22:00Z',
              total: daily.reduce(
                (total, day) => ({
                  pageviews: total.pageviews + day.pageviews,
                  visits: total.visits + day.visits,
                }),
                { pageviews: 0, visits: 0 },
              ),
              daily,
              top_paths: [
                { value: '/journal/hello/', pageviews: 90, visits: 32 },
              ],
              top_referrers: [
                { value: 'search.example', pageviews: 60, visits: 20 },
                { value: '', pageviews: 40, visits: 15 },
              ],
            },
          },
        });
      } else {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.abort();
      }
    },
  );
  await page.route('**/api/settings/general', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          settings: {
            ...GENERAL_SETTINGS_DEFAULTS,
            url: 'https://example.com',
            timezone: 'Asia/Seoul',
          },
          revision: GENERAL_SETTINGS_INITIAL_REVISION,
          updated_at_iso: null,
        },
      },
    }),
  );

  await page.route('**/api/system/interface-config', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { default_locale: 'en', enabled_locales: ['en', 'ko'] },
      },
    }),
  );

  await signInAsAdministrator(page, studioRuntime);
  await page
    .getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Analytics', exact: true })
    .click();
  await expect(page.getByText('Analytics is not connected')).toBeVisible();
  await page.getByRole('link', { name: 'Open settings' }).click();
  const dashboardUrl = `https://dash.cloudflare.com/${'a'.repeat(32)}/web-analytics/overview?siteTag~in=${'b'.repeat(32)}`;
  await expect(
    page.getByRole('link', { name: 'Select site in Cloudflare' }),
  ).toHaveAttribute('target', '_blank');
  await page
    .getByLabel('Web Analytics URL')
    .fill(`${dashboardUrl}&excludeBots=Yes`);
  await expect(page.getByLabel('Account ID')).toHaveValue('a'.repeat(32));
  await expect(page.getByLabel('Site Tag')).toHaveValue('b'.repeat(32));
  await expect(page.getByLabel('Account ID')).toHaveAttribute('readonly', '');
  const inputMode = page.getByRole('switch', { name: 'Enter IDs manually' });
  await inputMode.focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Account ID')).toBeEditable();
  await expect(page.getByLabel('Site Tag')).toBeEditable();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Web Analytics URL')).toHaveValue(dashboardUrl);
  const createToken = page.getByRole('link', {
    name: 'Create API Token in Cloudflare',
  });
  await expect(createToken).toHaveAttribute('target', '_blank');
  await page.getByLabel('API Token', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(createToken).toBeFocused();
  await page
    .getByLabel('API Token', { exact: true })
    .fill('synthetic-analytics-token');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByText(/API query succeeded, but no traffic/),
  ).toBeVisible();
  await page.getByRole('switch', { name: 'Enable analytics' }).check();
  await page.getByRole('button', { name: 'Save analytics settings' }).click();
  await expect(page.getByText('Analytics settings saved.')).toBeVisible();
  await expect(page.getByLabel('API Token', { exact: true })).toHaveValue('');
  expect(updates).toHaveLength(1);
  expect(updates[0]).toEqual({
    settings: {
      enabled: true,
      account_id: 'a'.repeat(32),
      site_tag: 'b'.repeat(32),
    },
    credential: { action: 'replace', value: 'synthetic-analytics-token' },
    expected_revision: ANALYTICS_INITIAL_REVISION,
  });

  await page
    .getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Analytics', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Page views', exact: true }),
  ).toContainText('410');
  await expect(page.getByRole('combobox', { name: 'Period' })).toHaveValue(
    '24h',
  );
  await expect(
    page.getByRole('link', { name: '/journal/hello/' }),
  ).toHaveAttribute('href', 'https://example.com/journal/hello/');
  await page.getByText('View daily values').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('cell', { name: '210', exact: true }),
  ).toBeVisible();
  await page.getByText('View daily values').press('Enter');

  nextSummaryFails = true;
  await page.getByRole('combobox', { name: 'Period' }).selectOption('7d');
  await expect(
    page.getByText(
      'Cloudflare Web Analytics is temporarily unavailable. Try again later.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('region', { name: 'Page views', exact: true }),
  ).toContainText('1,880');
  await page.getByRole('combobox', { name: 'Period' }).selectOption('30m');
  await expect(
    page.getByRole('region', { name: 'Page views', exact: true }),
  ).toContainText('200');
  await expect(
    page.getByRole('img', { name: 'Page views by day' }).locator('circle'),
  ).toBeVisible();
  expect(periods).toEqual(['24h', '24h', '7d', '7d', '30m']);

  await page
    .getByRole('button', { name: 'Open account menu for Studio E2E Owner' })
    .click();
  await page.getByRole('link', { name: 'Studio preferences' }).click();
  await page.getByLabel('Studio interface language').selectOption('ko');
  await page
    .getByRole('navigation', { name: 'Studio 내비게이션' })
    .getByRole('link', { name: '방문 통계', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '방문 통계', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('combobox', { name: '기간' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '기간' })).toHaveValue('24h');
  await page.getByRole('button', { name: '방문 수', exact: true }).click();
  await expect(page.getByRole('img', { name: '일별 방문 수' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('link', { name: '연결 설정' }).click();
  await expect(page.getByLabel('Web Analytics URL')).toHaveValue(dashboardUrl);
  await expect(
    page.getByRole('switch', { name: 'ID 직접 입력' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('link', { name: 'Cloudflare에서 사이트 선택' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Cloudflare에서 API Token 만들기' }),
  ).toBeVisible();
  await expect(page.getByLabel('Account ID')).toHaveAttribute('readonly', '');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(unexpected).toEqual([]);
});
