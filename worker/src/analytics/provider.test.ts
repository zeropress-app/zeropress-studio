import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsProvider } from './provider';
import { analyticsWindow } from './window';
import {
  forbidAnalyticsNetwork,
  NOW,
  SYNTHETIC_ACCOUNT,
  SYNTHETIC_SITE,
  SYNTHETIC_TOKEN,
  syntheticAnalyticsApi,
} from './test-support';

forbidAnalyticsNetwork();
const configuration = {
  accountId: SYNTHETIC_ACCOUNT,
  siteTag: SYNTHETIC_SITE,
  token: SYNTHETIC_TOKEN,
  hostname: 'example.com',
};
const days = analyticsWindow(NOW, '7d', 'UTC').days;
describe('Cloudflare analytics queries', () => {
  it('batches daily totals, scopes the site and host, and uses estimates without multiplying them', async () => {
    const fetch = syntheticAnalyticsApi([
      {
        at: '2026-09-21T10:00:00Z',
        path: '/post',
        views: 20,
        visits: 8,
        referrer: 'search.example',
      },
      {
        at: '2026-09-21T10:00:00Z',
        path: '/admin',
        host: 'studio.example.com',
        views: 100,
      },
      { at: '2026-09-21T10:00:00Z', path: '/other', site: 'x', views: 100 },
      { at: '2026-09-21T10:00:00Z', path: '/bot', bot: 1, views: 100 },
      { at: '2026-09-21T12:20:00Z', path: '/outside' },
    ]);
    const result = await createAnalyticsProvider(configuration, {
      fetch,
      now: NOW,
    }).summary(days);
    expect(result.total).toEqual({ pageviews: 20, visits: 8 });
    expect(result.daily.at(-1)).toEqual({
      date: '2026-09-21',
      pageviews: 20,
      visits: 8,
    });
    expect(result.top_paths).toEqual([
      { value: '/post', pageviews: 20, visits: 8 },
    ]);
    expect(result.top_referrers[0]!.value).toBe('search.example');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('merges complete paginated breakdowns across limited windows before ranking', async () => {
    const events = days.flatMap((day) => [
      { at: day.from, path: '/steady', views: 3 },
      ...Array.from({ length: 10 }, (_, index) => ({
        at: day.from,
        path: `/${day.date}-${index}`,
        views: 4 + index,
      })),
    ]);
    const fetch = syntheticAnalyticsApi(events, {
      enabled: true,
      maxDuration: 86400,
      maxPageSize: 2,
      notOlderThan: 180 * 86400,
    });
    const result = await createAnalyticsProvider(configuration, {
      fetch,
      now: NOW,
    }).summary(days);
    expect(result.top_paths[0]).toEqual({
      value: '/steady',
      pageviews: 24,
      visits: 8,
    });
    expect(result.top_paths).toHaveLength(10);
    expect(result.total.pageviews).toBe(
      events.reduce((sum, event) => sum + event.views, 0),
    );
    expect(result.top_referrers).toEqual([
      { value: '', pageviews: result.total.pageviews, visits: 88 },
    ]);
  });
  it('reports a successful empty connection without claiming that collection works', async () => {
    const provider = createAnalyticsProvider(configuration, {
      fetch: syntheticAnalyticsApi(),
      now: NOW,
    });
    await expect(provider.testConnection()).resolves.toEqual({
      status: 'no_data',
    });
  });
  it.each([
    [401, {}, 'ANALYTICS_AUTHENTICATION_FAILED'],
    [403, {}, 'ANALYTICS_AUTHENTICATION_FAILED'],
    [429, {}, 'ANALYTICS_QUERY_LIMITED'],
    [503, {}, 'ANALYTICS_UNAVAILABLE'],
    [
      200,
      { errors: [{ message: 'not authorized for the account' }] },
      'ANALYTICS_AUTHENTICATION_FAILED',
    ],
    [
      200,
      { errors: [{ message: 'query time range limit exceeded' }] },
      'ANALYTICS_QUERY_LIMITED',
    ],
    [200, {}, 'ANALYTICS_RESPONSE_INVALID'],
  ])(
    'classifies status %s without exposing provider responses',
    async (status, body, code) => {
      const fetch = vi.fn(async () => Response.json(body, { status }));
      await expect(
        createAnalyticsProvider(configuration, { fetch, now: NOW }).summary(
          days,
        ),
      ).rejects.toMatchObject({ code, message: code });
    },
  );
  it('rejects incomplete group data instead of treating missing metrics as zero', async () => {
    const api = syntheticAnalyticsApi();
    const fetch = vi.fn(async (...args: Parameters<typeof api>) => {
      if (api.mock.calls.length === 0) return api(...args);
      return Response.json({
        data: { viewer: { accounts: [{ q0: [{ count: 10 }] }] } },
      });
    });
    await expect(
      createAnalyticsProvider(configuration, { fetch, now: NOW }).summary(days),
    ).rejects.toMatchObject({ code: 'ANALYTICS_RESPONSE_INVALID' });
  });
  it('refuses a period outside retention rather than returning partial totals', async () => {
    const fetch = syntheticAnalyticsApi([], {
      enabled: true,
      maxDuration: 86400,
      maxPageSize: 100,
      notOlderThan: 86400,
    });
    await expect(
      createAnalyticsProvider(configuration, { fetch, now: NOW }).summary(days),
    ).rejects.toMatchObject({ code: 'ANALYTICS_QUERY_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts outbound requests using the shared deadline signal', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_url: unknown, options?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const pending = createAnalyticsProvider(configuration, {
      fetch,
      signal: controller.signal,
    }).summary(days);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'ANALYTICS_UNAVAILABLE',
    });
  });
});
