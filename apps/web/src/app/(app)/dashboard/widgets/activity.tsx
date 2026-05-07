'use client';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { fmtActivityParts, initials } from '../lib/shared';
import { formatRelativeCompact } from '@/lib/time';

function ActivityWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;
  if (core.recent_activity.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>No recent activity.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {core.recent_activity.slice(0, 8).map(a => {
        const { who, verb, task } = fmtActivityParts(a);
        return (
          <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{
              display: 'grid', placeItems: 'center', width: 20, height: 20,
              borderRadius: 5, flexShrink: 0,
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              fontSize: 9, fontWeight: 700,
            }}>{initials(who)}</span>
            <span style={{
              fontSize: 12, color: 'var(--text-secondary)', flex: 1, lineHeight: 1.4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{who}</span>
              {' '}{verb}{' '}
              {task && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-primary)' }}>
                  {task}
                </span>
              )}
            </span>
            <span style={{
              fontSize: 10, color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)', flexShrink: 0,
            }}>{formatRelativeCompact(a.created_at)}</span>
          </div>
        );
      })}
    </div>
  );
}

export const activityDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.activity',
  title: 'Activity',
  description: 'Recent workspace activity from teammates.',
  category: 'activity',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: ActivityWidget,
};
