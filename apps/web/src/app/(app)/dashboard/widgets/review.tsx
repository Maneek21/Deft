'use client';
import Link from 'next/link';
import { Inbox, Circle } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { PRI_COLOR } from '../lib/shared';

function ReviewWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;

  const items = core.my_work.filter(t => t.status === 'in_review').slice(0, 8);

  if (items.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <Inbox size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          Nothing waiting on you.<br/>Review requests show up here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {items.map(t => (
        <Link key={t.id} href={`/tasks?task=${t.project_prefix}-${t.number}`} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 8px', marginLeft: -8, marginRight: -8,
          borderRadius: 7, textDecoration: 'none', color: 'inherit',
          transition: 'background 120ms',
        }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Circle size={12} strokeWidth={2} style={{ color: PRI_COLOR[t.priority], flexShrink: 0 }} />
          <span style={{
            flex: 1, fontSize: 13, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{t.title}</span>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)', flexShrink: 0,
          }}>{t.project_prefix}-{t.number}</span>
        </Link>
      ))}
    </div>
  );
}

export const reviewDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.review',
  title: 'In review',
  description: 'Tasks parked in review waiting on you.',
  icon: Inbox,
  category: 'work',
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 3, h: 2 },
  Component: ReviewWidget,
};
