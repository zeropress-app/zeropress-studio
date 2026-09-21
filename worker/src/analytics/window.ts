import type { AnalyticsPeriod } from '../../../contracts/analytics';

export const ANALYTICS_CACHE_SECONDS = 300;
const PERIOD_SECONDS: Record<AnalyticsPeriod, number> = {
  '30m': 30 * 60,
  '6h': 6 * 3600,
  '12h': 12 * 3600,
  '24h': 24 * 3600,
  '3d': 3 * 86400,
  '7d': 7 * 86400,
  '14d': 14 * 86400,
  '21d': 21 * 86400,
  '30d': 30 * 86400,
};
export type AnalyticsInterval = { from: string; to: string };
export type AnalyticsDay = AnalyticsInterval & { date: string };

function dateFormatter(timezone: string): (milliseconds: number) => string {
  const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(timezone);
  if (offset || timezone === 'UTC') {
    const shift = offset
      ? (Number(offset[2]) * 60 + Number(offset[3])) *
        60_000 *
        (offset[1] === '-' ? -1 : 1)
      : 0;
    return (milliseconds) =>
      new Date(milliseconds + shift).toISOString().slice(0, 10);
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    calendar: 'gregory',
    numberingSystem: 'latn',
  });
  return (milliseconds) => {
    const parts = formatter.formatToParts(milliseconds);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
}

/** Locate the first instant of a calendar date, including midnight DST transitions. */
function startOfDate(
  date: string,
  localDate: (milliseconds: number) => string,
): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  let low = utc / 1000 - 36 * 3600;
  let high = utc / 1000 + 36 * 3600;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle * 1000) < date) low = middle + 1;
    else high = middle;
  }
  return low * 1000;
}

export function analyticsWindow(
  now: Date,
  period: AnalyticsPeriod,
  timezone: string,
) {
  const localDate = dateFormatter(timezone);
  const end =
    Math.floor(now.getTime() / (ANALYTICS_CACHE_SECONDS * 1000)) *
    ANALYTICS_CACHE_SECONDS *
    1000;
  const start = end - PERIOD_SECONDS[period] * 1000;
  const firstDate = Date.parse(`${localDate(start)}T00:00:00Z`);
  const lastDate = Date.parse(`${localDate(end - 1)}T00:00:00Z`);
  const days: AnalyticsDay[] = [];
  for (
    let calendarDate = firstDate;
    calendarDate <= lastDate;
    calendarDate += 86_400_000
  ) {
    const date = new Date(calendarDate).toISOString().slice(0, 10);
    const next = new Date(calendarDate + 86_400_000).toISOString().slice(0, 10);
    const dayStart = Math.max(start, startOfDate(date, localDate));
    const dayEnd = Math.min(end, startOfDate(next, localDate));
    if (dayStart >= dayEnd) continue;
    days.push({
      date,
      from: new Date(dayStart).toISOString(),
      to: new Date(dayEnd).toISOString(),
    });
  }
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    days,
  };
}

export function splitAnalyticsInterval(
  interval: AnalyticsInterval,
  seconds: number,
): AnalyticsInterval[] {
  const end = Date.parse(interval.to);
  const result: AnalyticsInterval[] = [];
  for (
    let start = Date.parse(interval.from);
    start < end;
    start += seconds * 1000
  ) {
    result.push({
      from: new Date(start).toISOString(),
      to: new Date(Math.min(end, start + seconds * 1000)).toISOString(),
    });
    if (result.length > 200)
      throw new RangeError('Analytics interval limit exceeded.');
  }
  return result;
}
