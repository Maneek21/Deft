'use client';

import { useRef, useState, ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { AppMenu, type AppMenuItem } from './overlay-primitives';

type Item = {
  label: string;
  onClick: () => void | Promise<void>;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

export function OverflowMenu({
  items,
  className = '',
  label = 'More',
}: {
  items: Item[];
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuItems: AppMenuItem[] = items.map((item) => ({
    label: item.label,
    icon: item.icon,
    danger: item.danger,
    disabled: item.disabled,
    onSelect: item.onClick,
  }));

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((current) => !current)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-container)]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <MoreHorizontal size={18} />
      </button>
      <AppMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        items={menuItems}
        ariaLabel={label}
        width={200}
      />
    </div>
  );
}
