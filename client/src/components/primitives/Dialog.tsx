import {
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { classNames } from './class-names';
import { modalLayer } from './modal-layer';
import { useDialogBehavior } from './use-dialog-behavior';

/**
 * Modal dialog.
 *
 * Generate title and description IDs internally and connect aria-labelledby/aria-describedby.
 * Callers supply translated text; the primitive owns no user-facing copy.
 *
 * Portal into the modal layer under document.body regardless of the caller's tree position. This
 * lets the layer make the rest of the page inert without requiring callers to manage inert
 * themselves.
 */
export function Dialog(input: {
  open: boolean;
  onClose: () => void;
  /** Translated title. */
  title: string;
  /** Translated description, connected through aria-describedby when present. */
  description?: string;
  /** Small label above the title. */
  kicker?: string;
  /** Prevent Escape and backdrop dismissal while an action is in progress. */
  busy?: boolean;
  size?: 'default' | 'wide' | 'editor';
  backdrop?: 'dim' | 'blur';
  /** Start long read-only content at the title. Defaults to the first focusable element. */
  initialFocus?: 'first-control' | 'title';
  /** Element to focus on opening. Takes precedence over initialFocus. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Element to restore focus to on closing. Set this when the trigger belongs to a menu that
   * disappears as the dialog opens.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  /** Footer actions. Use DialogActions inside children when they must belong to a form. */
  actions?: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const generatedId = useId().replaceAll(':', '');
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;
  const busy = input.busy ?? false;

  useDialogBehavior({
    open: input.open,
    busy,
    onClose: input.onClose,
    dialogRef,
    initialFocusRef: input.initialFocusRef
      ?? (input.initialFocus === 'title' ? titleRef : undefined),
    returnFocusRef: input.returnFocusRef,
  });

  if (!input.open) return null;

  return createPortal((
    <div
      className={classNames(
        'studio-dialog-backdrop',
        input.backdrop === 'blur' && 'studio-dialog-backdrop-blur',
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) input.onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={classNames(
          'studio-dialog',
          input.size === 'wide' && 'studio-dialog-wide',
          input.size === 'editor' && 'studio-dialog-editor',
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={input.description ? descriptionId : undefined}
        tabIndex={-1}
      >
        {input.kicker ? (
          <p className="studio-dialog-kicker">{input.kicker}</p>
        ) : null}
        <h2
          ref={titleRef}
          className="studio-dialog-title"
          id={titleId}
          tabIndex={input.initialFocus === 'title' ? -1 : undefined}
        >{input.title}</h2>
        {input.description ? (
          <p className="studio-dialog-description" id={descriptionId}>
            {input.description}
          </p>
        ) : null}
        {input.children}
        {input.actions ? <DialogActions>{input.actions}</DialogActions> : null}
      </section>
    </div>
  ), modalLayer());
}

/** Dialog footer action row. Place inside children for form submit buttons. */
export function DialogActions(input: { children: ReactNode }) {
  return <div className="studio-dialog-actions">{input.children}</div>;
}
