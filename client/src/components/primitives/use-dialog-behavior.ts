import {
  useEffect,
  useRef,
  type RefObject,
} from 'react';
import { retainBackgroundInert } from './modal-layer';

/**
 * Shared keyboard and focus behavior for modal dialogs.
 *
 * Use the Dialog primitive for new dialogs so all share this hook.
 *
 * Responsibilities:
 * - Move initial focus into the dialog.
 * - Cycle Tab and Shift+Tab inside it.
 * - Close on Escape unless busy.
 * - Lock background scrolling and make the background inert.
 * - Restore the previous focus on closing.
 *
 * Callers must portal the modal into modalLayer(). Background locking makes document.body children
 * inert, so a modal left in the application tree would disable itself.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Element focused immediately before a dialog opens.
 *
 * Reading document.activeElement inside the effect is too late:
 * 1. A screen may apply inert in the opening commit, blurring the trigger to document.body before
 * the effect runs.
 * 2. Conditional mounting runs the hook only after the trigger click.
 *
 * Register tracking once at module load, outside the component lifecycle. Ignore focus falling
 * back to body and focus inside a dialog.
 */
let lastFocusedOutsideDialog: HTMLElement | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Focus displaced to body by inert is not a return target.
    if (target === document.body) return;
    // Focus inside a dialog is not a return target.
    if (target.closest('[role="dialog"]')) return;
    lastFocusedOutsideDialog = target;
  });
}

export function useDialogBehavior(input: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Element to restore focus to when closing.
   *
   * Defaults to the element focused before opening. If that trigger unmounts with a menu, supply a
   * surviving ancestor control so focus does not fall back to body.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}): void {
  const {
    open,
    busy,
    onClose,
    dialogRef,
    initialFocusRef,
    returnFocusRef,
  } = input;

  /**
   * onClose and busy can change on every render. Keeping them in effect dependencies would repeat
   * initial focus placement and disrupt typing. Depend only on open and read the latest callback
   * and busy state through refs.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = lastFocusedOutsideDialog;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Lock the background before moving focus. inert blurs the trigger, but
    // module-level tracking has already captured the return target.
    const releaseBackground = retainBackgroundInert();

    function focusableElements(): HTMLElement[] {
      const container = dialogRef.current;
      if (!container) return [];
      // Do not use offsetParent to determine visibility. Fixed-position elements have
      // a null offsetParent, and every element does in environments without layout.
      // The selector already excludes disabled controls, and conditionally hidden
      // content is not rendered in the DOM.
      return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    }

    const requested = initialFocusRef?.current;
    if (requested) requested.focus();
    else {
      const [first] = focusableElements();
      // If no child is focusable, focus the container so focus cannot remain in the background.
      if (first) first.focus();
      else dialogRef.current?.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      // Initial focus on a title or container with tabindex=-1 must still enter the focus trap.
      // Handle entry in both directions, especially Shift+Tab, so focus cannot escape to the background.
      if (!focusable.some((element) => element === active)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      // Unlock the background before restoring focus. An inert element cannot receive
      // focus, so reversing this order would silently prevent restoration.
      releaseBackground();

      const explicit = returnFocusRef?.current;
      if (explicit?.isConnected) {
        explicit.focus();
        return;
      }
      // If the previously focused element was removed, there is no return target.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    // Depend only on open; read onClose and busy through refs for the reasons above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
