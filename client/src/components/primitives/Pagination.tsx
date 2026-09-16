import { Button } from './Button';

/**
 * Previous/next pagination.
 *
 * Centralizes the layout shared by list screens. Accept an already translated position label. The
 * list owns announcements about updated results, so this component creates no live region.
 */
export function Pagination(input: {
  /** Translated navigation name. */
  label: string;
  /** Translated position label, such as "Page 3 of 12". */
  position: string;
  /** Translated previous-button label. */
  previousLabel: string;
  /** Translated next-button label. */
  nextLabel: string;
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const atFirst = input.page <= 1;
  const atLast = input.page >= input.totalPages;
  return (
    <nav className="studio-pagination" aria-label={input.label}>
      <Button
        type="button"
        size="sm"
        disabled={atFirst}
        onClick={() => input.onChange(Math.max(1, input.page - 1))}
      >
        {input.previousLabel}
      </Button>
      <span className="studio-pagination-position">{input.position}</span>
      <Button
        type="button"
        size="sm"
        disabled={atLast}
        onClick={() => input.onChange(Math.min(input.totalPages, input.page + 1))}
      >
        {input.nextLabel}
      </Button>
    </nav>
  );
}
