import type { ReactNode } from 'react';

/**
 * Compact selector for application chrome.
 *
 * Used in the topbar and corners of pre-authentication screens. Its icon is decorative, so a label
 * is required. Keep that label in the DOM at every width, including when the selected value is
 * visually hidden.
 *
 * The containing screen owns placement through a slot. Centralize the shared language and theme
 * appearance here instead of overriding each control's positioning in its hosts.
 */
export function ChromeSelect(input: {
  /** Translated name, visually hidden but used as the accessible name. */
  label: string;
  /** Decorative SVG icon with aria-hidden. */
  icon: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="studio-chrome-select">
      {input.icon}
      <span className="visually-hidden">{input.label}</span>
      <select
        aria-label={input.label}
        value={input.value}
        onChange={(event) => input.onChange(event.target.value)}
      >
        {input.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
