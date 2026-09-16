import { classNames } from './class-names';

/**
 * List-status filters.
 *
 * These filter the same list rather than switch panels, so use a button group instead of tablist.
 * Announce selection with aria-pressed; aria-current="page" describes navigation and does not
 * apply here.
 *
 * Optional counts stay inside each button so the label and count form one accessible name.
 */
export function FilterTabs<Value extends string>(input: {
  /** Translated group name. */
  label: string;
  value: Value;
  items: readonly {
    value: Value;
    /** Translated label. */
    label: string;
    count?: number;
  }[];
  onChange: (value: Value) => void;
  /** Visual variant for list toolbars. Semantics and keyboard behavior remain the same. */
  appearance?: 'pills' | 'underline';
}) {
  return (
    <div
      className={classNames(
        'studio-filter-tabs',
        input.appearance === 'underline' && 'studio-filter-tabs-underline',
      )}
      role="group"
      aria-label={input.label}
    >
      {input.items.map((item) => {
        const selected = item.value === input.value;
        return (
          <button
            key={item.value}
            type="button"
            className={classNames(
              'studio-filter-tab',
              selected && 'studio-filter-tab-selected',
            )}
            aria-pressed={selected}
            aria-label={item.count === undefined
              ? undefined
              : `${item.label} ${item.count}`}
            onClick={() => input.onChange(item.value)}
          >
            <span className="studio-filter-tab-label">{item.label}</span>
            {item.count === undefined ? null : (
              <span className="studio-filter-tab-count">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
