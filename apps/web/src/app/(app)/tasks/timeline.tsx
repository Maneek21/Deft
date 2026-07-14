'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CalendarDays, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import {
  addLocalDays,
  buildTimelineRange,
  localDayDiff,
  parseLocalDate,
  resizeTimelineDates,
  shiftTimelineDates,
  timelineBarGeometry,
  toLocalDateKey,
  type TimelineRangeMode,
} from './timeline-range';

const STATUS_COLORS: Record<string, string> = {
  backlog: '#6B7280',
  todo: '#3B82F6',
  in_progress: '#F59E0B',
  in_review: '#8B5CF6',
  done: '#22C55E',
  cancelled: '#EF4444',
};

const RANGE_OPTIONS: Array<{ value: TimelineRangeMode; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: '4w', label: '4 weeks' },
  { value: '8w', label: '8 weeks' },
];

type TimelineTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  assignee_name: string | null;
};

type DatePatch = { start_date?: string | null; due_date?: string | null };

export default function TaskTimeline({
  tasks,
  onTaskClick,
  onTaskPatch,
  projectPrefix,
}: {
  tasks: TimelineTask[];
  onTaskClick: (taskId: string) => void;
  onTaskPatch: (taskId: string, patch: DatePatch) => Promise<boolean>;
  projectPrefix: string;
}) {
  const [mode, setMode] = useState<TimelineRangeMode>('fit');
  const [anchor, setAnchor] = useState(() => new Date());
  const [undatedExpanded, setUndatedExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const datedTasks = useMemo(() => tasks.filter((task) => task.due_date || task.start_date), [tasks]);
  const undatedTasks = useMemo(() => tasks.filter((task) => !task.due_date && !task.start_date), [tasks]);
  const range = useMemo(() => buildTimelineRange(datedTasks, mode, anchor), [datedTasks, mode, anchor]);
  const dayWidth = isMobile ? 28 : 32;
  const railWidth = isMobile ? 156 : 220;
  const canvasWidth = Math.max(isMobile ? 520 : 720, range.totalDays * dayWidth);
  const todayKey = toLocalDateKey(new Date());
  const days = useMemo(
    () => Array.from({ length: range.totalDays }, (_, index) => addLocalDays(range.start, index)),
    [range],
  );

  const handleToday = () => {
    setAnchor(new Date());
    setMode('4w');
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    if (isMobile) return;
    const dayDelta = Math.round(event.delta.x / dayWidth);
    if (!dayDelta) return;
    const activeId = String(event.active.id);
    const [interaction, taskId] = activeId.includes(':') ? activeId.split(':', 2) : ['move', activeId];
    const task = datedTasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const shifted = interaction === 'start' || interaction === 'end'
      ? resizeTimelineDates(task, interaction, dayDelta)
      : shiftTimelineDates(task, dayDelta);
    setDragError(null);
    const ok = await onTaskPatch(task.id, {
      start_date: shifted.start_date,
      due_date: shifted.due_date,
    });
    if (!ok) setDragError(`Could not reschedule ${projectPrefix}-${task.number}. The previous dates were restored.`);
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden" style={{ background: 'var(--background)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarDays size={15} style={{ color: 'var(--accent)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>Timeline</h2>
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{datedTasks.length} scheduled</span>
          </div>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {range.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {range.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full p-1" style={{ background: 'var(--surface-subtle)', border: '1px solid var(--border)' }}>
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                aria-pressed={mode === option.value}
                className="h-7 rounded-full px-3 text-[11px] font-medium transition-colors"
                style={{
                  color: mode === option.value ? 'white' : 'var(--text-secondary)',
                  background: mode === option.value ? 'var(--accent)' : 'transparent',
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleToday}
            className="h-9 rounded-full px-3 text-[11px] font-semibold"
            style={{ color: 'var(--text-primary)', border: '1px solid var(--border)', background: 'var(--surface)' }}
          >
            Today
          </button>
        </div>
      </div>

      {dragError && (
        <div className="mx-4 mt-3 rounded-md px-3 py-2 text-xs" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 32%, transparent)' }}>
          {dragError}
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="min-h-0 flex-1 overflow-auto" data-testid="timeline-scroll-region">
          <div style={{ minWidth: railWidth + canvasWidth }}>
            <div className="sticky top-0 z-20 flex h-12" style={{ background: 'var(--background)', borderBottom: '1px solid var(--border)' }}>
              <div
                className="sticky left-0 z-30 flex flex-shrink-0 items-end px-4 pb-2 text-[10px] font-semibold uppercase"
                style={{ width: railWidth, color: 'var(--text-tertiary)', background: 'var(--background)', borderRight: '1px solid var(--border)' }}
              >
                Work
              </div>
              <div className="relative flex-shrink-0" style={{ width: canvasWidth }}>
                {days.map((day, index) => {
                  const isMonthStart = day.getDate() === 1;
                  return (
                    <div
                      key={toLocalDateKey(day)}
                      className="absolute inset-y-0 flex flex-col items-center justify-end pb-1"
                      style={{
                        left: index * dayWidth,
                        width: dayWidth,
                        borderLeft: isMonthStart ? '1px solid var(--text-tertiary)' : day.getDay() === 1 ? '1px solid var(--border)' : 'none',
                      }}
                      title={day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    >
                      <span className="text-[8px] uppercase" style={{ color: 'var(--text-tertiary)' }}>{day.toLocaleDateString('en-US', { weekday: 'narrow' })}</span>
                      <span className="text-[10px] font-medium" style={{ color: isMonthStart ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{day.getDate()}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {datedTasks.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center px-6 text-center">
                <div>
                  <CalendarDays size={22} className="mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} />
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No scheduled work yet</p>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>Add a start or due date to place a task on the timeline.</p>
                </div>
              </div>
            ) : datedTasks.map((task, rowIndex) => (
              <TimelineRow
                key={task.id}
                task={task}
                rowIndex={rowIndex}
                range={range}
                days={days}
                railWidth={railWidth}
                canvasWidth={canvasWidth}
                dayWidth={dayWidth}
                todayKey={todayKey}
                projectPrefix={projectPrefix}
                dragDisabled={isMobile}
                onTaskClick={onTaskClick}
              />
            ))}
          </div>
        </div>
      </DndContext>

      {undatedTasks.length > 0 && (
        <div className="flex-shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          <button
            type="button"
            onClick={() => setUndatedExpanded((value) => !value)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            {undatedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            No dates <span style={{ color: 'var(--text-tertiary)' }}>({undatedTasks.length})</span>
          </button>
          {undatedExpanded && (
            <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto px-4 pb-3 md:grid-cols-3">
              {undatedTasks.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  onClick={() => onTaskClick(task.id)}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover-tint)]"
                >
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: STATUS_COLORS[task.status] || STATUS_COLORS.backlog }} />
                  <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{projectPrefix}-{task.number}</span>
                  <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>{task.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  task,
  rowIndex,
  range,
  days,
  railWidth,
  canvasWidth,
  dayWidth,
  todayKey,
  projectPrefix,
  dragDisabled,
  onTaskClick,
}: {
  task: TimelineTask;
  rowIndex: number;
  range: ReturnType<typeof buildTimelineRange>;
  days: Date[];
  railWidth: number;
  canvasWidth: number;
  dayWidth: number;
  todayKey: string;
  projectPrefix: string;
  dragDisabled: boolean;
  onTaskClick: (taskId: string) => void;
}) {
  const geometry = timelineBarGeometry(task, range);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: dragDisabled });
  const color = STATUS_COLORS[task.status] || STATUS_COLORS.backlog;
  const start = parseLocalDate(task.start_date) ?? parseLocalDate(task.due_date);
  const end = parseLocalDate(task.due_date) ?? start;
  const title = `${projectPrefix}-${task.number} ${task.title}${start ? ` · ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}${end && end.getTime() !== start?.getTime() ? ` – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`;

  return (
    <div className="flex h-11" style={{ background: rowIndex % 2 ? 'var(--surface-subtle)' : 'transparent', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
      <button
        type="button"
        onClick={() => onTaskClick(task.id)}
        className="sticky left-0 z-10 flex flex-shrink-0 items-center gap-2 px-4 text-left"
        style={{ width: railWidth, background: rowIndex % 2 ? 'var(--surface-subtle)' : 'var(--background)', borderRight: '1px solid var(--border)' }}
        title={title}
      >
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} />
        <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{projectPrefix}-{task.number}</span>
        <span className="truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{task.title}</span>
      </button>
      <div className="relative flex-shrink-0" style={{ width: canvasWidth }}>
        {days.map((day, index) => {
          const key = toLocalDateKey(day);
          const isToday = key === todayKey;
          const isMonthStart = day.getDate() === 1;
          const isWeekStart = day.getDay() === 1;
          return (
            <div
              key={key}
              className="absolute inset-y-0"
              style={{
                left: index * dayWidth,
                width: dayWidth,
                background: isToday ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent',
                borderLeft: isToday ? '1px solid var(--accent)' : isMonthStart ? '1px solid var(--text-tertiary)' : isWeekStart ? '1px solid var(--border)' : 'none',
              }}
            />
          );
        })}
        {geometry.visible ? (
          <div
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            role="button"
            tabIndex={0}
            onClick={() => { if (!isDragging) onTaskClick(task.id); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onTaskClick(task.id);
              }
            }}
            className="absolute top-[9px] z-10 flex h-[26px] items-center overflow-hidden rounded-[5px] px-2 text-left shadow-sm outline-none transition-[filter,box-shadow] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{
              left: geometry.left * canvasWidth / 100,
              width: Math.max(geometry.width * canvasWidth / 100, 28),
              background: `color-mix(in srgb, ${color} 78%, var(--surface))`,
              border: `1px solid color-mix(in srgb, ${color} 88%, white)`,
              color: 'white',
              cursor: dragDisabled ? 'pointer' : isDragging ? 'grabbing' : 'grab',
              opacity: isDragging ? 0.82 : 1,
              transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
              boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.24)' : undefined,
            }}
            title={dragDisabled ? title : `${title} · drag to reschedule`}
            aria-label={title}
          >
            {!dragDisabled && <ResizeHandle taskId={task.id} edge="start" color={color} />}
            {!dragDisabled && <GripVertical size={12} className="mr-1 flex-shrink-0 opacity-70" aria-hidden="true" />}
            {geometry.before && <span className="mr-1" aria-hidden="true">‹</span>}
            <span className="truncate text-[11px] font-semibold">{task.title}</span>
            {geometry.after && <span className="ml-1" aria-hidden="true">›</span>}
            {!dragDisabled && <ResizeHandle taskId={task.id} edge="end" color={color} />}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onTaskClick(task.id)}
            className="absolute top-[11px] z-10 h-5 rounded-full px-2 text-[10px] font-semibold"
            style={{
              left: geometry.before ? 4 : canvasWidth - 62,
              color,
              background: `color-mix(in srgb, ${color} 14%, var(--surface))`,
              border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
            }}
            title={title}
          >
            {geometry.before ? '‹ earlier' : 'later ›'}
          </button>
        )}
      </div>
    </div>
  );
}

function ResizeHandle({ taskId, edge, color }: { taskId: string; edge: 'start' | 'end'; color: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `${edge}:${taskId}` });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={(event) => event.stopPropagation()}
      className={`absolute inset-y-0 z-20 w-2 cursor-ew-resize opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 ${edge === 'start' ? 'left-0' : 'right-0'}`}
      style={{
        background: `color-mix(in srgb, ${color} 45%, white)`,
        borderRadius: edge === 'start' ? '5px 0 0 5px' : '0 5px 5px 0',
        opacity: isDragging ? 1 : undefined,
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
      }}
      title={`Drag to change ${edge === 'start' ? 'start' : 'due'} date`}
      aria-label={`Change ${edge === 'start' ? 'start' : 'due'} date`}
    />
  );
}
