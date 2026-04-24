'use client';

/**
 * WidgetShell — the frame around every widget.
 *
 * In edit mode the header becomes a drag handle (class `.widget-drag-handle`,
 * matched by DashboardGrid's `draggableHandle`) and the "View →" link is
 * swapped for a remove button.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { GripVertical, X } from 'lucide-react';

export type WidgetShellProps = {
  title: string;
  count?: number;
  href?: string;
  children: ReactNode;
  editMode?: boolean;
  onRemove?: () => void;
};

export function WidgetShell({
  title, count, href, children, editMode = false, onRemove,
}: WidgetShellProps) {
  return (
    <div
      className="widget-shell"
      data-edit={editMode || undefined}
      style={{
        display: 'flex', flexDirection: 'column', minHeight: 0,
        height: '100%', width: '100%',
        background: 'var(--bg-surface)',
        border: editMode
          ? '1px dashed var(--border-strong)'
          : '1px solid var(--border-default)',
        borderRadius: 12,
        padding: 16,
        overflow: 'hidden',
        transition: 'border-color 140ms, box-shadow 140ms',
      }}
    >
      <header
        className={editMode ? 'widget-drag-handle' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
          cursor: editMode ? 'grab' : undefined,
          userSelect: editMode ? 'none' : undefined,
        }}
      >
        {editMode && (
          <GripVertical
            size={13}
            strokeWidth={1.8}
            style={{ color: 'var(--text-tertiary)', marginLeft: -2 }}
          />
        )}
        <h3 style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-secondary)', margin: 0,
        }}>{title}</h3>
        {typeof count === 'number' && count > 0 && (
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
          }}>{count}</span>
        )}
        <span style={{ flex: 1 }} />
        {editMode ? (
          onRemove && (
            <button
              onClick={onRemove}
              onMouseDown={e => e.stopPropagation()}
              title="Remove widget"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 6,
                color: 'var(--text-tertiary)', background: 'transparent',
                border: '1px solid var(--border-default)', cursor: 'pointer',
                transition: 'background 140ms, color 140ms',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--bg-hover)';
                e.currentTarget.style.color = 'var(--status-red)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              <X size={12} strokeWidth={1.8} />
            </button>
          )
        ) : href ? (
          <Link href={href} style={{
            fontSize: 11, color: 'var(--text-tertiary)', textDecoration: 'none',
            transition: 'color 140ms',
          }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}>
            View →
          </Link>
        ) : null}
      </header>
      <div
        style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          pointerEvents: editMode ? 'none' : undefined,
          opacity: editMode ? 0.7 : 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
