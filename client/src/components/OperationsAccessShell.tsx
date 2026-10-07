import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseBackup, KeyRound, Settings2, Trash2 } from 'lucide-react';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import { LocaleSwitcher } from './LocaleSwitcher';
import { LogoBadge } from './LogoBadge';
import { ThemeToggle } from './ThemeToggle';
import { StudioIcon } from './primitives';

const OPERATIONS_FEATURES = [
  { key: 'environment', icon: Settings2 },
  { key: 'database', icon: DatabaseBackup },
  { key: 'recovery', icon: KeyRound },
  { key: 'reset', icon: Trash2 },
] as const;

/**
 * Shell for Operations authentication, separate from the regular Studio session.
 *
 * Shares LoginPage's frame and responsive layout. The caller owns the Operations authentication
 * boundary; this shell handles layout and stores no credentials or authentication state.
 */
export function OperationsAccessShell(input: {
  regionLabel: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('operations');

  return (
    <main className="auth-shell auth-shell-login">
      <section
        className="auth-frame auth-frame-login auth-frame-operations"
        aria-label={input.regionLabel}
      >
        <aside className="auth-brand">
          <p className="auth-lockup">
            <LogoBadge />
            <span>
              ZeroPress{' '}
              <strong className="auth-lockup-emphasis">
                Studio
              </strong>
            </span>
          </p>

          <div className="auth-brand-copy">
            <p className="auth-eyebrow">{t('eyebrow')}</p>
            <h1 className="auth-brand-headline">
              {t('unlock.brandHeadline')}
            </h1>
            <p className="auth-brand-description">
              {t('unlock.brandDescription')}
            </p>
            <ul className="operations-access-features">
              {OPERATIONS_FEATURES.map(({ key, icon }) => (
                <li key={key}>
                  <StudioIcon icon={icon} />
                  <span>{t(`unlock.features.${key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div className="auth-form-panel auth-form-panel-login">
          <div className="auth-login-chrome">
            <p className="auth-mobile-brand">
              <LogoBadge />
              <span className="auth-mobile-brand-label">
                ZeroPress{' '}
                <strong className="auth-lockup-emphasis">
                  Studio
                </strong>
              </span>
            </p>
            <div className="auth-login-controls">
              <ThemeToggle />
              <LocaleSwitcher
                label={t('language.label')}
                availableLocales={SUPPORTED_LOCALES}
              />
            </div>
          </div>

          <div className="auth-form-content">
            <header className="auth-form-header">
              <p className="auth-kicker">
                {t('unlock.kicker')}
              </p>
              <h2 className="auth-form-title">
                {t('unlock.title')}
              </h2>
              <p className="auth-form-description">
                {t('unlock.description')}
              </p>
            </header>
            {input.children}
          </div>
        </div>
      </section>
    </main>
  );
}
