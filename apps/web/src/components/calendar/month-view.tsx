'use client';

import { useState } from 'react';
import { CalEvent, CalTask, DayBucket, toDateKey, buildMonthGrid, CAL_DAYS, ITEM_COLORS, getEventSourceColor } from '@/lib/calendar';
import { CalendarItem } from './calendar-item';
import { TaskCardUnified } from '@/components/task-card-unified';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDroppable, useDraggable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';

const MAX_ITEMS = 3;

export function MonthView({
  anchor, buckets, selectedDay, onSelectDay, onDrillDown,
  briefs, onTaskReschedule, onEventClick,
}: {
  anchor: Date;
  buckets: Map<string, DayBucket>;
  selectedDay: string | null;
  onSelectDay: (dateKey: string) => void;
  onDrillDown: (dateKey: string) => void;
  briefs?: Map<string, string>;
  onTaskReschedule?: (taskId: string, newDateKey: string) => void;
  onEventClick?: (event: CalEvent) => void;
}) {
  const grid = buildMonthGrid(anchor);
  const today = toDateKey(new Date());
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // DnD setup
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTaskId(null);
    if (over && onTaskReschedule) {
      const taskId = active.id as string;
      const targetDateKey = over.id as string;
      // Find which day the task is currently on
      const currentDay = findTaskDay(taskId, buckets);
      if (currentDay && currentDay !== targetDateKey) {
        onTaskReschedule(taskId, targetDateKey);
      }
    }
  };

  // Find active task for drag overlay
  const activeTask = activeTaskId ? findTask(activeTaskId, buckets) : null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Day-of-week header */}
        <div className="grid grid-cols-7 mb-1">
          {CAL_DAYS.map((d, i) => (
            <div key={i} className="text-center text-[11px] font-semibold py-2"
              style={{ color: 'var(--text-tertiary)' }}>
              {d}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7 flex-1 min-h-0"
          style={{ gridTemplateRows: 'repeat(6, minmax(0, 1fr))' }}>
          {grid.map((date, i) => {
            const key = toDateKey(date);
            const inMonth = date.getMonth() === anchor.getMonth();
            const isToday = key === today;
            const isSelected = key === selectedDay;
            const bucket = buckets.get(key);
            const items = getItems(bucket, briefs);
            const overflow = items.length > MAX_ITEMS ? items.length - MAX_ITEMS : 0;

            return (
              <DroppableDay key={i} dateKey={key}
                inMonth={inMonth} isToday={isToday} isSelected={isSelected}
                onClick={() => onSelectDay(isSelected ? '' : key)}
                onDoubleClick={() => onDrillDown(key)}>
                {/* Date number */}
                <div className="flex items-center justify-between mb-0.5">
                  <span
                    className={`text-[11px] font-medium w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'font-bold' : ''}`}
                    style={{
                      color: isToday ? 'white' : 'var(--text-primary)',
                      background: isToday ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {date.getDate()}
                  </span>
                  {/* Mobile dots */}
                  <div className="flex gap-px md:hidden">
                    {bucket?.events.length ? <div className="w-[5px] h-[5px] rounded-full" style={{ background: ITEM_COLORS.event }} /> : null}
                    {bucket?.tasks.length ? <div className="w-[5px] h-[5px] rounded-full" style={{ background: ITEM_COLORS.task }} /> : null}
                    {bucket?.notes.length ? <div className="w-[5px] h-[5px] rounded-full" style={{ background: ITEM_COLORS.note }} /> : null}
                    {bucket?.reminders.length ? <div className="w-[5px] h-[5px] rounded-full" style={{ background: ITEM_COLORS.reminder }} /> : null}
                  </div>
                </div>

                {/* Items (hidden on mobile) */}
                <div className="hidden md:flex flex-col gap-0.5 flex-1 min-h-0 overflow-hidden">
                  {items.slice(0, MAX_ITEMS).map((item) => (
                    item.type === 'task' && item.task ? (
                      // Task 6.6 — tasks use the calendar variant of
                      // TaskCardUnified so status/priority dots stay
                      // consistent with the board + dashboard surfaces.
                      <DraggableTask key={item.id} id={item.id}>
                        <TaskCardUnified
                          variant="calendar"
                          task={{
                            id: item.task.id,
                            number: item.task.number,
                            title: item.task.title,
                            status: item.task.status,
                            priority: item.task.priority as 'p0' | 'p1' | 'p2' | 'p3',
                            project_prefix: item.task.project_prefix,
                            due_date: item.task.due_date,
                          }}
                        />
                      </DraggableTask>
                    ) : (
                      <CalendarItem
                        key={item.id}
                        type={item.type}
                        title={item.title}
                        time={item.time}
                        hasBrief={item.hasBrief}
                        color={item.color}
                        onClick={item.type === 'event' && item.event ? () => onEventClick?.(item.event!) : undefined}
                      />
                    )
                  ))}
                  {overflow > 0 && (
                    <span className="text-[10px] px-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      +{overflow} more
                    </span>
                  )}
                </div>
              </DroppableDay>
            );
          })}
        </div>
      </div>

      {/* Drag overlay */}
      <DragOverlay>
        {activeTask ? (
          <div className="px-2 py-1 rounded text-[11px] font-medium shadow-lg"
            style={{ background: `${ITEM_COLORS.task}30`, color: 'var(--text-primary)', border: `1px solid ${ITEM_COLORS.task}` }}>
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ── Sub-components ──

function DroppableDay({ dateKey, inMonth, isToday, isSelected, onClick, onDoubleClick, children }: {
  dateKey: string; inMonth: boolean; isToday: boolean; isSelected: boolean;
  onClick: () => void; onDoubleClick: () => void; children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dateKey });
  return (
    <div ref={setNodeRef}
      onClick={onClick} onDoubleClick={onDoubleClick}
      className="flex flex-col p-1 cursor-pointer transition-colors overflow-hidden"
      style={{
        opacity: inMonth ? 1 : 0.3,
        background: isOver
          ? 'var(--accent-muted, rgba(99,102,241,0.12))'
          : isSelected
            ? 'var(--bg-active)'
            : isToday
              ? 'var(--accent-muted, rgba(99,102,241,0.06))'
              : 'transparent',
        borderRight: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)',
        outline: isOver ? '2px solid var(--accent)' : 'none',
        outlineOffset: '-2px',
      }}
    >
      {children}
    </div>
  );
}

function DraggableTask({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      style={{ opacity: isDragging ? 0.3 : 1 }}>
      {children}
    </div>
  );
}

// ── Helpers ──

type FlatItem = { id: string; type: 'event' | 'task' | 'note' | 'reminder'; title: string; time?: string; hasBrief?: boolean; color?: string; event?: CalEvent; task?: CalTask };

function getItems(bucket: DayBucket | undefined, briefs?: Map<string, string>): FlatItem[] {
  if (!bucket) return [];
  const items: FlatItem[] = [];
  for (const e of bucket.events) {
    const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    items.push({ id: e.id, type: 'event', title: e.title, time, hasBrief: briefs?.has(e.id), color: getEventSourceColor(e.source), event: e });
  }
  for (const t of bucket.tasks) {
    items.push({ id: t.id, type: 'task', title: t.title, task: t });
  }
  for (const r of bucket.reminders) {
    const time = new Date(r.remind_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    items.push({ id: r.id, type: 'reminder', title: `⏰ ${r.message}`, time });
  }
  for (const n of bucket.notes) {
    items.push({ id: n.id, type: 'note', title: n.title || 'Untitled' });
  }
  return items;
}

function findTaskDay(taskId: string, buckets: Map<string, DayBucket>): string | null {
  for (const [key, bucket] of buckets) {
    if (bucket.tasks.some((t) => t.id === taskId)) return key;
  }
  return null;
}

function findTask(taskId: string, buckets: Map<string, DayBucket>) {
  for (const bucket of buckets.values()) {
    const t = bucket.tasks.find((t) => t.id === taskId);
    if (t) return t;
  }
  return null;
}
