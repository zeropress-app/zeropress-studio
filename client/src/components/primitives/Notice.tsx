import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { classNames } from './class-names';

/**
 * Inline notice.
 *
 * Critical notices use role="alert" for immediate announcements; other tones use role="status" to
 * avoid interrupting the user.
 *
 * Read the tone's announcement prefix from common rather than accepting it from the caller. This
 * prevents callers from repeating the title in the prefix. Screens still own their message text.
 */
export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

export function Notice(input: {
  tone: NoticeTone;
  /** Translated title. Omit to render only the body. */
  title?: string;
  children: ReactNode;
  /** Associated action, such as a retry button. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation('common');
  return (
    <div
      className={classNames('studio-notice', `studio-notice-${input.tone}`)}
      role={input.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="studio-notice-body">
        <span className="visually-hidden">{t(`notice.${input.tone}`)}</span>
        {input.title ? (
          <strong className="studio-notice-title">{input.title}</strong>
        ) : null}
        <div className="studio-notice-content">{input.children}</div>
      </div>
      {input.actions ? (
        <div className="studio-notice-actions">{input.actions}</div>
      ) : null}
    </div>
  );
}
