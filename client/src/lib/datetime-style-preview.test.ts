import { describe, expect, it } from 'vitest';
import {
  datetimeStyleOptions,
  describeDatetimeStylePreview,
} from './datetime-style-preview';

const AT = new Date('2026-01-15T09:05:00.000Z');

describe('datetimeStyleOptions', () => {
  it('omits the option instead of passing the contract "none" value through', () => {
    // Intl has no none style; passing it directly throws RangeError.
    expect(datetimeStyleOptions({ dateStyle: 'none', timeStyle: 'short' }))
      .toEqual({ timeStyle: 'short' });
    expect(datetimeStyleOptions({ dateStyle: 'long', timeStyle: 'none' }))
      .toEqual({ dateStyle: 'long' });
    expect(datetimeStyleOptions({ dateStyle: 'none', timeStyle: 'none' }))
      .toEqual({});
    expect(datetimeStyleOptions({ dateStyle: 'full', timeStyle: 'medium' }))
      .toEqual({ dateStyle: 'full', timeStyle: 'medium' });
  });

  it('produces options every supported style combination can format with', () => {
    const styles = ['none', 'short', 'medium', 'long', 'full'] as const;
    for (const dateStyle of styles) {
      for (const timeStyle of styles) {
        const options = datetimeStyleOptions({ dateStyle, timeStyle });
        expect(
          () => new Intl.DateTimeFormat('en-US', options).format(AT),
          `${dateStyle}/${timeStyle}`,
        ).not.toThrow();
      }
    }
  });
});

describe('describeDatetimeStylePreview', () => {
  it('reports that both styles set to none render nothing', () => {
    // Empty options make Intl return a default date, which would show a date
    // even after the user selected no display.
    expect(describeDatetimeStylePreview({
      dateStyle: 'none',
      timeStyle: 'none',
      at: AT,
    })).toEqual({ kind: 'omitted' });
  });

  it('distinguishes the shape of each date style', () => {
    const shapes = (['short', 'medium', 'long', 'full'] as const).map(
      (dateStyle) => describeDatetimeStylePreview({
        dateStyle,
        timeStyle: 'none',
        at: AT,
      }),
    );

    for (const shape of shapes) expect(shape.kind).toBe('sample');
    const texts = shapes.map(
      (shape) => shape.kind === 'sample' ? shape.text : '',
    );
    // The preview demonstrates the different shapes of the five choices.
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('includes the time portion only when a time style is selected', () => {
    const dateOnly = describeDatetimeStylePreview({
      dateStyle: 'medium',
      timeStyle: 'none',
      at: AT,
    });
    const withTime = describeDatetimeStylePreview({
      dateStyle: 'medium',
      timeStyle: 'short',
      at: AT,
    });

    expect(dateOnly.kind).toBe('sample');
    expect(withTime.kind).toBe('sample');
    if (dateOnly.kind !== 'sample' || withTime.kind !== 'sample') return;
    expect(withTime.text.length).toBeGreaterThan(dateOnly.text.length);
  });

  it('renders a time-only preview when the date style is none', () => {
    const timeOnly = describeDatetimeStylePreview({
      dateStyle: 'none',
      timeStyle: 'medium',
      at: AT,
    });

    expect(timeOnly.kind).toBe('sample');
    if (timeOnly.kind !== 'sample') return;
    expect(timeOnly.text).not.toContain('2026');
  });

  it('uses the runtime locale and time zone rather than a site setting', () => {
    // The preview does not read the site's locale or timezone, keeping
    // Homepage & output independent of the General Settings document.
    const preview = describeDatetimeStylePreview({
      dateStyle: 'full',
      timeStyle: 'none',
      at: AT,
    });
    const runtime = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
      .format(AT);

    expect(preview).toEqual({ kind: 'sample', text: runtime });
  });
});
