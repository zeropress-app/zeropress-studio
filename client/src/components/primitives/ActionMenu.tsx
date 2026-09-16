import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from './Button';
import { StudioIcon } from './StudioIcon';
import { classNames } from './class-names';

type ActionMenuItemBase = {
  id: string;
  /** Translated menu-item label. */
  label: string;
  icon?: LucideIcon;
  tone?: 'default' | 'critical';
};

export type ActionMenuItem = ActionMenuItemBase & (
  | { kind: 'link'; to: string }
  | { kind: 'button'; onSelect: () => void }
);

type Position = { left: number; top: number };

const VIEWPORT_GUTTER = 8;
const TRIGGER_GAP = 6;

/**
 * Action menu for compact spaces such as table rows.
 *
 * Portal to document.body using viewport coordinates so DataTable's horizontal scroll container
 * does not clip it. Move focus to the first item on opening and handle arrow keys, Home, End,
 * Escape, and outside clicks.
 */
export function ActionMenu(input: {
  /** Translated accessible name for the trigger and menu. */
  label: string;
  items: readonly ActionMenuItem[];
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);
  const menuId = `${useId().replaceAll(':', '')}-menu`;
  const align = input.align ?? 'end';

  useEffect(() => {
    if (input.disabled) setOpen(false);
  }, [input.disabled]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerBounds = trigger.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    let left = align === 'end'
      ? triggerBounds.right - menuBounds.width
      : triggerBounds.left;
    left = Math.min(
      Math.max(VIEWPORT_GUTTER, left),
      Math.max(VIEWPORT_GUTTER, window.innerWidth - menuBounds.width - VIEWPORT_GUTTER),
    );

    let top = triggerBounds.bottom + TRIGGER_GAP;
    if (top + menuBounds.height > window.innerHeight - VIEWPORT_GUTTER) {
      const above = triggerBounds.top - menuBounds.height - TRIGGER_GAP;
      if (above >= VIEWPORT_GUTTER) top = above;
    }
    setPosition({ left, top });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || position === null) return;
    itemRefs.current[0]?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (triggerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnScroll = () => setOpen(false);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open, updatePosition]);

  function openMenu() {
    if (input.disabled) return;
    itemRefs.current = [];
    setPosition(null);
    setOpen(true);
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    event.preventDefault();
    const items = itemRefs.current.filter((item) => item !== null);
    if (items.length === 0) return;
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'Home') {
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      items.at(-1)?.focus();
      return;
    }
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (Math.max(0, activeIndex) + offset + items.length)
      % items.length;
    items[nextIndex]?.focus();
  }

  const menu = open && !input.disabled ? createPortal((
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={input.label}
      className="studio-action-menu-popover"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={handleMenuKeyDown}
    >
      {input.items.map((item, index) => {
        const content = (
          <>
            {item.icon ? (
              <StudioIcon icon={item.icon} className="studio-action-menu-item-icon" />
            ) : null}
            <span>{item.label}</span>
          </>
        );
        const className = classNames(
          'studio-action-menu-item',
          item.tone === 'critical' && 'studio-action-menu-item-critical',
        );
        if (item.kind === 'link') {
          return (
            <Link
              key={item.id}
              ref={(element) => { itemRefs.current[index] = element; }}
              role="menuitem"
              className={className}
              to={item.to}
              onClick={() => setOpen(false)}
            >
              {content}
            </Link>
          );
        }
        return (
          <button
            key={item.id}
            ref={(element) => { itemRefs.current[index] = element; }}
            type="button"
            role="menuitem"
            className={className}
            onClick={() => {
              setOpen(false);
              // If the callback opens a Dialog in the same commit, the trigger becomes inert.
              // Restore focus synchronously first so Dialog captures the correct return target
              // and can return to the row action button when it closes.
              triggerRef.current?.focus();
              item.onSelect();
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  ), document.body) : null;

  return (
    <>
      <div className="studio-action-menu">
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          variant="ghost"
          disabled={input.disabled}
          aria-label={input.label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (open) setOpen(false);
            else openMenu();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            if (!open) openMenu();
            else itemRefs.current[0]?.focus();
          }}
        >
          <StudioIcon icon={Ellipsis} className="studio-action-menu-trigger-icon" />
        </Button>
      </div>
      {menu}
    </>
  );
}
