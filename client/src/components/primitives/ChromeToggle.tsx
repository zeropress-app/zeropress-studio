import type { ReactNode } from 'react';

/**
 * Compact icon action for pre-authentication screens or the topbar.
 *
 * Shares ChromeSelect's height, border, and surface while retaining button semantics. Name the
 * action by its result so assistive technology and the native tooltip describe the same behavior.
 */
export function ChromeToggle(input: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="studio-chrome-toggle"
      type="button"
      aria-label={input.label}
      title={input.label}
      onClick={input.onClick}
    >
      {input.icon}
    </button>
  );
}
