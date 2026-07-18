'use client';

import { useEffect, useRef } from 'react';
import { CalEvent, DayBucket, buildWeekDates, toDateKey, HOURS, ITEM_COLORS, formatHourLabel, getEventSourceColor } from '@/lib/calendar';
import { dateKeyInUserTimezone, timePartsInUserTimezone } from '@/lib/time';

const ROW_HEIGHT = 60;
const ALL_DAY_MIN = 32;

type TimedItem = { id: string; title: string; startMin: number; durationMin: number; color: string; event: CalEvent };

export function WeekView({
  anchor, buckets, selectedDay, onSelectDay, onSlotClick, onEventClick,
}: {
  anchor: Date;
  buckets: Map<string, DayBucket>;
  selectedDay: string | null;
  onSelectDay: (dateKey: string) => void;
  onSlotClick?: (dateKey: string, hour: number) => void;
  onEventClick?: (event: CalEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const week = buildWeekDates(anchor);
  const today = dateKeyInUserTimezone(new Date());
  const now = new Date();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 8 * ROW_HEIGHT;
    }
  }, [anchor.getTime()]);

  const dayColumns = week.map((date) => {
    const key = toDateKey(date);
    const bucket = buckets.get(key);
    const allDay: { id: string; title: string; type: 'event' | 'task' | 'note'; color: string }[] = [];
    const timed: TimedItem[] = [];

    if (bucket) {
      for (const e of bucket.events) {
        const eventColor = getEventSourceColor(e.source);
        if (e.metadata?.allDay) {
          allDay.push({ id: e.id, title: e.title, type: 'event', color: eventColor });
        } else if (e.metadata?.start) {
          const start = new Date(e.metadata.start);
          const end = e.metadata.end ? new Date(e.metadata.end) : new Date(start.getTime() + 3600000);
          const startParts = timePartsInUserTimezone(e.metadata.start);
          const startMin = startParts.hour * 60 + startParts.minute;
          const durationMin = Math.max(30, (end.getTime() - start.getTime()) / 60000);
          timed.push({ id: e.id, title: e.title, startMin, durationMin, color: eventColor, event: e });
        } else {
          allDay.push({ id: e.id, title: e.title, type: 'event', color: eventColor });
        }
      }
      for (const t of bucket.tasks) {
        allDay.push({ id: t.id, title: t.title, type: 'task', color: ITEM_COLORS.task });
      }
      for (const n of bucket.notes) {
        allDay.push({ id: n.id, title: n.title || 'Untitled', type: 'note', color: ITEM_COLORS.note });
      }
    }

    return { key, date, allDay, timed };
  });

  const hasAllDay = dayColumns.some((c) => c.allDay.length > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Column headers */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="w-[56px] flex-shrink-0" />
        {week.map((date, i) => {
          const key = toDateKey(date);
          const isToday = key === today;
          const isSelected = key === selectedDay;
          return (
            <div key={i} onClick={() => onSelectDay(key)}
              className="flex-1 text-center py-2 cursor-pointer transition-colors"
              style={{ background: isSelected ? 'var(--bg-active)' : 'transparent' }}>
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                {date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}
              </div>
              <div className={`text-[16px] font-semibold mx-auto w-8 h-8 flex items-center justify-center rounded-full`}
                style={{
                  color: isToday ? 'white' : 'var(--text-primary)',
                  background: isToday ? 'var(--accent)' : 'transparent',
                }}>
                {date.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day section */}
      {hasAllDay && (
        <div className="flex border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="w-[56px] flex-shrink-0 flex items-center justify-end pr-2">
            <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>all-day</span>
          </div>
          {dayColumns.map((col, i) => (
            <div key={i} className="flex-1 p-0.5 space-y-0.5 border-l"
              style={{ borderColor: 'var(--border-default)', minHeight: ALL_DAY_MIN }}>
              {col.allDay.slice(0, 3).map((item) => (
                <div key={item.id} className="text-[10px] truncate px-1 py-0.5 rounded"
                  style={{ background: `${item.color}18`, color: 'var(--text-primary)' }}>
                  {item.title}
                </div>
              ))}
              {col.allDay.length > 3 && (
                <span className="text-[9px] px-1" style={{ color: 'var(--text-tertiary)' }}>
                  +{col.allDay.length - 3}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Time grid */}
      <div ref={scrollRef} className="flex flex-1 min-h-0 overflow-y-auto">
        <div className="w-[56px] flex-shrink-0 relative" style={{ height: 24 * ROW_HEIGHT }}>
          {HOURS.map((h) => (
            <div key={h} className="absolute right-2 text-[10px]"
              style={{ top: h * ROW_HEIGHT - 6, color: 'var(--text-tertiary)' }}>
              {formatHourLabel(h)}
            </div>
          ))}
        </div>

        {dayColumns.map((col, colIdx) => {
          const isToday = col.key === today;
          return (
            <div key={colIdx} className="flex-1 relative border-l"
              style={{ borderColor: 'var(--border-default)', height: 24 * ROW_HEIGHT }}>
              {HOURS.map((h) => (
                <div key={h} className="absolute w-full cursor-pointer hover:bg-[rgba(99,102,241,0.03)]"
                  style={{ top: h * ROW_HEIGHT, height: ROW_HEIGHT, borderTop: '1px solid var(--border-default)' }}
                  onClick={(e) => { if (e.target === e.currentTarget && onSlotClick) onSlotClick(col.key, h); }}
                />
              ))}

              {isToday && (
                <div className="absolute w-full z-10 pointer-events-none"
                  style={{ top: (() => {
                    const parts = timePartsInUserTimezone(now);
                    return (parts.hour * 60 + parts.minute) * (ROW_HEIGHT / 60);
                  })() }}>
                  <div className="flex items-center">
                    <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                    <div className="flex-1 h-px bg-red-500" />
                  </div>
                </div>
              )}

              {col.timed.map((item) => (
                <div key={item.id}
                  className="absolute left-0.5 right-0.5 rounded px-1.5 py-0.5 overflow-hidden cursor-pointer hover:opacity-90 z-[1]"
                  style={{
                    top: item.startMin * (ROW_HEIGHT / 60),
                    height: Math.max(20, item.durationMin * (ROW_HEIGHT / 60)),
                    background: `${item.color}25`,
                    borderLeft: `3px solid ${item.color}`,
                  }}
                  onClick={() => onEventClick?.(item.event)}>
                  <span className="text-[10px] font-medium line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
