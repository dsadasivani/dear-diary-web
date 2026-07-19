import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { MoreHorizontal } from 'lucide-react';

interface ContextMenuProps {
  open: boolean;
  onClose: () => void;
  x: number;
  y: number;
  label: string;
  children: ReactNode;
}

const menuItems = (root: HTMLElement | null): HTMLButtonElement[] =>
  root
    ? Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not([disabled]), button:not([disabled])',
        ),
      )
    : [];

const moveMenuFocus = (root: HTMLElement | null, key: string): boolean => {
  const items = menuItems(root);
  if (!items.length) return false;
  const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  const nextIndex =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowUp'
          ? (currentIndex - 1 + items.length) % items.length
          : key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : -1;
  if (nextIndex < 0) return false;
  items[nextIndex].focus();
  return true;
};

export function ContextMenu({ open, onClose, x, y, label, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => menuItems(menuRef.current)[0]?.focus(), 0);
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') onClose();
      if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', keydown);
    window.addEventListener('blur', onClose);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', onClose);
      previous?.focus();
    };
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="surface-glass-strong fixed z-[130] min-w-48 rounded-[var(--radius-control)] border border-[var(--border-subtle)] p-1 shadow-[var(--elevation-floating)]"
      style={{
        left: Math.min(x, window.innerWidth - 208),
        top: Math.min(y, window.innerHeight - 240),
      }}
    >
      {children}
    </div>
  );
}

interface OverflowMenuProps {
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

export function OverflowMenu({
  label,
  children,
  align = 'end',
  className = '',
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => menuItems(menuRef.current)[0]?.focus(), 0);
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') setOpen(false);
      if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', keydown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', keydown);
      triggerRef.current?.focus();
    };
  }, [open]);
  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className={`surface-glass-strong absolute top-full z-50 mt-1 min-w-48 rounded-[var(--radius-control)] border border-[var(--border-subtle)] p-1 shadow-[var(--elevation-floating)] ${align === 'end' ? 'right-0' : 'left-0'}`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export const menuItemClassName =
  'flex min-h-11 w-full items-center gap-2 rounded-[calc(var(--radius-control)-0.25rem)] px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface-subtle focus-visible:bg-surface-subtle';

export function MenuItem({
  className = '',
  onKeyDown,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.currentTarget.click();
    }
  };
  return (
    <button
      {...props}
      type={props.type || 'button'}
      role="menuitem"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={`${menuItemClassName} ${className}`}
    />
  );
}
