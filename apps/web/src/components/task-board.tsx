'use client';

import { useMemo, useState, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TaskCard } from './task-card';
import { BoardColumn } from './board-column';

type Task = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  created_by: string;
  creator_name: string | null;
  due_date: string | null;
  start_date: string | null;
  sort_order: number;
  source_message_id: string | null;
  is_deleted: boolean;
  project_id: string;
  project_prefix: string;
  project_name: string;
  project_color: string | null;
  labels: { id: string; name: string; color: string }[];
  parent_task_id: string | null;
  subtask_count: number;
  subtask_done_count: number;
  estimation?: string | null;
  created_at: string;
  updated_at: string;
};

type Props = {
  tasks: Task[];
  projectPrefix: string;
  onTaskClick: (task: Task) => void;
  onStatusChange: (taskId: string, newStatus: string) => void;
  onReorder: (taskId: string, newSortOrder: number) => void;
  onColumnAdd: (status: string) => void;
  selectedTaskId: string | null;
  onDuplicate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  selectionMode?: boolean;
  selectedTaskIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
};

const COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
] as const;

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

export function TaskBoard({
  tasks,
  projectPrefix,
  onTaskClick,
  onStatusChange,
  onReorder,
  onColumnAdd,
  selectedTaskId,
  onDuplicate,
  onDelete,
  selectionMode,
  selectedTaskIds,
  onToggleSelect,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<Record<string, string>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [mobileColumn, setMobileColumn] = useState<string>('in_progress');

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const columnTasks = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const col of COLUMNS) {
      map[col.id] = tasks
        .filter((t) => {
          if (!t) return false;
          // Use pending status override if the task is being dragged between columns
          const effectiveStatus = pendingStatus[t.id] || t.status;
          return effectiveStatus === col.id;
        })
        .sort((a, b) => a.sort_order - b.sort_order);
    }
    return map;
  }, [tasks, pendingStatus]);

  const activeTask = activeId ? tasks.find((t) => t?.id === activeId) : null;

  function findColumn(taskId: string): string | undefined {
    for (const col of COLUMNS) {
      if (columnTasks[col.id]?.some((t) => t.id === taskId)) {
        return col.id;
      }
    }
    return undefined;
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeCol = findColumn(active.id as string);
    // Check if dropped over a column directly
    const overCol = COLUMNS.find((c) => c.id === over.id)
      ? (over.id as string)
      : findColumn(over.id as string);

    if (activeCol && overCol && activeCol !== overCol) {
      // Use local pending state for visual column move during drag (no API call yet)
      setPendingStatus((prev) => ({ ...prev, [active.id as string]: overCol }));
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const draggedId = active.id as string;
    const newStatus = pendingStatus[draggedId];

    // Clear drag state in a single update
    setActiveId(null);
    setPendingStatus((prev) => {
      const next = { ...prev };
      delete next[draggedId];
      return next;
    });

    if (!over) return;

    const overCol = COLUMNS.find((c) => c.id === over.id)
      ? (over.id as string)
      : findColumn(over.id as string);

    if (!overCol) return;

    // Commit the status change (single call, not duplicated from handleDragOver)
    if (newStatus && newStatus !== tasks.find((t) => t?.id === draggedId)?.status) {
      onStatusChange(draggedId, newStatus);
    }

    // Calculate new sort order
    const colItems = columnTasks[overCol] || [];
    const overIndex = colItems.findIndex((t) => t.id === over.id);
    if (overIndex >= 0) {
      const prevOrder = overIndex > 0 ? colItems[overIndex - 1].sort_order : 0;
      const nextOrder = overIndex < colItems.length - 1 ? colItems[overIndex + 1].sort_order : prevOrder + 2000;
      const newOrder = Math.floor((prevOrder + nextOrder) / 2);
      onReorder(draggedId, newOrder);
    }
  }

  if (isMobile) {
    const mobileColTasks = columnTasks[mobileColumn] || [];
    return (
      <div className="flex flex-col h-full">
        {/* Status tabs */}
        <div className="flex gap-1.5 overflow-x-auto px-4 py-2 flex-shrink-0" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
          {COLUMNS.map((col) => (
            <button
              key={col.id}
              onClick={() => setMobileColumn(col.id)}
              className="px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap flex-shrink-0"
              style={{
                background: mobileColumn === col.id ? 'var(--primary-container, var(--accent))' : 'var(--surface-container, var(--surface))',
                color: mobileColumn === col.id ? '#fff' : 'var(--on-surface-variant, var(--muted))',
                fontFamily: 'var(--font-heading)',
                transition: 'all 150ms',
              }}
            >
              {STATUS_LABELS[col.id] || col.label} ({(columnTasks[col.id] || []).length})
            </button>
          ))}
        </div>
        {/* Tasks for selected status */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
          {mobileColTasks.length === 0 && (
            <div className="flex items-center justify-center py-12" style={{ color: 'var(--muted)' }}>
              <p className="text-[13px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks in {STATUS_LABELS[mobileColumn]}</p>
            </div>
          )}
          {mobileColTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              projectPrefix={projectPrefix}
              onClick={() => onTaskClick(task)}
              isSelected={task.id === selectedTaskId}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              selectionMode={selectionMode}
              isChecked={selectedTaskIds?.has(task.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full overflow-x-auto px-4 py-4 gap-3">
        {COLUMNS.map((col) => {
          const colItems = columnTasks[col.id];
          return (
            <BoardColumn
              key={col.id}
              id={col.id}
              label={col.label}
              count={colItems.length}
              onAdd={() => onColumnAdd(col.id)}
            >
              <SortableContext
                items={colItems.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {colItems.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    projectPrefix={projectPrefix}
                    onClick={() => onTaskClick(task)}
                    isSelected={task.id === selectedTaskId}
                    onDuplicate={onDuplicate}
                    onDelete={onDelete}
                    selectionMode={selectionMode}
                    isChecked={selectedTaskIds?.has(task.id)}
                    onToggleSelect={onToggleSelect}
                  />
                ))}
              </SortableContext>
            </BoardColumn>
          );
        })}
      </div>

      <DragOverlay>
        {activeTask ? (
          <TaskCard
            task={activeTask}
            projectPrefix={projectPrefix}
            onClick={() => {}}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
