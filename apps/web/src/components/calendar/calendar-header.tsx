'use client';

import { CalendarView } from '@/lib/calendar';
import { ChevronLeft, ChevronRight, Link as LinkIcon, Plus } from 'lucide-react';
import Link from 'next/link';

const VIEW_LABELS: { value: CalendarView; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

export function CalendarHeader({
  view, anchor, onPrev, onNext, onToday, onViewChange, onNewEvent,
}: {
  view: CalendarView;
  anchor: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewChange: (v: CalendarView) => void;
  onNewEvent?: () => void;
}) {
  const title = getTitle(view, anchor);

  return (
    <div className="flex flex-col gap-3 px-1 pb-4 md:flex-row md:items-center md:justify-between">
      {/* Left: navigation */}
      <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
        <button onClick={onPrev} aria-label="Previous calendar period" title="Previous calendar period" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}>
          <ChevronLeft size={16} />
        </button>
        <button onClick={onNext} aria-label="Next calendar period" title="Next calendar period" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}>
          <ChevronRight size={16} />
        </button>
        <h1 className="ml-1 min-w-0 flex-1 truncate text-[15px] font-semibold md:flex-none md:text-[16px]" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h1>
        <button onClick={onToday}
          className="h-9 flex-shrink-0 rounded-full px-3 text-[12px] font-semibold transition-colors hover:opacity-80 md:h-8"
          style={{ background: 'var(--accent)', color: 'white' }}>
          Today
        </button>
      </div>

      {/* Right: actions + view toggle + connection */}
      <div className="flex w-full items-center gap-2 overflow-x-auto pb-0.5 md:w-auto md:justify-start md:gap-2 md:overflow-visible md:pb-0">
        {/* New event button */}
        {onNewEvent && (
          <button onClick={onNewEvent}
            className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors hover:opacity-80 md:h-8"
            style={{ background: 'var(--accent)', color: 'white' }}>
            <Plus size={13} />
            <span className="hidden sm:inline">New event</span>
            <span className="sm:hidden">New</span>
          </button>
        )}

        <Link href="/settings/calendar" className="hidden md:flex items-center gap-1 text-[11px] hover:underline"
          style={{ color: 'var(--accent)' }}>
          <LinkIcon size={11} />
          Calendar feeds
        </Link>

        <div className="flex flex-shrink-0 items-center gap-1">
          {VIEW_LABELS.map(({ value, label }) => (
            <button key={value} onClick={() => onViewChange(value)}
              className="h-9 rounded-full px-4 text-[12px] font-semibold transition-colors hover:opacity-80 md:h-8 md:px-3.5"
              style={{
                background: view === value ? 'var(--accent)' : 'var(--surface-container-low)',
                color: view === value ? 'white' : 'var(--text-secondary)',
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function getTitle(view: CalendarView, anchor: Date): string {
  if (view === 'month') {
    return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (view === 'week') {
    const sun = new Date(anchor);
    sun.setDate(sun.getDate() - sun.getDay());
    const sat = new Date(sun);
    sat.setDate(sat.getDate() + 6);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const yearSuffix = sun.getFullYear() !== sat.getFullYear()
      ? `, ${sat.getFullYear()}`
      : '';
    return `${sun.toLocaleDateString('en-US', opts)} – ${sat.toLocaleDateString('en-US', opts)}${yearSuffix}, ${sat.getFullYear()}`;
  }
  // day
  return anchor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
