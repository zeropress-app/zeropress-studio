import { classNames } from './class-names';

/**
 * Status badge.
 *
 * Tones describe semantic severity. Callers map domain states to tones so adding a state does not
 * require changing the primitive.
 *
 * neutral: draft, disabled, archived, unsubscribed, idle, closed
 * positive: published, approved, active, subscribed, ready, valid
 * attention: pending, needsSetup, unconfigured, missing, review
 * critical: spam, invalid, failed, trash
 */
export type StatusTone = 'neutral' | 'positive' | 'attention' | 'critical';

export function StatusPill(input: {
  tone: StatusTone;
  /** Translated label. */
  children: string;
  /**
   * Translated prefix when the label alone does not identify the status category. Prevents
   * reliance on color alone (WCAG 1.4.1).
   */
  srPrefix?: string;
}) {
  return (
    <span className={classNames('studio-pill', `studio-pill-${input.tone}`)}>
      {input.srPrefix ? (
        <span className="visually-hidden">{`${input.srPrefix} `}</span>
      ) : null}
      {input.children}
    </span>
  );
}
