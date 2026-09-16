import { classNames } from './class-names';

/**
 * Spinning ring for indeterminate progress.
 *
 * The spinner is decorative and always aria-hidden. Callers must provide text and announcements; a
 * spinner alone leaves screen-reader users without progress information.
 *
 * Use it inside another primitive with text or a labeled control such as a button. InlineStatus
 * and RouteLoading own live regions and spacing for their loading contexts.
 *
 * The spinner has no margins. Its container owns spacing through gap so it stays vertically
 * aligned with adjacent text.
 */
export function Spinner(input: {
  /**
   * sm is for buttons and inline text and inherits currentColor so it remains visible on filled
   * buttons.
   *
   * lg introduces a loading section with a title and description. It uses the primary color so
   * progress remains distinct from surrounding supporting text.
   */
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      className={classNames(
        'studio-spinner',
        `studio-spinner-${input.size ?? 'sm'}`,
      )}
      aria-hidden="true"
    />
  );
}
