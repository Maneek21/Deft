'use client';
import Link from 'next/link';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';

function LinearProgress({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{
      position: 'relative', height: 4, width: '100%',
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 2, overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0, width: `${Math.max(0, Math.min(100, pct))}%`,
        background: color, borderRadius: 2,
        transition: 'width 400ms ease',
      }} />
    </div>
  );
}

function ProjectsWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;
  if (core.projects.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>No projects yet.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {core.projects.slice(0, 6).map(p => {
        const pct = p.total_tasks > 0 ? Math.round((p.done_tasks / p.total_tasks) * 100) : 0;
        const color = p.color || 'var(--accent)';
        return (
          <Link key={p.id} href={`/tasks?project=${p.id}`} style={{
            textDecoration: 'none', color: 'inherit', display: 'block',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
              <span style={{
                fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)',
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{p.name}</span>
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)',
              }}>{p.done_tasks}/{p.total_tasks}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums',
                minWidth: 32, textAlign: 'right',
              }}>{pct}%</span>
            </div>
            <LinearProgress pct={pct} color={color} />
          </Link>
        );
      })}
    </div>
  );
}

export const projectsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.projects',
  title: 'Projects',
  description: 'Project progress at a glance.',
  category: 'work',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: ProjectsWidget,
};
