import { describe, expect, it, vi } from 'vitest';
import { queryAnalyticsSummary } from './service';
import {
  DOCUMENT,
  forbidAnalyticsNetwork,
  memoryAnalyticsCache,
  NOW,
  SYNTHETIC_TOKEN,
  syntheticAnalyticsApi,
} from './test-support';

forbidAnalyticsNetwork();
function setup() {
  const cache = memoryAnalyticsCache();
  const fetch = syntheticAnalyticsApi([
    { at: '2026-09-21T01:00:00Z', path: '/hello', views: 12 },
  ]);
  return {
    cache,
    input: {
      document: DOCUMENT,
      siteRevision: '0'.repeat(32),
      token: SYNTHETIC_TOKEN,
      hostname: 'example.com',
      timezone: 'UTC',
      period: '7d' as const,
      kv: cache.kv,
      now: NOW,
      fetch,
    },
  };
}
describe('analytics result cache', () => {
  it('scopes totals and rankings to the selected minutes and caches each period separately', async () => {
    const { input } = setup();
    input.fetch = syntheticAnalyticsApi([
      { at: '2026-09-21T11:49:59Z', path: '/older', views: 10, visits: 2 },
      { at: '2026-09-21T11:50:00Z', path: '/start', views: 4, visits: 1 },
      { at: '2026-09-21T12:00:00Z', path: '/recent', views: 12, visits: 3 },
      { at: '2026-09-21T12:19:59Z', path: '/last', views: 6, visits: 1 },
      { at: '2026-09-21T12:20:00Z', path: '/after', views: 100 },
    ]);
    const short = await queryAnalyticsSummary({ ...input, period: '30m' });
    expect(short.total).toEqual({ pageviews: 22, visits: 5 });
    expect(short.daily).toEqual([{ date: '2026-09-21', ...short.total }]);
    expect(short.top_paths).toEqual([
      { value: '/recent', pageviews: 12, visits: 3 },
      { value: '/last', pageviews: 6, visits: 1 },
      { value: '/start', pageviews: 4, visits: 1 },
    ]);
    expect(short.top_referrers).toEqual([{ value: '', ...short.total }]);
    const day = await queryAnalyticsSummary({ ...input, period: '24h' });
    expect(day.total).toEqual({ pageviews: 32, visits: 7 });
    const count = input.fetch.mock.calls.length;
    expect(await queryAnalyticsSummary({ ...input, period: '30m' })).toEqual(
      short,
    );
    expect(await queryAnalyticsSummary({ ...input, period: '24h' })).toEqual(
      day,
    );
    expect(input.fetch).toHaveBeenCalledTimes(count);
  });
  it('returns all 32 calendar dates when a rolling 30-day range crosses spring DST near midnight', async () => {
    const { input } = setup();
    const summary = await queryAnalyticsSummary({
      ...input,
      period: '30d',
      timezone: 'America/New_York',
      now: new Date('2026-04-01T04:30:00Z'),
    });
    expect(summary.from).toBe('2026-03-02T04:30:00.000Z');
    expect(summary.to).toBe('2026-04-01T04:30:00.000Z');
    expect(summary.daily).toHaveLength(32);
    expect(summary.daily[0]!.date).toBe('2026-03-01');
    expect(summary.daily.at(-1)!.date).toBe('2026-04-01');
  });
  it('reuses successful results within a five-minute bucket and fetches after expiry', async () => {
    const { input } = setup();
    const first = await queryAnalyticsSummary(input);
    const count = input.fetch.mock.calls.length;
    expect(
      await queryAnalyticsSummary({
        ...input,
        now: new Date('2026-09-21T12:24:00Z'),
      }),
    ).toEqual(first);
    expect(input.fetch).toHaveBeenCalledTimes(count);
    await queryAnalyticsSummary({
      ...input,
      now: new Date('2026-09-21T12:27:00Z'),
    });
    expect(input.fetch.mock.calls.length).toBeGreaterThan(count);
    expect(input.kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 300 },
    );
  });
  it.each([
    'revision',
    'siteRevision',
    'hostname',
    'timezone',
    'period',
  ] as const)('uses a new cache entry after changing %s', async (field) => {
    const { input } = setup();
    await queryAnalyticsSummary(input);
    const count = input.fetch.mock.calls.length;
    const next = { ...input };
    if (field === 'revision')
      next.document = { ...DOCUMENT, revision: 'd'.repeat(32) };
    else if (field === 'siteRevision') next.siteRevision = 'e'.repeat(32);
    else if (field === 'hostname') next.hostname = 'new.example.com';
    else if (field === 'timezone') next.timezone = '+09:00';
    await queryAnalyticsSummary(
      field === 'period' ? { ...next, period: '30d' } : next,
    );
    expect(input.fetch.mock.calls.length).toBeGreaterThan(count);
  });
  it('returns fresh data despite cache read and write failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { input } = setup();
    input.kv = {
      get: vi.fn().mockRejectedValue(new Error('read')),
      put: vi.fn().mockRejectedValue(new Error('write')),
    } as unknown as KVNamespace;
    await expect(queryAnalyticsSummary(input)).resolves.toMatchObject({
      total: { pageviews: 12 },
    });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
  it('fetches again when the cached document does not match the requested range', async () => {
    const { input, cache } = setup();
    const first = await queryAnalyticsSummary(input);
    const key = [...cache.values.keys()][0]!;
    cache.values.set(key, { ...first, period: '30d' });
    const count = input.fetch.mock.calls.length;
    await queryAnalyticsSummary(input);
    expect(input.fetch.mock.calls.length).toBeGreaterThan(count);
  });
  it('does not cache failed requests as successful empty statistics', async () => {
    const { input } = setup();
    input.fetch.mockRejectedValue(new Error('Provider unavailable'));
    await expect(queryAnalyticsSummary(input)).rejects.toMatchObject({
      code: 'ANALYTICS_UNAVAILABLE',
    });
    expect(input.kv.put).not.toHaveBeenCalled();
  });
});
