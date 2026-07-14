'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { TaskCardUnified } from './task-card-unified';
import { buildMonthCells, isInCursorMonth, parseLocalISO, startOfLocalMonth, toLocalISO } from './task-calendar-helpers';

type CalendarTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  due_date: string | null;
  project_prefix: string;
  assignee_name: string | null;
  assignee_avatar?: string | null;
};

type Props<T extends CalendarTask> = {
  tasks: T[];
  projectPrefix: string;
  hidePrefixIds?: boolean;
  onTaskClick: (task: T) => void;
  onAddOnDate?: (isoDate: string) => void;
  onTaskReschedule?: (taskId: string, dueDate: string) => Promise<boolean>;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_COLORS: Record<string, string> = {
  backlog: '#6B7280', todo: '#3B82F6', in_progress: '#F59E0B', in_review: '#8B5CF6', done: '#22C55E', cancelled: '#EF4444',
};

export function TaskCalendarView<T extends CalendarTask>({ tasks, projectPrefix, hidePrefixIds, onTaskClick, onAddOnDate, onTaskReschedule }: Props<T>) {
  const [cursor, setCursor] = useState(() => startOfLocalMonth(new Date()));
  const [isMobile, setIsMobile] = useState(false);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [undatedExpanded, setUndatedExpanded] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const days = useMemo(() => buildMonthCells(cursor), [cursor]);
  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const today = toLocalISO(new Date());
  const undatedTasks = useMemo(() => tasks.filter((task) => !task.due_date), [tasks]);
  const tasksByDate = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const task of tasks) {
      const date = parseLocalISO(task.due_date);
      if (!date) continue;
      const iso = toLocalISO(date);
      const bucket = map.get(iso) ?? [];
      bucket.push(task);
      map.set(iso, bucket);
    }
    for (const bucket of map.values()) bucket.sort((left, right) => left.number - right.number);
    return map;
  }, [tasks]);

  const agendaDates = useMemo(() => {
    const values = [...tasksByDate.keys()].filter((iso) => isInCursorMonth(iso, cursor));
    if (isInCursorMonth(today, cursor) && !values.includes(today)) values.push(today);
    return values.sort();
  }, [tasksByDate, cursor, today]);

  const changeMonth = (delta: number) => setCursor((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  const expandedTasks = expandedDate ? tasksByDate.get(expandedDate) ?? [] : [];

  const handleDragEnd = async (event: DragEndEvent) => {
    if (isMobile || !event.over || !onTaskReschedule) return;
    const taskId = String(event.active.id);
    const dueDate = String(event.over.id);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.due_date?.slice(0, 10) === dueDate) return;
    setRescheduleError(null);
    const ok = await onTaskReschedule(taskId, dueDate);
    if (!ok) setRescheduleError(`${projectPrefix}-${task.number} could not be rescheduled. Its previous date was restored.`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--background)' }}>
      <CalendarToolbar monthLabel={monthLabel} onPrevious={() => changeMonth(-1)} onToday={() => setCursor(startOfLocalMonth(new Date()))} onNext={() => changeMonth(1)} />

      {rescheduleError && (
        <div className="mx-4 mt-2 rounded-md px-3 py-2 text-xs" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' }}>
          {rescheduleError}
        </div>
      )}

      {isMobile ? (
        <MobileAgenda
          dates={agendaDates}
          tasksByDate={tasksByDate}
          today={today}
          projectPrefix={projectPrefix}
          hidePrefixIds={hidePrefixIds}
          onTaskClick={onTaskClick}
          onAddOnDate={onAddOnDate}
        />
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="grid flex-shrink-0 grid-cols-7 text-center text-[10px] font-semibold uppercase" style={{ color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)' }}>
            {WEEKDAYS.map((weekday) => <div key={weekday} className="py-2">{weekday}</div>)}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(100px, 1fr))` }}>
            {days.map((cell, index) => {
              if (!cell.date || !cell.iso) return <div key={`blank-${index}`} style={{ background: 'var(--surface-subtle)', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }} />;
              const cellTasks = tasksByDate.get(cell.iso) ?? [];
              return (
                <DroppableDay key={cell.iso} dateKey={cell.iso} isToday={cell.iso === today}>
                  <div className="group flex h-full min-h-[100px] flex-col gap-1 p-1.5">
                    <div className="flex items-center justify-between">
                      <span className="flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold" style={{ color: cell.iso === today ? 'white' : 'var(--text-secondary)', background: cell.iso === today ? 'var(--accent)' : 'transparent' }}>
                        {cell.date.getDate()}
                      </span>
                      {onAddOnDate && (
                        <button type="button" onClick={() => onAddOnDate(cell.iso!)} className="flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-opacity hover:bg-[var(--hover-tint)] group-hover:opacity-100 focus:opacity-100" style={{ color: 'var(--text-secondary)' }} aria-label={`Add task on ${cell.iso}`}>
                          <Plus size={13} />
                        </button>
                      )}
                    </div>
                    <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
                      {cellTasks.slice(0, 4).map((task) => (
                        <DraggableTask key={task.id} taskId={task.id}>
                          <TaskCardUnified variant="calendar" task={task as any} projectPrefix={projectPrefix} onClick={() => onTaskClick(task)} hidePrefixIds={hidePrefixIds} />
                        </DraggableTask>
                      ))}
                      {cellTasks.length > 4 && (
                        <button type="button" onClick={() => setExpandedDate(cell.iso)} className="w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold hover:bg-[var(--hover-tint)]" style={{ color: 'var(--accent)' }} aria-label={`Show all ${cellTasks.length} tasks on ${cell.iso}`}>
                          +{cellTasks.length - 4} more
                        </button>
                      )}
                    </div>
                  </div>
                </DroppableDay>
              );
            })}
          </div>
        </DndContext>
      )}

      {undatedTasks.length > 0 && (
        <div className="flex-shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          <button type="button" onClick={() => setUndatedExpanded((value) => !value)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            <ChevronDown size={14} style={{ transform: undatedExpanded ? 'rotate(180deg)' : undefined }} />
            No due date <span style={{ color: 'var(--text-tertiary)' }}>({undatedTasks.length})</span>
          </button>
          {undatedExpanded && (
            <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto px-4 pb-3 md:grid-cols-3">
              {undatedTasks.map((task) => <AgendaTaskRow key={task.id} task={task} projectPrefix={projectPrefix} hidePrefixIds={hidePrefixIds} onClick={() => onTaskClick(task)} />)}
            </div>
          )}
        </div>
      )}

      {expandedDate && (
        <DayDialog date={expandedDate} tasks={expandedTasks} projectPrefix={projectPrefix} hidePrefixIds={hidePrefixIds} onClose={() => setExpandedDate(null)} onTaskClick={(task) => { setExpandedDate(null); onTaskClick(task); }} onAddOnDate={onAddOnDate} />
      )}
    </div>
  );
}

function CalendarToolbar({ monthLabel, onPrevious, onToday, onNext }: { monthLabel: string; onPrevious: () => void; onToday: () => void; onNext: () => void }) {
  return (
    <div className="sticky top-0 z-20 flex flex-shrink-0 items-center justify-between gap-3 px-4 py-3" style={{ background: 'var(--background)', borderBottom: '1px solid var(--border)' }}>
      <div className="flex min-w-0 items-center gap-2">
        <CalendarDays size={15} style={{ color: 'var(--accent)' }} />
        <h2 className="truncate text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}>{monthLabel}</h2>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onPrevious} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-[var(--hover-tint)]" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }} aria-label="Previous month"><ChevronLeft size={15} /></button>
        <button type="button" onClick={onToday} className="h-9 rounded-full px-3 text-[11px] font-semibold" style={{ color: 'var(--text-primary)', border: '1px solid var(--border)', background: 'var(--surface)' }}>Today</button>
        <button type="button" onClick={onNext} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-[var(--hover-tint)]" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }} aria-label="Next month"><ChevronRight size={15} /></button>
      </div>
    </div>
  );
}

function DroppableDay({ dateKey, isToday, children }: { dateKey: string; isToday: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: dateKey });
  return (
    <div ref={setNodeRef} style={{ background: isOver ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : isToday ? 'color-mix(in srgb, var(--accent) 5%, var(--surface))' : 'var(--surface)', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', outline: isOver ? '2px solid var(--accent)' : 'none', outlineOffset: '-2px' }}>
      {children}
    </div>
  );
}

function DraggableTask({ taskId, children }: { taskId: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: taskId });
  return <div ref={setNodeRef} {...attributes} {...listeners} style={{ opacity: isDragging ? 0.45 : 1, cursor: isDragging ? 'grabbing' : 'grab' }}>{children}</div>;
}

function MobileAgenda<T extends CalendarTask>({ dates, tasksByDate, today, projectPrefix, hidePrefixIds, onTaskClick, onAddOnDate }: { dates: string[]; tasksByDate: Map<string, T[]>; today: string; projectPrefix: string; hidePrefixIds?: boolean; onTaskClick: (task: T) => void; onAddOnDate?: (iso: string) => void }) {
  if (dates.length === 0) return <CalendarEmpty />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="task-calendar-agenda">
      {dates.map((iso) => {
        const date = parseLocalISO(iso)!;
        const dayTasks = tasksByDate.get(iso) ?? [];
        const isToday = iso === today;
        return (
          <section key={iso} className="py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase" style={{ color: isToday ? 'var(--accent)' : 'var(--text-secondary)' }}>{isToday ? 'Today' : date.toLocaleDateString('en-US', { weekday: 'short' })}</h3>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
              {onAddOnDate && <button type="button" onClick={() => onAddOnDate(iso)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--hover-tint)]" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }} aria-label={`Add task on ${iso}`}><Plus size={14} /></button>}
            </div>
            {dayTasks.length ? <div className="flex flex-col gap-1">{dayTasks.map((task) => <AgendaTaskRow key={task.id} task={task} projectPrefix={projectPrefix} hidePrefixIds={hidePrefixIds} onClick={() => onTaskClick(task)} />)}</div> : <p className="py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>Nothing due today.</p>}
          </section>
        );
      })}
    </div>
  );
}

function AgendaTaskRow<T extends CalendarTask>({ task, projectPrefix, hidePrefixIds, onClick }: { task: T; projectPrefix: string; hidePrefixIds?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-[var(--hover-tint)]">
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: STATUS_COLORS[task.status] ?? STATUS_COLORS.backlog }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{task.title}</span>
        <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{!hidePrefixIds && `${projectPrefix}-${task.number} · `}{task.assignee_name || 'Unassigned'}</span>
      </span>
      <span className="rounded-full px-2 py-1 text-[10px] font-semibold uppercase" style={{ color: 'var(--text-secondary)', background: 'var(--surface-subtle)' }}>{task.priority}</span>
    </button>
  );
}

function DayDialog<T extends CalendarTask>({ date, tasks, projectPrefix, hidePrefixIds, onClose, onTaskClick, onAddOnDate }: { date: string; tasks: T[]; projectPrefix: string; hidePrefixIds?: boolean; onClose: () => void; onTaskClick: (task: T) => void; onAddOnDate?: (iso: string) => void }) {
  const parsed = parseLocalISO(date)!;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Tasks due ${date}`} className="w-full max-w-md rounded-lg p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }} onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{parsed.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3><p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{tasks.length} tasks due</p></div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--hover-tint)]" aria-label="Close day tasks"><X size={15} /></button>
        </div>
        <div className="max-h-80 overflow-y-auto">{tasks.map((task) => <AgendaTaskRow key={task.id} task={task} projectPrefix={projectPrefix} hidePrefixIds={hidePrefixIds} onClick={() => onTaskClick(task)} />)}</div>
        {onAddOnDate && <button type="button" onClick={() => { onClose(); onAddOnDate(date); }} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-full text-xs font-semibold text-white" style={{ background: 'var(--accent)' }}><Plus size={14} /> Add task</button>}
      </div>
    </div>
  );
}

function CalendarEmpty() {
  return <div className="flex min-h-56 flex-1 items-center justify-center px-6 text-center"><div><CalendarDays size={22} className="mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} /><p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Nothing due this month</p><p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>Choose a date to add the first scheduled task.</p></div></div>;
}
