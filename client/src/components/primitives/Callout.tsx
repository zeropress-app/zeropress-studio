import type { ReactNode } from 'react';
import { classNames } from './class-names';
import type { NoticeTone } from './Notice';

/**
 * Emphasized explanatory text.
 *
 * Callout shares Notice's appearance but is not a live region.
 *
 * Notice reports a recent event, such as "Saved" or "Could not save", immediately through
 * role=status or role=alert. Callout describes an ongoing fact, such as "This action ends all
 * other sessions".
 *
 * Putting persistent guidance in Notice announces it whenever the screen opens and competes with
 * actual action-result notices.
 */
export function Callout(input: {
  tone: NoticeTone;
  /** Translated title. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={classNames('studio-callout', `studio-notice-${input.tone}`)}>
      {input.title ? (
        <strong className="studio-callout-title">{input.title}</strong>
      ) : null}
      <div>{input.children}</div>
    </div>
  );
}
