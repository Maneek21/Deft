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
    <div className="flex items-center justify-between px-1 pb-4 gap-3 flex-wrap">
      {/* Left: navigation */}
      <div className="flex items-center gap-2">
        <button onClick={onPrev} className="p-1.5 rounded-md hover:opacity-70 transition-colors"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}>
          <ChevronLeft size={16} />
        </button>
        <button onClick={onNext} className="p-1.5 rounded-md hover:opacity-70 transition-colors"
          style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}>
          <ChevronRight size={16} />
        </button>
        <h1 className="text-[16px] font-semibold ml-1" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h1>
        <button onClick={onToday}
          className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors hover:opacity-80"
          style={{ background: 'var(--accent)', color: 'white' }}>
          Today
        </button>
      </div>

      {/* Right: actions + view toggle + connection */}
      <div className="flex items-center gap-3">
        {/* New event button */}
        {onNewEvent && (
          <button onClick={onNewEvent}
            className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors hover:opacity-80"
            style={{ background: 'var(--accent)', color: 'white' }}>
            <Plus size={13} />
            New event
          </button>
        )}

        <Link href="/settings/calendar" className="hidden md:flex items-center gap-1 text-[11px] hover:underline"
          style={{ color: 'var(--accent)' }}>
          <LinkIcon size={11} />
          Calendar feeds
        </Link>

        <div className="flex rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border-default)' }}>
          {VIEW_LABELS.map(({ value, label }) => (
            <button key={value} onClick={() => onViewChange(value)}
              className="px-3 py-1.5 text-[11px] font-medium transition-colors"
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
