import { afterEach, beforeEach, vi } from 'vitest';
import type { AnalyticsSettingsDocument } from '../../../contracts/analytics';

export const SYNTHETIC_TOKEN = 'synthetic-analytics-token';
export const SYNTHETIC_ACCOUNT = 'a'.repeat(32);
export const SYNTHETIC_SITE = 'b'.repeat(32);
export const NOW = new Date('2026-09-21T12:22:00Z');
export const DOCUMENT: AnalyticsSettingsDocument = {
  settings: {
    enabled: true,
    account_id: SYNTHETIC_ACCOUNT,
    site_tag: SYNTHETIC_SITE,
  },
  token_configured: true,
  configured: true,
  revision: 'c'.repeat(32),
  updated_at_iso: NOW.toISOString(),
};

/** Analytics tests must inject the synthetic provider; any implicit network call is a failure. */
export function forbidAnalyticsNetwork() {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected live network request in analytics test.');
      }),
    );
  });
  afterEach(() => {
    expectNoNetwork();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
function expectNoNetwork() {
  if (
    vi.isMockFunction(globalThis.fetch) &&
    vi.mocked(globalThis.fetch).mock.calls.length > 0
  ) {
    throw new Error(
      'An analytics test attempted to use the real network path.',
    );
  }
}

type SyntheticPageview = {
  at: string;
  path: string;
  views?: number;
  visits?: number;
  referrer?: string;
  host?: string;
  site?: string;
  bot?: number;
};
export function syntheticAnalyticsApi(
  events: SyntheticPageview[] = [],
  limits = {
    enabled: true,
    maxDuration: 31 * 86_400,
    maxPageSize: 1000,
    notOlderThan: 180 * 86_400,
  },
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (
      String(url) !== 'https://api.cloudflare.com/client/v4/graphql' ||
      new Headers(init?.headers).get('Authorization') !==
        `Bearer ${SYNTHETIC_TOKEN}`
    ) {
      throw new Error('Unexpected synthetic Analytics request.');
    }
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data: Record<string, unknown> = {};
    if (query.includes('settings {'))
      data.settings = { rumPageloadEventsAdaptiveGroups: limits };
    else {
      const starts = [
        ...query.matchAll(/(q\d+): rumPageloadEventsAdaptiveGroups/g),
      ];
      if (starts.length === 0) throw new Error('Unexpected GraphQL query.');
      for (let index = 0; index < starts.length; index += 1) {
        const match = starts[index]!;
        const selection = query.slice(match.index, starts[index + 1]?.index);
        const field = (name: string) => {
          const value = new RegExp(`${name}: ("(?:[^"\\\\]|\\\\.)*")`).exec(
            selection,
          )?.[1];
          return value === undefined
            ? undefined
            : (JSON.parse(value) as string);
        };
        const from = field('datetime_geq');
        const to = field('datetime_lt');
        if (!from || !to || !field('requestHost') || !field('siteTag'))
          throw new Error('Missing Analytics scope.');
        if (Date.parse(to) - Date.parse(from) > limits.maxDuration * 1000)
          throw new Error('Unsplit query exceeds synthetic limit.');
        const dimension = selection.includes('value: requestPath')
          ? 'path'
          : selection.includes('value: refererHost')
            ? 'referrer'
            : null;
        const cursor = field(
          dimension === 'path' ? 'requestPath_gt' : 'refererHost_gt',
        );
        const groups = new Map<
          string,
          {
            count: number;
            sum: { visits: number };
            dimensions?: { value: string };
            avg: { sampleInterval: number };
          }
        >();
        for (const event of events) {
          if (
            Date.parse(event.at) < Date.parse(from) ||
            Date.parse(event.at) >= Date.parse(to) ||
            (event.host ?? 'example.com') !== field('requestHost') ||
            (event.site ?? SYNTHETIC_SITE) !== field('siteTag') ||
            event.bot
          )
            continue;
          const key =
            dimension === 'path'
              ? event.path
              : dimension === 'referrer'
                ? (event.referrer ?? '')
                : '';
          if (cursor !== undefined && key <= cursor) continue;
          const row = groups.get(key) ?? {
            count: 0,
            sum: { visits: 0 },
            ...(dimension ? { dimensions: { value: key } } : {}),
            avg: { sampleInterval: 10 },
          };
          row.count += event.views ?? 1;
          row.sum.visits += event.visits ?? 1;
          groups.set(key, row);
        }
        const values = [...groups.values()].sort((a, b) =>
          selection.includes('count_DESC')
            ? b.count - a.count
            : (a.dimensions?.value ?? '') < (b.dimensions?.value ?? '')
              ? -1
              : 1,
        );
        const limit = Number(/limit: (\d+)/u.exec(selection)![1]);
        data[match[1]!] = values.slice(0, limit);
      }
    }
    return Response.json({ data: { viewer: { accounts: [data] } } });
  });
}

export function memoryAnalyticsCache() {
  const values = new Map<string, unknown>();
  return {
    values,
    kv: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, JSON.parse(value));
      }),
    } as unknown as KVNamespace,
  };
}
