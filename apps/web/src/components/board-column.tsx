'use client';

import { useDroppable } from '@dnd-kit/core';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';

type Props = {
  id: string;
  label: string;
  count: number;
  onAdd: () => void;
  children: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  todo: 'var(--foreground-secondary)',
  in_progress: 'var(--accent)',
  in_review: '#8B5CF6',
  done: 'var(--success)',
  cancelled: 'var(--muted)',
};

export function BoardColumn({
  id,
  label,
  count,
  onAdd,
  children,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const isCollapsed = collapsible && collapsed;

  return (
    <div
      className="flex flex-col w-[280px] min-w-[280px] rounded-lg"
      style={{
        background: isOver ? 'var(--accent-subtle)' : 'var(--surface)',
        transition: 'background 150ms',
      }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0">
        <button
          type="button"
          onClick={collapsible ? onToggleCollapse : undefined}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          style={{
            cursor: collapsible ? 'pointer' : 'default',
            background: 'transparent',
            border: 'none',
            padding: 0,
          }}
          aria-expanded={collapsible ? !isCollapsed : undefined}
          aria-label={collapsible ? `${isCollapsed ? 'Expand' : 'Collapse'} ${label} column` : undefined}
        >
          {collapsible && (
            <span
              className="flex-shrink-0"
              style={{ color: 'var(--muted)' }}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </span>
          )}
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: STATUS_COLORS[id] || 'var(--muted)' }}
          />
          <span
            className="text-[12px] font-semibold uppercase tracking-wide"
            style={{
              color: 'var(--foreground-secondary)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            {label}
          </span>
          <span
            className="text-[11px] font-medium px-1.5 py-0.5 rounded-full"
            style={{
              color: 'var(--muted)',
              background: 'var(--hover-tint)',
            }}
          >
            {count}
          </span>
        </button>
        <button
          onClick={onAdd}
          className="p-1 rounded-md"
          style={{ color: 'var(--muted)', transition: 'color 150ms' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Scrollable card list (hidden when collapsed) */}
      {!isCollapsed && (
        <div
          ref={setNodeRef}
          className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-1.5 min-h-[60px]"
        >
          {count === 0 && (
            <p
              className="text-[11px] text-center py-3"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
            >
              No tasks
            </p>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
