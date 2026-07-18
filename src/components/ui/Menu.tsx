import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

interface ContextMenuProps {
  open: boolean;
  onClose: () => void;
  x: number;
  y: number;
  label: string;
  children: ReactNode;
}

export function ContextMenu({ open, onClose, x, y, label, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', keydown);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, open]);
  if (!open) return null;
  return <div ref={menuRef} role="menu" aria-label={label} className="surface-glass-strong fixed z-[130] min-w-48 rounded-[var(--radius-control)] border border-[var(--border-subtle)] p-1 shadow-[var(--elevation-floating)]" style={{ left: Math.min(x, window.innerWidth - 208), top: Math.min(y, window.innerHeight - 240) }}>{children}</div>;
}

interface OverflowMenuProps {
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

export function OverflowMenu({ label, children, align = 'end', className = '' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', keydown);
    };
  }, [open]);
  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button type="button" className="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(previous => !previous)}><MoreHorizontal className="h-5 w-5" /></button>
      {open && <div role="menu" aria-label={label} className={`surface-glass-strong absolute top-full z-50 mt-1 min-w-48 rounded-[var(--radius-control)] border border-[var(--border-subtle)] p-1 shadow-[var(--elevation-floating)] ${align === 'end' ? 'right-0' : 'left-0'}`} onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

export const menuItemClassName = 'flex min-h-11 w-full items-center gap-2 rounded-[calc(var(--radius-control)-0.25rem)] px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface-subtle focus-visible:bg-surface-subtle';

