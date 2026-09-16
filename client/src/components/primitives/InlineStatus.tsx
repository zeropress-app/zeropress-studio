import { Spinner } from './Spinner';

/**
 * Inline status within an existing screen.
 *
 * Fills the space of a section that is still loading. Spinner is decorative, so include text and a
 * live region to announce progress. This container owns the gap between the spinner and text.
 *
 * Centralize the shared loading pattern previously duplicated across Forms, content media,
 * Newsletters, settings, and Dashboard. Keep the spinner consistent across these waiting states.
 * Use RouteLoading when the whole screen is still empty.
 */
export function InlineStatus(input: {
  /** Translated message. */
  children: string;
  /**
   * Spinner size. Use lg for a spacious loading section and the default for an inline status row.
   */
  size?: 'sm' | 'lg';
}) {
  return (
    <p className="studio-inline-status" role="status">
      <Spinner size={input.size} />
      <span>{input.children}</span>
    </p>
  );
}
