'use client';
import { useState, useRef, useEffect, ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

type Item = { label: string; onClick: () => void; icon?: ReactNode; danger?: boolean };

export function OverflowMenu({ items, className = '' }: { items: Item[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="More"
        className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md hover:opacity-70"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-md border py-1 z-30 min-w-[180px]"
          style={{ background: 'var(--surface)', borderColor: 'var(--outline-variant)' }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.onClick(); setOpen(false); }}
              className="flex items-center gap-2 w-full text-left px-3 py-2 text-[0.875rem] hover:bg-[var(--surface-container)]"
              style={{ color: item.danger ? 'var(--status-red)' : 'var(--text-primary)' }}
            >
              {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
