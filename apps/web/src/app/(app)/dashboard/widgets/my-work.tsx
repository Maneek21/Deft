'use client';
import Link from 'next/link';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import type { Task } from '../lib/facade';
import { PRI_COLOR, PRI_LABEL, statusLabel } from '../lib/shared';

function MyWorkWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;
  const kanban: Record<string, Task[]> = { todo: [], in_progress: [], in_review: [] };
  const seen = new Set<string>();
  (core.my_work ?? []).forEach(t => {
    if (seen.has(t.id)) return; seen.add(t.id);
    if (kanban[t.status]) kanban[t.status].push(t);
  });

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14,
      height: '100%',
    }}>
      {(['todo', 'in_progress', 'in_review'] as const).map(status => {
        const items = kanban[status] || [];
        const dot = status === 'in_progress' ? 'var(--status-amber)'
          : status === 'in_review' ? 'var(--status-blue)'
          : 'var(--text-tertiary)';
        return (
          <div key={status} style={{ minWidth: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
              paddingBottom: 8, borderBottom: '1px solid var(--border-default)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: dot }} />
              <span style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--text-secondary)',
              }}>{statusLabel(status)}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                {items.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.slice(0, 5).map(t => (
                <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} style={{
                  display: 'block', padding: '9px 10px', borderRadius: 8,
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-default)',
                  textDecoration: 'none', color: 'inherit',
                  transition: 'border-color 140ms',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 4, height: 4, borderRadius: 99, background: PRI_COLOR[t.priority] }} />
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      {t.project_prefix}-{t.number}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                      color: PRI_COLOR[t.priority], opacity: 0.8,
                    }}>{PRI_LABEL[t.priority]}</span>
                  </div>
                  <div style={{
                    fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.35,
                    overflow: 'hidden', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>{t.title}</div>
                  {t.due_date && (
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                      {new Date(t.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  )}
                </Link>
              ))}
              {items.length === 0 && (
                <p style={{
                  fontSize: 12, color: 'var(--text-tertiary)',
                  padding: '14px 0', textAlign: 'center', margin: 0,
                }}>
                  {status === 'todo' ? 'Nothing queued' :
                    status === 'in_progress' ? 'Nothing in flight' : 'Nothing in review'}
                </p>
              )}
              {items.length > 5 && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', margin: 2 }}>
                  + {items.length - 5} more
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const myWorkDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.my-work',
  title: 'My work',
  description: 'Your kanban — to do, in progress, in review.',
  category: 'work',
  defaultSize: { w: 8, h: 5 },
  minSize: { w: 5, h: 4 },
  Component: MyWorkWidget,
};
