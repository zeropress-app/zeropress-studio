import { describe, expect, it } from 'vitest';
import { analyticsWindow, splitAnalyticsInterval } from './window';

describe('analytics relative windows', () => {
  it.each([
    ['30m', 1800],
    ['6h', 21600],
    ['12h', 43200],
    ['24h', 86400],
    ['3d', 259200],
    ['7d', 604800],
    ['14d', 1209600],
    ['21d', 1814400],
    ['30d', 2592000],
  ] as const)(
    'queries exactly %s with contiguous daily intervals',
    (period, seconds) => {
      const window = analyticsWindow(
        new Date('2026-09-21T16:03:25Z'),
        period,
        'Asia/Seoul',
      );
      expect(window.to).toBe('2026-09-21T16:00:00.000Z');
      expect(Date.parse(window.to) - Date.parse(window.from)).toBe(
        seconds * 1000,
      );
      expect(window.days[0]!.from).toBe(window.from);
      expect(window.days.at(-1)!.to).toBe(window.to);
      for (const [index, day] of window.days.entries()) {
        expect(Date.parse(day.to)).toBeGreaterThan(Date.parse(day.from));
        if (index > 0) expect(day.from).toBe(window.days[index - 1]!.to);
      }
      expect(
        analyticsWindow(new Date('2026-09-21T16:04:59Z'), period, 'Asia/Seoul'),
      ).toEqual(window);
    },
  );
  it('clips the first and last calendar days to the selected duration', () => {
    const week = analyticsWindow(
      new Date('2026-09-21T16:03:25Z'),
      '7d',
      'Asia/Seoul',
    );
    expect(week.days.map((day) => day.date)).toEqual([
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ]);
    expect(week.from).toBe('2026-09-14T16:00:00.000Z');
    expect(week.to).toBe('2026-09-21T16:00:00.000Z');
    expect(
      analyticsWindow(new Date('2026-09-21T16:03:25Z'), '30d', 'UTC').days,
    ).toHaveLength(31);
    expect(
      analyticsWindow(new Date('2026-09-21T15:12:00Z'), '30m', '+09:00').days,
    ).toEqual([
      {
        date: '2026-09-21',
        from: '2026-09-21T14:40:00.000Z',
        to: '2026-09-21T15:00:00.000Z',
      },
      {
        date: '2026-09-22',
        from: '2026-09-21T15:00:00.000Z',
        to: '2026-09-21T15:10:00.000Z',
      },
    ]);
  });
  it.each([
    ['2026-03-09T12:00:00Z', 'America/New_York', '2026-03-08', 23],
    ['2026-11-02T12:00:00Z', 'America/New_York', '2026-11-01', 25],
    ['2026-10-05T12:00:00Z', 'Australia/Lord_Howe', '2026-10-04', 23.5],
  ])('preserves DST day lengths for %s in %s', (now, timezone, date, hours) => {
    const day = analyticsWindow(new Date(now), '7d', timezone).days.find(
      (value) => value.date === date,
    )!;
    expect((Date.parse(day.to) - Date.parse(day.from)) / 3_600_000).toBe(hours);
  });
  it('supports fixed minute offsets even during the first cache bucket of a day', () => {
    const window = analyticsWindow(
      new Date('2026-09-21T23:59:30Z'),
      '7d',
      '+00:01',
    );
    expect(window.days.at(-1)).toEqual({
      date: '2026-09-21',
      from: '2026-09-20T23:59:00.000Z',
      to: '2026-09-21T23:55:00.000Z',
    });
    expect(
      analyticsWindow(new Date('2026-09-21T12:00:00Z'), '7d', '-03:30').days[1]!
        .from,
    ).toBe('2026-09-15T03:30:00.000Z');
  });
  it('keeps exactly 24 hours across DST and omits the next day at a midnight endpoint', () => {
    const window = analyticsWindow(
      new Date('2026-03-09T04:00:00Z'),
      '24h',
      'America/New_York',
    );
    expect(window).toEqual({
      from: '2026-03-08T04:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
      days: [
        {
          date: '2026-03-07',
          from: '2026-03-08T04:00:00.000Z',
          to: '2026-03-08T05:00:00.000Z',
        },
        {
          date: '2026-03-08',
          from: '2026-03-08T05:00:00.000Z',
          to: '2026-03-09T04:00:00.000Z',
        },
      ],
    });
  });
  it('splits intervals without overlapping their boundaries', () => {
    expect(
      splitAnalyticsInterval(
        { from: '2026-09-20T00:00:00Z', to: '2026-09-21T03:00:00Z' },
        86400,
      ),
    ).toEqual([
      { from: '2026-09-20T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' },
      { from: '2026-09-21T00:00:00.000Z', to: '2026-09-21T03:00:00.000Z' },
    ]);
  });
});
