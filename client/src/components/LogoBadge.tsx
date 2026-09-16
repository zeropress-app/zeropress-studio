import { LogoMark } from './LogoMark';

/**
 * Product mark for the Studio application chrome.
 *
 * LogoMark and the favicon share one canonical palette across backgrounds and themes. This badge
 * owns the application mark's background and sizing.
 */
export function LogoBadge(input: {
  className?: string;
} = {}) {
  const className = [
    'studio-logo-badge',
    input.className,
  ].filter(Boolean).join(' ');

  return (
    <span className={className} aria-hidden="true">
      <LogoMark />
    </span>
  );
}
