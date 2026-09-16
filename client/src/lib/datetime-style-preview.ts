import type { OutputSettings } from '../../../contracts/output-settings';

type PreviewDatetimeStyle = OutputSettings['date_style'];

/**
 * Preview the string shape produced by date_style and time_style.
 *
 * Use this browser's locale and timezone. Keeping the preview independent of site locale/timezone
 * preserves the separate revisions of Homepage & output and General Settings.
 *
 * These values are theme preferences in Preview Data. Build Core applies them to initial HTML, but
 * a theme may reformat in the visitor's browser, as the reference theme does. The preview
 * illustrates the format rather than guaranteeing final output; the screen must explain that.
 */

/**
 * Options for Intl.DateTimeFormat.
 *
 * The contract's none means omit the option. Passing dateStyle: 'none' directly would throw
 * RangeError.
 */
export function datetimeStyleOptions(input: {
  dateStyle: PreviewDatetimeStyle;
  timeStyle: PreviewDatetimeStyle;
}): Intl.DateTimeFormatOptions {
  return {
    ...(input.dateStyle === 'none'
      ? {}
      : { dateStyle: input.dateStyle }),
    ...(input.timeStyle === 'none'
      ? {}
      : { timeStyle: input.timeStyle }),
  };
}

export type DatetimeStylePreview =
  /** Both styles are none. The screen must explain that nothing will be displayed. */
  | { kind: 'omitted' }
  | { kind: 'sample'; text: string }
  /** This runtime could not format the value. Omit only the preview. */
  | { kind: 'unavailable' };

export function describeDatetimeStylePreview(input: {
  dateStyle: PreviewDatetimeStyle;
  timeStyle: PreviewDatetimeStyle;
  at?: Date;
}): DatetimeStylePreview {
  if (input.dateStyle === 'none' && input.timeStyle === 'none') {
    // Empty options make Intl return a default date, which would show a date
    // even after the user selected no display.
    return { kind: 'omitted' };
  }

  try {
    const text = new Intl.DateTimeFormat(
      undefined,
      datetimeStyleOptions(input),
    ).format(input.at ?? new Date());
    return text.length > 0
      ? { kind: 'sample', text }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
