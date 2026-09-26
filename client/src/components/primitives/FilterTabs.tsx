import { Link } from 'react-router';
import { classNames } from './class-names';

/** List filters may navigate to a URL or update local state without changing panels. */
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
  onChange?: (value: Value) => void;
  hrefForValue?: (value: Value) => string;
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
        const contents = (
          <>
            <span className="studio-filter-tab-label">{item.label}</span>
            {item.count === undefined ? null : (
              <span className="studio-filter-tab-count">{item.count}</span>
            )}
          </>
        );
        const className = classNames('studio-filter-tab', selected && 'studio-filter-tab-selected');
        const label = item.count === undefined ? undefined : `${item.label} ${item.count}`;
        if (input.hrefForValue) {
          return (
            <Link
              key={item.value}
              to={input.hrefForValue(item.value)}
              className={className}
              aria-current={selected ? 'page' : undefined}
              aria-label={label}
            >
              {contents}
            </Link>
          );
        }
        return (
          <button
            key={item.value}
            type="button"
            className={className}
            aria-pressed={selected}
            aria-label={label}
            onClick={() => input.onChange?.(item.value)}
          >
            {contents}
          </button>
        );
      })}
    </div>
  );
}
