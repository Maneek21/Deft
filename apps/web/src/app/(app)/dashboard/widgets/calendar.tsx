'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, ChevronLeft, ChevronRight } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { PRI_COLOR } from '../lib/shared';
import {
  CalTask, CalEvent, CalNote, DayBucket, toDateKey, buildMonthGrid,
  bucketByDay, CAL_DAYS_SHORT, ITEM_COLORS,
} from '@/lib/calendar';

function CalendarWidget(_props: WidgetProps) {
  const { widgetContext } = useDashboardData();
  const today = toDateKey(new Date());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calData, setCalData] = useState<{ tasks: CalTask[]; events: CalEvent[]; notes: CalNote[] } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const grid = buildMonthGrid(month);
  const gridFrom = grid[0];
  const gridTo = grid[grid.length - 1];

  useEffect(() => {
    const from = new Date(gridFrom); from.setHours(0, 0, 0, 0);
    const to = new Date(gridTo); to.setHours(23, 59, 59, 999);
    widgetContext.api.getCalendar(from.toISOString(), to.toISOString()).then(d => {
      if (d) setCalData(d as any);
    });
  }, [gridFrom.getTime(), gridTo.getTime(), widgetContext.api]);

  const dayBuckets = calData ? bucketByDay(calData) : new Map<string, DayBucket>();
  const goMonth = (o: number) => { const d = new Date(month); d.setMonth(d.getMonth() + o); setMonth(d); setSelectedDay(null); };
  const selectedBucket = selectedDay ? dayBuckets.get(selectedDay) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em',
        }}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => goMonth(-1)}
            style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', borderRadius: 6, color: 'var(--text-tertiary)' }}>
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => goMonth(1)}
            style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', borderRadius: 6, color: 'var(--text-tertiary)' }}>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 4 }}>
        {CAL_DAYS_SHORT.map((d, i) => (
          <div key={i} style={{
            textAlign: 'center', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.1em', color: 'var(--text-tertiary)', padding: '2px 0',
          }}>{d}</div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {grid.map((date, i) => {
          const key = toDateKey(date);
          const inMonth = date.getMonth() === month.getMonth();
          const isToday = key === today;
          const isSelected = key === selectedDay;
          const bucket = dayBuckets.get(key);
          const total = bucket ? (bucket.tasks.length + bucket.events.length + bucket.notes.length) : 0;
          return (
            <button key={i} onClick={() => setSelectedDay(isSelected ? null : key)}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                aspectRatio: '1 / 1', minHeight: 32, borderRadius: 7,
                background: isSelected ? 'var(--accent-muted)' : isToday ? 'var(--bg-hover)' : 'transparent',
                border: isToday ? '1px solid var(--accent)' : '1px solid transparent',
                opacity: inMonth ? 1 : 0.3,
                transition: 'all 120ms',
              }}
              onMouseEnter={e => { if (!isSelected && !isToday) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { if (!isSelected && !isToday) e.currentTarget.style.background = 'transparent'; }}>
              <span style={{
                fontSize: 12,
                fontWeight: isToday ? 700 : 500,
                color: isToday ? 'var(--accent)' : 'var(--text-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}>{date.getDate()}</span>
              {total > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                  {bucket!.events.length > 0 && <span style={{ width: 4, height: 4, borderRadius: 99, background: ITEM_COLORS.event }} />}
                  {bucket!.tasks.length > 0 && <span style={{ width: 4, height: 4, borderRadius: 99, background: ITEM_COLORS.task }} />}
                  {bucket!.notes.length > 0 && <span style={{ width: 4, height: 4, borderRadius: 99, background: ITEM_COLORS.note }} />}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedDay && selectedBucket && (selectedBucket.tasks.length + selectedBucket.events.length + selectedBucket.notes.length) > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-default)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, letterSpacing: '0.04em' }}>
            {new Date(selectedDay).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {selectedBucket.events.map(e => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: ITEM_COLORS.event, flexShrink: 0 }} />
                <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                  {new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {selectedBucket.tasks.map(t => (
              <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, textDecoration: 'none' }}>
                {t.status === 'done'
                  ? <CheckCircle2 size={12} style={{ color: 'var(--status-green)' }} />
                  : <Circle size={12} style={{ color: PRI_COLOR[t.priority] || 'var(--text-tertiary)' }} />}
                <span style={{ color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const calendarDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.calendar',
  title: 'Calendar',
  description: 'Monthly overview of events, tasks, and notes.',
  category: 'calendar',
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 5 },
  Component: CalendarWidget,
};
