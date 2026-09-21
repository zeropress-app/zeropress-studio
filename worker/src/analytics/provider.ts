import { z } from 'zod';
import {
  analyticsMetricsSchema,
  type AnalyticsMetrics,
} from '../../../contracts/analytics';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  splitAnalyticsInterval,
  type AnalyticsDay,
  type AnalyticsInterval,
} from './window';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DATASET = 'rumPageloadEventsAdaptiveGroups';
const REQUEST_BUDGET = 40;
const MAX_GROUPS = 50_000;
const BATCH_SIZE = 5;

export type AnalyticsFailureCode = Extract<
  ApiErrorCode,
  | 'ANALYTICS_AUTHENTICATION_FAILED'
  | 'ANALYTICS_QUERY_LIMITED'
  | 'ANALYTICS_UNAVAILABLE'
  | 'ANALYTICS_RESPONSE_INVALID'
>;
export class AnalyticsFailure extends Error {
  constructor(public readonly code: AnalyticsFailureCode) {
    super(code);
  }
}

const rowSchema = z.object({
  count: analyticsMetricsSchema.shape.pageviews,
  sum: z.object({ visits: analyticsMetricsSchema.shape.visits }),
  dimensions: z.object({ value: z.string() }).optional(),
});
type Row = z.infer<typeof rowSchema>;
const limitsSchema = z.object({
  enabled: z.boolean(),
  maxDuration: z.number().int().positive(),
  maxPageSize: z.number().int().positive(),
  notOlderThan: z.number().int().nonnegative(),
});
type Limits = z.infer<typeof limitsSchema>;
type Configuration = {
  accountId: string;
  siteTag: string;
  hostname: string;
  token: string;
};
type Job = AnalyticsInterval & {
  kind: 'day' | 'path' | 'referrer';
  date?: string;
  cursor?: string;
  complete?: boolean;
};

function invalid(): never {
  throw new AnalyticsFailure('ANALYTICS_RESPONSE_INVALID');
}
function limited(): never {
  throw new AnalyticsFailure('ANALYTICS_QUERY_LIMITED');
}
function metrics(row: Row): AnalyticsMetrics {
  return { pageviews: row.count, visits: row.sum.visits };
}
function add(target: AnalyticsMetrics, value: AnalyticsMetrics) {
  target.pageviews += value.pageviews;
  target.visits += value.visits;
  if (!analyticsMetricsSchema.safeParse(target).success) invalid();
}
function zero(): AnalyticsMetrics {
  return { pageviews: 0, visits: 0 };
}
function quote(value: string): string {
  return JSON.stringify(value);
}

