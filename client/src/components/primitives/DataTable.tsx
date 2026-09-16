import type { ReactNode } from 'react';
import { classNames } from './class-names';

/**
 * Table.
 *
 * Use native thead/tbody/th/td elements rather than cell components. Their fixed HTML structure
 * supports descendant styling without depending on arbitrary child positions. The primitive owns
 * horizontal overflow and keyboard access to the scroll region on narrow screens.
 */
export function DataTable(input: {
  /** Translated table description, exposed only to screen readers. */
  caption: string;
  /** Horizontal scrolling begins below this width. */
  minWidthPx?: number;
  /**
   * Stack rows as cards at 640px or below and release colgroup widths.
   *
   * Every td must supply a translated column name in data-label because thead is hidden in stacked
   * mode. Preserve table, row, and cell semantics.
   *
   * In compact mode, identify title, selection, and action cells with
   * data-stack="primary|select|actions". Other cells form a two-column detail grid; wide spans
   * both columns and preview has no label. Hide data-stack-detail="secondary" only on mobile.
   */
  stacked?: boolean | 'compact';
  /** Current-list selection accessible at every width, independent of the hidden thead. */
  selection?: {
    label: string;
    checked: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
  };
  /** List presentation that gives the table and scroll region a shared border. */
  framed?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={classNames(
        'studio-table-scroll',
        input.framed && 'studio-table-scroll-framed',
      )}
      // The horizontal scroll region must support keyboard scrolling (WCAG 2.1.1).
      tabIndex={0}
      role="group"
      aria-label={input.caption}
    >
      {input.selection ? (
        <label className="studio-table-selection">
          <input
            type="checkbox"
            checked={input.selection.checked}
            disabled={input.selection.disabled}
            ref={(element) => {
              if (element) element.indeterminate = input.selection?.indeterminate ?? false;
            }}
            onChange={(event) => input.selection?.onChange(event.target.checked)}
          />
          <span>{input.selection.label}</span>
        </label>
      ) : null}
      <table
        className={classNames(
          'studio-table',
          input.stacked && 'studio-table-stacked',
          input.stacked === 'compact' && 'studio-table-stacked-compact',
        )}
        style={input.minWidthPx
          ? { minWidth: `${input.minWidthPx}px` }
          : undefined}
      >
        <caption className="visually-hidden">{input.caption}</caption>
        {input.children}
      </table>
    </div>
  );
}
