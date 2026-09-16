import type { ReactNode } from 'react';
import type { SupportedLocale } from '../i18n/locale';
import { AuthFrameChrome } from './AuthFrameChrome';

export type StandaloneStatusTone =
  | 'neutral'
  | 'info'
  | 'warning'
  | 'error';

/**
 * Standalone status screen outside the login, installation, and regular Studio shells.
 *
 * System lifecycle, public account setup, and Operations share the same branded chrome and
 * left-aligned layout. Callers own domain-state decisions and actions; this component owns
 * presentation.
 */
export function StandaloneStatusScreen(input: {
  regionLabel: string;
  brandLabel: string;
  kicker?: string;
  title: string;
  description?: string;
  tone?: StandaloneStatusTone;
  pending?: boolean;
  wide?: boolean;
  leading?: ReactNode;
  children?: ReactNode;
  localeLabel?: string;
  availableLocales?: readonly SupportedLocale[];
}) {
  const tone = input.tone ?? 'neutral';

  return (
    <main
      className={`auth-shell${input.pending ? ' auth-shell-pending' : ''}`}
      aria-busy={input.pending || undefined}
    >
      <section
        className={`standalone-status standalone-status-${tone}${input.wide
          ? ' standalone-status-wide'
          : ''}`}
        aria-label={input.regionLabel}
      >
        <AuthFrameChrome
          brandLabel={input.brandLabel}
          localeLabel={input.localeLabel}
          availableLocales={input.availableLocales}
        />
        <div className="standalone-status-body">
          {input.leading ? (
            <div className="standalone-status-leading" aria-hidden="true">
              {input.leading}
            </div>
          ) : null}
          <header
            className="standalone-status-heading"
            role={tone === 'error' ? 'alert' : 'status'}
            aria-live={input.pending ? 'polite' : undefined}
            aria-atomic="true"
          >
            {input.kicker ? (
              <p className="auth-kicker">{input.kicker}</p>
            ) : null}
            <h1 className="setup-title">{input.title}</h1>
            {input.description ? (
              <p className="setup-description">{input.description}</p>
            ) : null}
          </header>
          {input.children ? (
            <div className="standalone-status-content">{input.children}</div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