/** One bounded operation shares a deadline and HTTP request budget, including pagination. */
export function createAnalyticsProvider(
  config: Configuration,
  options: {
    fetch?: typeof fetch;
    now?: Date;
    signal?: AbortSignal;
  } = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(25_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const now = options.now ?? new Date();
  let requests = 0;

  async function query(selection: string): Promise<Record<string, unknown>> {
    if (++requests > REQUEST_BUDGET) limited();
    let response: Response;
    let payload: unknown;
    try {
      response = await fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        signal,
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query StudioAnalytics { viewer { accounts(filter: {accountTag: ${quote(config.accountId)}}) { ${selection} } } }`,
        }),
      });
      if (response.status === 401 || response.status === 403)
        throw new AnalyticsFailure('ANALYTICS_AUTHENTICATION_FAILED');
      if (response.status === 429) limited();
      if (response.status >= 500)
        throw new AnalyticsFailure('ANALYTICS_UNAVAILABLE');
      payload = await response.json();
    } catch (error) {
      if (error instanceof AnalyticsFailure) throw error;
      throw new AnalyticsFailure(
        error instanceof SyntaxError
          ? 'ANALYTICS_RESPONSE_INVALID'
          : 'ANALYTICS_UNAVAILABLE',
      );
    }
    const parsed = z
      .object({
        data: z
          .object({
            viewer: z
              .object({
                accounts: z.array(z.record(z.string(), z.unknown())).nullable(),
              })
              .nullable(),
          })
          .nullable()
          .optional(),
        errors: z
          .array(z.object({ message: z.string().optional() }))
          .nullable()
          .optional(),
      })
      .safeParse(payload);
    if (!parsed.success) invalid();
    if (parsed.data.errors?.length) {
      // Provider text is used only for classification; it is never returned or logged.
      const message = parsed.data.errors
        .map((error) => error.message ?? '')
        .join(' ')
        .toLowerCase();
      if (
        /authenticat|not authorized|not authorised|permission|does not have access|access denied|invalid token/u.test(
          message,
        )
      ) {
        throw new AnalyticsFailure('ANALYTICS_AUTHENTICATION_FAILED');
      }
      if (
        /limit|quota|too many|too wide|time range|time window|budget/u.test(
          message,
        )
      )
        limited();
      throw new AnalyticsFailure('ANALYTICS_UNAVAILABLE');
    }
    if (!response.ok) throw new AnalyticsFailure('ANALYTICS_UNAVAILABLE');
    const accounts = parsed.data.data?.viewer?.accounts;
    if (!accounts || accounts.length !== 1) invalid();
    return accounts[0]!;
  }

  async function limits(): Promise<Limits> {
    const account = await query(
      `settings { ${DATASET} { enabled maxDuration maxPageSize notOlderThan } }`,
    );
    const parsed = z
      .object({ [DATASET]: limitsSchema })
      .safeParse(account.settings);
    if (!parsed.success) invalid();
    const result = parsed.data[DATASET]!;
    if (!result.enabled)
      throw new AnalyticsFailure('ANALYTICS_AUTHENTICATION_FAILED');
    return result;
  }

  function split(interval: AnalyticsInterval, maxDuration: number) {
    try {
      return splitAnalyticsInterval(interval, maxDuration);
    } catch {
      return limited();
    }
  }

  function selection(job: Job, alias: string, cap: Limits): string {
    const dimension = job.kind === 'path' ? 'requestPath' : 'refererHost';
    const filter = [
      `datetime_geq: ${quote(job.from)}`,
      `datetime_lt: ${quote(job.to)}`,
      `siteTag: ${quote(config.siteTag)}`,
      `requestHost: ${quote(config.hostname)}`,
      'bot: 0',
      ...(job.cursor !== undefined
        ? [`${dimension}_gt: ${quote(job.cursor)}`]
        : []),
    ].join(', ');
    const limit =
      job.kind === 'day'
        ? 1
        : job.complete
          ? Math.min(cap.maxPageSize, 1000)
          : 10;
    const order =
      job.kind === 'day'
        ? ''
        : `, orderBy: [${job.complete ? `${dimension}_ASC` : 'count_DESC'}]`;
    return `${alias}: ${DATASET}(filter: {${filter}}, limit: ${limit}${order}) {
      count sum { visits } ${job.kind === 'day' ? '' : `dimensions { value: ${dimension} }`}
    }`;
  }

  async function collect(
    days: AnalyticsDay[],
    cap: Limits,
    includeTop: boolean,
  ) {
    const whole = { from: days[0]!.from, to: days.at(-1)!.to };
    if (
      cap.notOlderThan > 0 &&
      Date.parse(whole.from) < now.getTime() - cap.notOlderThan * 1000
    )
      limited();
    const ranges = split(whole, cap.maxDuration);
    const daily = new Map(days.map((day) => [day.date, zero()]));
    const paths = new Map<string, AnalyticsMetrics>();
    const referrers = new Map<string, AnalyticsMetrics>();
    const complete = ranges.length > 1 || cap.maxPageSize < 10;
    const jobs: Job[] = days.flatMap((day) =>
      split(day, cap.maxDuration).map((interval) => ({
        ...interval,
        kind: 'day',
        date: day.date,
      })),
    );
    if (includeTop)
      for (const interval of ranges) {
        jobs.push(
          { ...interval, kind: 'path', complete },
          { ...interval, kind: 'referrer', complete },
        );
      }
    if (jobs.length > REQUEST_BUDGET * BATCH_SIZE) limited();
    let groups = 0;
    while (jobs.length > 0) {
      const batch = jobs.splice(0, BATCH_SIZE);
      const account = await query(
        batch.map((job, index) => selection(job, `q${index}`, cap)).join('\n'),
      );
      batch.forEach((job, index) => {
        const parsed = z.array(rowSchema).safeParse(account[`q${index}`]);
        if (!parsed.success) invalid();
        const rows = parsed.data;
        const pageSize =
          job.kind === 'day'
            ? 1
            : job.complete
              ? Math.min(cap.maxPageSize, 1000)
              : 10;
        if (rows.length > pageSize) invalid();
        groups += rows.length;
        if (groups > MAX_GROUPS) limited();
        if (job.kind === 'day') {
          if (rows[0]) add(daily.get(job.date!)!, metrics(rows[0]));
          return;
        }
        const target = job.kind === 'path' ? paths : referrers;
        let cursor = job.cursor;
        const seen = new Set<string>(cursor === undefined ? [] : [cursor]);
        for (const row of rows) {
          const value = row.dimensions?.value;
          if (
            value === undefined ||
            (job.kind === 'path' && !value.startsWith('/'))
          )
            invalid();
          // The provider owns string collation. Reject repeated groups without assuming JavaScript sort order.
          if (seen.has(value)) invalid();
          seen.add(value);
          cursor = value;
          const current = target.get(value) ?? zero();
          add(current, metrics(row));
          target.set(value, current);
        }
        if (job.complete && rows.length === pageSize)
          jobs.push({ ...job, cursor });
      });
    }
    const total = zero();
    daily.forEach((value) => add(total, value));
    const top = (values: Map<string, AnalyticsMetrics>) =>
      [...values]
        .map(([value, counts]) => ({ value, ...counts }))
        .sort(
          (a, b) =>
            b.pageviews - a.pageviews ||
            (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
        )
        .slice(0, 10);
    return {
      total,
      daily: [...daily].map(([date, value]) => ({ date, ...value })),
      top_paths: top(paths),
      top_referrers: top(referrers),
    };
  }

  return {
    async summary(days: AnalyticsDay[]) {
      return collect(days, await limits(), true);
    },
    async testConnection() {
      const to = now.toISOString();
      const from = new Date(now.getTime() - 86_400_000).toISOString();
      const result = await collect(
        [{ date: to.slice(0, 10), from, to }],
        await limits(),
        false,
      );
      return {
        status:
          result.total.pageviews > 0
            ? ('data_found' as const)
            : ('no_data' as const),
      };
    },
  };
}
