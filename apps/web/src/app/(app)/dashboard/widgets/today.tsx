'use client';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import type { Task } from '../lib/facade';
import { PRI_COLOR } from '../lib/shared';

function TaskRow({ t, overdue }: { t: Task; overdue: boolean }) {
  const due = t.due_date ? new Date(t.due_date) : null;
  return (
    <Link href={`/tasks?task=${t.project_prefix}-${t.number}`} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', marginLeft: -12, marginRight: -12,
      borderRadius: 8, textDecoration: 'none', color: 'inherit',
      transition: 'background 140ms',
    }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {t.status === 'done'
        ? <CheckCircle2 size={14} style={{ color: 'var(--status-green)', flexShrink: 0 }} />
        : <Circle size={14} strokeWidth={2} style={{ color: PRI_COLOR[t.priority], flexShrink: 0 }} />}
      <span style={{
        fontSize: 14, color: 'var(--text-primary)', flex: 1, lineHeight: 1.35,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{t.title}</span>
      {overdue && (
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
          padding: '2px 6px', borderRadius: 4,
          background: 'rgba(239, 68, 68, 0.12)', color: 'var(--status-red)',
          textTransform: 'uppercase',
        }}>Overdue</span>
      )}
      <span style={{
        fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)',
      }}>{t.project_prefix}-{t.number}</span>
      {due && (
        <span style={{
          fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)',
          minWidth: 52, textAlign: 'right',
        }}>{due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      )}
    </Link>
  );
}

function TodayWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;
  const seen = new Set<string>();
  const todayUnique = [...core.overdue, ...core.due_today]
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
    .sort((a, b) => {
      const o: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
      return (o[a.priority] ?? 3) - (o[b.priority] ?? 3);
    });
  const laterThisWeek = core.due_this_week.filter(t => t.status !== 'done').length;

  if (todayUnique.length === 0) {
    return (
      <div style={{ padding: '28px 0', textAlign: 'center' }}>
        <p style={{ fontSize: 15, color: 'var(--text-primary)', margin: 0, fontWeight: 500, letterSpacing: '-0.01em' }}>
          Nothing due today.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
          {laterThisWeek > 0
            ? `${laterThisWeek} task${laterThisWeek === 1 ? '' : 's'} due later this week.`
            : 'Nothing else on the horizon.'}
        </p>
      </div>
    );
  }
  return (
    <div style={{ padding: '2px 0' }}>
      {todayUnique.slice(0, 10).map(t => (
        <TaskRow key={t.id} t={t} overdue={core.overdue.some(o => o.id === t.id)} />
      ))}
    </div>
  );
}

export const todayDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.today',
  title: 'Today',
  description: 'Overdue + tasks due today, priority-sorted.',
  category: 'work',
  defaultSize: { w: 8, h: 4 },
  minSize: { w: 4, h: 3 },
  Component: TodayWidget,
};
