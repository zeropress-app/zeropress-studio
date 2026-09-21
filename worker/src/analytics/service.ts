import {
  analyticsSummarySchema,
  type AnalyticsPeriod,
  type AnalyticsSettingsDocument,
} from '../../../contracts/analytics';
import { logOperationalFailure } from '../lib/operational-error';
import { createAnalyticsProvider } from './provider';
import { analyticsWindow, ANALYTICS_CACHE_SECONDS } from './window';

export async function queryAnalyticsSummary(input: {
  document: AnalyticsSettingsDocument;
  siteRevision: string;
  token: string;
  hostname: string;
  timezone: string;
  period: AnalyticsPeriod;
  kv: KVNamespace;
  now: Date;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) {
  const window = analyticsWindow(input.now, input.period, input.timezone);
  const identity = {
    revision: input.document.revision,
    siteRevision: input.siteRevision,
    account: input.document.settings.account_id,
    site: input.document.settings.site_tag,
    hostname: input.hostname,
    timezone: input.timezone,
    period: input.period,
    from: window.from,
    to: window.to,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(identity)),
  );
  const key = `analytics:v1:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  try {
    const cached: unknown = await input.kv.get(key, 'json');
    if (cached !== null) {
      const parsed = analyticsSummarySchema.safeParse(cached);
      if (
        parsed.success &&
        parsed.data.hostname === input.hostname &&
        parsed.data.timezone === input.timezone &&
        parsed.data.period === input.period &&
        parsed.data.from === window.from &&
        parsed.data.to === window.to &&
        parsed.data.daily.length === window.days.length &&
        parsed.data.daily.every(
          (day, index) => day.date === window.days[index]!.date,
        ) &&
        Date.parse(parsed.data.generated_at_iso) <= input.now.getTime() &&
        Date.parse(parsed.data.generated_at_iso) >
          input.now.getTime() - ANALYTICS_CACHE_SECONDS * 1000
      ) {
        return parsed.data;
      }
    }
  } catch (cause) {
    logOperationalFailure('ANALYTICS_CACHE_FAILED', {
      cause,
      metadata: { resource: 'KV', action: 'read_analytics_cache' },
    });
  }
  const provider = createAnalyticsProvider(
    {
      accountId: input.document.settings.account_id,
      siteTag: input.document.settings.site_tag,
      hostname: input.hostname,
      token: input.token,
    },
    { fetch: input.fetch, now: input.now, signal: input.signal },
  );
  const data = await provider.summary(window.days);
  const summary = analyticsSummarySchema.parse({
    ...data,
    period: input.period,
    hostname: input.hostname,
    timezone: input.timezone,
    from: window.from,
    to: window.to,
    generated_at_iso: input.now.toISOString(),
  });
  try {
    await input.kv.put(key, JSON.stringify(summary), {
      expirationTtl: ANALYTICS_CACHE_SECONDS,
    });
  } catch (cause) {
    logOperationalFailure('ANALYTICS_CACHE_FAILED', {
      cause,
      metadata: { resource: 'KV', action: 'write_analytics_cache' },
    });
  }
  return summary;
}
