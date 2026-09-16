import type { SupportedLocale } from '../i18n/locale';
import { LocaleSwitcher } from './LocaleSwitcher';
import { LogoBadge } from './LogoBadge';
import { ThemeToggle } from './ThemeToggle';

/**
 * System status and account setup share a compact, in-flow frame header.
 * Keeping the brand and locale controls in normal document flow prevents
 * them from covering translated or zoomed content.
 */
export function AuthFrameChrome(input: {
  brandLabel: string;
  localeLabel?: string;
  availableLocales?: readonly SupportedLocale[];
}) {
  return (
    <div className="auth-frame-chrome">
      <p className="auth-corner-brand">
        <LogoBadge />
        <span className="auth-corner-brand-label">{input.brandLabel}</span>
      </p>
      <div className="auth-frame-controls">
        <ThemeToggle />
        <LocaleSwitcher
          label={input.localeLabel}
          availableLocales={input.availableLocales}
        />
      </div>
    </div>
  );
}
