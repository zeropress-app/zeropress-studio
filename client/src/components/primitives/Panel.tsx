import {
  useId,
  type ReactNode,
} from 'react';
import { classNames } from './class-names';

/**
 * Card-style section.
 *
 * With a title, label the section to create a named landmark. Without a title, use a generic
 * container to avoid an unnamed region.
 */
export function Panel(input: {
  /** Translated title. */
  title?: string;
  /** Translated description. */
  description?: string;
  /** Small label above the title. */
  kicker?: string;
  /** Decorative content supporting the heading. The title still owns the accessible name. */
  leading?: ReactNode;
  /** Actions on the right side of the header. */
  actions?: ReactNode;
  /** Remove body padding when embedding a table directly. */
  flush?: boolean;
  /**
   * split places the title and description in the left column and content in the right, as in
   * settings forms. It becomes stacked on narrow screens.
   */
  layout?: 'stacked' | 'split';
  /**
   * Heading level. Use level 3 only for a section nested inside another section so the document
   * outline preserves containment.
   */
  headingLevel?: 2 | 3;
  /**
   * Separate footer row for supporting text or save actions. A form must wrap Panel when the
   * footer contains its submit button.
   */
  footer?: ReactNode;
  /**
   * Omit to render no body region. Header-only cards, such as navigation cards, then leave no
   * empty padded box.
   */
  children?: ReactNode;
}) {
  const titleId = `${useId().replaceAll(':', '')}-title`;
  const hasHeader = Boolean(input.title ?? input.actions);
  const shell = classNames(
    'studio-panel',
    input.layout === 'split' && 'studio-panel-split',
  );
  const Heading = `h${input.headingLevel ?? 2}` as const;

  const header = hasHeader ? (
    <header className="studio-panel-header">
      <div className="studio-panel-heading">
        {input.leading ? (
          <span className="studio-panel-leading">{input.leading}</span>
        ) : null}
        <div className="studio-panel-heading-copy">
          {input.kicker ? (
            <p className="studio-panel-kicker">{input.kicker}</p>
          ) : null}
          {input.title ? (
            <Heading className="studio-panel-title" id={titleId}>
              {input.title}
            </Heading>
          ) : null}
          {input.description ? (
            <p className="studio-panel-description">{input.description}</p>
          ) : null}
        </div>
      </div>
      {input.actions ? (
        <div className="studio-panel-actions">{input.actions}</div>
      ) : null}
    </header>
  ) : null;

  const body = input.children === undefined ? null : (
    <div
      className={classNames(
        'studio-panel-body',
        input.flush && 'studio-panel-body-flush',
      )}
    >
      {input.children}
    </div>
  );

  const footer = input.footer ? (
    <div className="studio-panel-footer">{input.footer}</div>
  ) : null;

  if (!input.title) {
    return <div className={shell}>{header}{body}{footer}</div>;
  }

  return (
    <section className={shell} aria-labelledby={titleId}>
      {header}
      {body}
      {footer}
    </section>
  );
}
