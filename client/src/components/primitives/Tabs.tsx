import {
  useId,
  useRef,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { StudioIcon } from './StudioIcon';
import { classNames } from './class-names';

/**
 * Tabs that switch content panels.
 *
 * Use the ARIA tabs pattern for distinct views; FilterTabs handles filtering a single list. Render
 * the tab list and panel together to connect the panel's aria-labelledby to the selected tab.
 *
 * Keyboard:
 * - ArrowLeft / ArrowRight: focus and select the previous / next tab.
 * - Home / End: select the first / last tab.
 * - Tab: leave the tab list for the panel using roving tabindex.
 */
export function Tabs<Value extends string>(input: {
  /** Translated tab-list name. */
  label: string;
  value: Value;
  items: readonly {
    value: Value;
    label: string;
    /** Decorative icon and count localized by the caller. */
    icon?: LucideIcon;
    count?: string;
  }[];
  /**
   * Lock navigation away from the current tab, for example while edits are unsaved. Keep the
   * selected tab enabled to preserve roving tabindex; arrow navigation stops because no
   * alternative tab is available.
   */
  disabled?: boolean;
  onChange: (value: Value) => void;
  children: ReactNode;
}) {
  const base = useId().replaceAll(':', '');
  const panelId = `${base}-panel`;
  const tabId = (value: Value) => `${base}-tab-${value}`;
  const listRef = useRef<HTMLDivElement>(null);

  function select(value: Value) {
    input.onChange(value);
    // Arrow navigation moves both selection and focus.
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(value))}`)
      ?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    if (input.disabled) return;
    const { items } = input;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    if (event.key === 'ArrowLeft') {
      next = (index - 1 + items.length) % items.length;
    }
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = items[next];
    if (target) select(target.value);
  }

  return (
    <div className="studio-tabs">
      <div
        ref={listRef}
        className="studio-tablist"
        role="tablist"
        aria-label={input.label}
      >
        {input.items.map((item, index) => {
          const selected = item.value === input.value;
          return (
            <button
              key={item.value}
              id={tabId(item.value)}
              type="button"
              role="tab"
              className={classNames(
                'studio-tab',
                selected && 'studio-tab-selected',
              )}
              aria-selected={selected}
              aria-controls={panelId}
              aria-label={item.count === undefined
                ? undefined
                : `${item.label} ${item.count}`}
              // Keep only the selected tab in the Tab sequence (roving tabindex).
              tabIndex={selected ? 0 : -1}
              disabled={input.disabled && !selected}
              onClick={() => input.onChange(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {item.icon ? <StudioIcon icon={item.icon} className="studio-tab-icon" /> : null}
              <span>{item.label}</span>
              {item.count === undefined ? null : (
                <span className="studio-tab-count">{item.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        className="studio-tabpanel"
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(input.value)}
        // The panel may have no focusable children, so make the panel itself
        // reachable by keyboard.
        tabIndex={0}
      >
        {input.children}
      </div>
    </div>
  );
}
