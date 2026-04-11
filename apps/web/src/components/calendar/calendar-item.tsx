'use client';

import { ITEM_COLORS } from '@/lib/calendar';
import { FileText } from 'lucide-react';

type ItemType = 'event' | 'task' | 'note' | 'reminder';

export function CalendarItem({
  type, title, time, hasBrief, onClick,
}: {
  type: ItemType;
  title: string;
  time?: string;
  hasBrief?: boolean;
  onClick?: () => void;
}) {
  const color = ITEM_COLORS[type];

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 w-full text-left px-1.5 py-0.5 rounded text-[11px] truncate transition-colors hover:opacity-80"
      style={{ background: `${color}18` }}
    >
      <div
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: color }}
      />
      <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>
        {title}
      </span>
      {hasBrief && (
        <FileText size={10} className="flex-shrink-0" style={{ color: 'var(--accent)' }} />
      )}
      {time && (
        <span className="flex-shrink-0 text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
          {time}
        </span>
      )}
    </button>
  );
}
