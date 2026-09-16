import { Spinner } from './Spinner';

/**
 * Placeholder while the route body is loading.
 *
 * Provide a main landmark and the studio-main-content skip-link target even before the screen is
 * ready. role="status" already implies aria-live="polite".
 *
 * Use InlineStatus when only part of an existing screen is loading.
 */
export function RouteLoading(input: {
  /** Translated message. */
  children: string;
}) {
  return (
    <main
      id="studio-main-content"
      className="studio-route-loading"
      role="status"
    >
      <Spinner size="lg" />
      <span>{input.children}</span>
    </main>
  );
}
