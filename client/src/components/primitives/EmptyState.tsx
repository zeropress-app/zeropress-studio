import type { ReactNode } from 'react';

/**
 * Empty state.
 *
 * No results is not an error and does not need a live region by default. Enable announce only when
 * emptiness is an action result, such as filtering a list down to zero items.
 */
export function EmptyState(input: {
  /** Translated title. */
  title: string;
  /**
   * Heading level for including the title in the document outline.
   *
   * Use a heading when replacing a table or list as a screen section. Omit it inside a Panel that
   * already has a heading to avoid duplicate outline entries.
   */
  headingLevel?: 2 | 3;
  /** Translated description. */
  description?: string;
  /** Action leading to the next step. */
  actions?: ReactNode;
  /** Announce an empty result of an action through role="status". */
  announce?: boolean;
}) {
  const Heading = input.headingLevel === undefined
    ? 'p'
    : (`h${input.headingLevel}` as const);
  return (
    <div
      className="studio-empty"
      role={input.announce ? 'status' : undefined}
    >
      <Heading className="studio-empty-title">{input.title}</Heading>
      {input.description ? (
        <p className="studio-empty-description">{input.description}</p>
      ) : null}
      {input.actions ? (
        <div className="studio-empty-actions">{input.actions}</div>
      ) : null}
    </div>
  );
}
