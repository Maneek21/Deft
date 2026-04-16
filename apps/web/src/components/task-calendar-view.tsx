'use client';

/**
 * Task 4.10 — Calendar view.
 *
 * Month grid; tasks rendered on their `due_date`. Each cell has an "Add task
 * on this date" affordance. Tasks render as compact chips via
 * TaskCardUnified's `calendar` variant. v1 is read-only: clicking a chip
 * opens the detail panel, dragging between cells is NOT yet wired (the API
 * still supports PATCH due_date, so follow-up work can add dnd).
 */

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { TaskCardUnified } from './task-card-unified';

// Minimum shape needed for calendar rendering. Callers (tasks/page.tsx)
// generally pass a wider Task object; we only read the fields below.
type CalendarTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  due_date: string | null;
  project_prefix: string;
  assignee_name: string | null;
};

type Props<T extends CalendarTask> = {
  tasks: T[];
  projectPrefix: string;
  hidePrefixIds?: boolean;
  onTaskClick: (task: T) => void;
  onAddOnDate?: (isoDate: string) => void;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TaskCalendarView<T extends CalendarTask>({ tasks, projectPrefix, hidePrefixIds, onTaskClick, onAddOnDate }: Props<T>) {
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));

  const { days, monthLabel } = useMemo(() => {
    const first = startOfMonth(cursor);
    const leadingBlanks = first.getDay();
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cells: Array<{ date: Date | null; iso: string | null }> = [];

    for (let i = 0; i < leadingBlanks; i += 1) cells.push({ date: null, iso: null });
    for (let d = 1; d <= daysInMonth; d += 1) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
      cells.push({ date, iso: toISO(date) });
    }
    // Pad trailing to complete the last week row.
    while (cells.length % 7 !== 0) cells.push({ date: null, iso: null });

    const label = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return { days: cells, monthLabel: label };
  }, [cursor]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const t of tasks) {
      if (!t.due_date) continue;
      const iso = toISO(new Date(t.due_date));
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso)!.push(t);
    }
    return map;
  }, [tasks]);

  const today = toISO(new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Header with month navigation */}
      <div
        className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            className="p-1.5 rounded-md"
            style={{ color: 'var(--muted)' }}
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => setCursor(startOfMonth(new Date()))}
            className="text-[12px] px-2 py-1 rounded-md font-medium"
            style={{
              color: 'var(--foreground-secondary)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            Today
          </button>
          <button
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            className="p-1.5 rounded-md"
            style={{ color: 'var(--muted)' }}
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <h2
          className="text-[14px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          {monthLabel}
        </h2>
        <div style={{ width: '120px' }} />
      </div>

      {/* Weekday header */}
      <div
        className="grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
        style={{
          color: 'var(--muted)',
          fontFamily: 'var(--font-heading)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1.5">
            {w}
          </div>
        ))}
      </div>

      {/* Month grid */}
      <div className="grid grid-cols-7 auto-rows-[minmax(110px,1fr)] flex-1 overflow-y-auto">
        {days.map((cell, idx) => {
          if (!cell.date || !cell.iso) {
            return (
              <div
                key={idx}
                style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
              />
            );
          }
          const cellTasks = tasksByDate.get(cell.iso) ?? [];
          const isToday = cell.iso === today;
          return (
            <div
              key={idx}
              className="p-1.5 flex flex-col gap-0.5 relative group"
              style={{
                background: isToday ? 'var(--accent-subtle)' : 'var(--card-bg)',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                minHeight: '110px',
              }}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span
                  className="text-[11px] font-medium"
                  style={{
                    color: isToday ? 'var(--accent)' : 'var(--muted)',
                    fontFamily: 'var(--font-heading)',
                  }}
                >
                  {cell.date.getDate()}
                </span>
                {onAddOnDate && (
                  <button
                    onClick={() => onAddOnDate(cell.iso!)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded"
                    style={{ color: 'var(--muted)' }}
                    aria-label={`Add task on ${cell.iso}`}
                    title="Add task on this date"
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                {cellTasks.slice(0, 4).map((t) => (
                  <TaskCardUnified
                    key={t.id}
                    variant="calendar"
                    task={t as any}
                    projectPrefix={projectPrefix}
                    onClick={() => onTaskClick(t)}
                    hidePrefixIds={hidePrefixIds}
                  />
                ))}
                {cellTasks.length > 4 && (
                  <span
                    className="text-[10px] px-1.5 py-0.5"
                    style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
                  >
                    +{cellTasks.length - 4} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
