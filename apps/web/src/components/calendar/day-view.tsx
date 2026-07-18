'use client';

import { useEffect, useRef } from 'react';
import { CalEvent, DayBucket, HOURS, ITEM_COLORS, formatHourLabel, toDateKey, getEventSourceColor } from '@/lib/calendar';
import { dateKeyInUserTimezone, formatEventTime, timePartsInUserTimezone } from '@/lib/time';
import { MapPin, ExternalLink, CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';

const ROW_HEIGHT = 60;

const PRIORITY_COLORS: Record<string, string> = {
  p0: 'var(--status-red)', p1: 'var(--status-amber)', p2: 'var(--status-blue)', p3: 'var(--status-gray)',
};

export function DayView({
  anchor, bucket, onSlotClick, onEventClick,
}: {
  anchor: Date;
  bucket: DayBucket | undefined;
  onSlotClick?: (dateKey: string, hour: number) => void;
  onEventClick?: (event: CalEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = new Date();
  const isToday = toDateKey(anchor) === dateKeyInUserTimezone(now);
  const dateKey = toDateKey(anchor);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 8 * ROW_HEIGHT;
    }
  }, [anchor.getTime()]);

  const allDayEvents: NonNullable<typeof bucket>['events'] = [];
  const timedEvents: { event: NonNullable<typeof bucket>['events'][0]; startMin: number; durationMin: number }[] = [];
  const allTasks = bucket?.tasks || [];
  const allNotes = bucket?.notes || [];

  if (bucket) {
    for (const e of bucket.events) {
      if (e.metadata?.allDay || !e.metadata?.start) {
        allDayEvents.push(e);
      } else {
        const start = new Date(e.metadata.start);
        const end = e.metadata.end ? new Date(e.metadata.end) : new Date(start.getTime() + 3600000);
        const startParts = timePartsInUserTimezone(e.metadata.start);
        const startMin = startParts.hour * 60 + startParts.minute;
        const durationMin = Math.max(30, (end.getTime() - start.getTime()) / 60000);
        timedEvents.push({ event: e, startMin, durationMin });
      }
    }
  }

  const hasAllDay = allDayEvents.length + allTasks.length + allNotes.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* All-day section */}
      {hasAllDay && (
        <div className="border-b p-3 space-y-1.5" style={{ borderColor: 'var(--border-default)' }}>
          <span className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-tertiary)' }}>All Day</span>

          {allDayEvents.map((e) => (
            <div key={e.id} className="flex items-center gap-2 py-1 cursor-pointer hover:opacity-80"
              onClick={() => onEventClick?.(e)}>
              <div className="w-2 h-2 rounded-full" style={{ background: getEventSourceColor(e.source) }} />
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{e.title}</span>
              {e.url && (
                <a href={e.url} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--text-tertiary)' }} onClick={(ev) => ev.stopPropagation()}>
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          ))}

          {allTasks.map((t) => (
            <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
              className="flex items-center gap-2 py-1 hover:opacity-80">
              {t.status === 'done'
                ? <CheckCircle2 size={12} style={{ color: 'var(--status-green)' }} />
                : <Circle size={12} style={{ color: PRIORITY_COLORS[t.priority] || 'var(--text-tertiary)' }} />}
              <span className="text-[12px]" style={{
                color: 'var(--text-primary)',
                textDecoration: t.status === 'done' ? 'line-through' : 'none',
              }}>{t.title}</span>
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {t.project_prefix}-{t.number}
              </span>
            </Link>
          ))}

          {allNotes.map((n) => (
            <Link key={n.id} href={`/notes?id=${n.id}`}
              className="flex items-center gap-2 py-1 hover:opacity-80">
              <span className="text-[11px]">{n.icon || '\uD83D\uDCC4'}</span>
              <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>
                {n.title || 'Untitled'}
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Time grid */}
      <div ref={scrollRef} className="flex flex-1 min-h-0 overflow-y-auto">
        <div className="w-[64px] flex-shrink-0 relative" style={{ height: 24 * ROW_HEIGHT }}>
          {HOURS.map((h) => (
            <div key={h} className="absolute right-3 text-[10px]"
              style={{ top: h * ROW_HEIGHT - 6, color: 'var(--text-tertiary)' }}>
              {formatHourLabel(h)}
            </div>
          ))}
        </div>

        <div className="flex-1 relative border-l"
          style={{ borderColor: 'var(--border-default)', height: 24 * ROW_HEIGHT }}>
          {HOURS.map((h) => (
            <div key={h} className="absolute w-full cursor-pointer hover:bg-[rgba(99,102,241,0.03)]"
              style={{ top: h * ROW_HEIGHT, height: ROW_HEIGHT, borderTop: '1px solid var(--border-default)' }}
              onClick={(e) => { if (e.target === e.currentTarget && onSlotClick) onSlotClick(dateKey, h); }}
            />
          ))}

          {isToday && (
            <div className="absolute w-full z-10 pointer-events-none"
              style={{ top: (() => {
                const parts = timePartsInUserTimezone(now);
                return (parts.hour * 60 + parts.minute) * (ROW_HEIGHT / 60);
              })() }}>
              <div className="flex items-center">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1" />
                <div className="flex-1 h-px bg-red-500" />
              </div>
            </div>
          )}

          {timedEvents.map(({ event: e, startMin, durationMin }) => {
            const startTime = formatEventTime(e.metadata.start);
            const endTime = e.metadata.end ? formatEventTime(e.metadata.end) : null;
            const eventColor = getEventSourceColor(e.source);
            return (
              <div key={e.id}
                className="absolute left-1 right-1 rounded-lg px-3 py-1.5 overflow-hidden cursor-pointer hover:opacity-90 z-[1]"
                style={{
                  top: startMin * (ROW_HEIGHT / 60),
                  height: Math.max(28, durationMin * (ROW_HEIGHT / 60)),
                  background: `${eventColor}20`,
                  borderLeft: `4px solid ${eventColor}`,
                }}
                onClick={() => onEventClick?.(e)}>
                <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {e.title}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  {startTime}{endTime ? ` – ${endTime}` : ''}
                </div>
                {e.metadata?.location && (
                  <div className="flex items-center gap-1 text-[10px] mt-0.5"
                    style={{ color: 'var(--text-tertiary)' }}>
                    <MapPin size={9} />
                    {e.metadata.location}
                  </div>
                )}
                {e.metadata?.attendees?.length > 0 && (
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    {e.metadata.attendees.length} attendees
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
