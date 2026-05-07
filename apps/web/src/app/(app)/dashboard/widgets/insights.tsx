'use client';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';

function InsightsWidget(_props: WidgetProps) {
  const { insights } = useDashboardData();
  if (!insights) {
    return <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>Insights loading…</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { label: 'Shipped', value: insights.activity.tasks_completed, c: 'var(--status-green)' },
          { label: 'Messages', value: insights.activity.messages_sent, c: 'var(--accent)' },
          { label: 'Spaces', value: insights.activity.spaces_active.length, c: 'var(--status-amber)' },
        ].map(m => (
          <div key={m.label}>
            <div style={{
              fontSize: 22, fontWeight: 700, lineHeight: 1,
              color: 'var(--text-primary)',
              fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
            }}>{m.value}</div>
            <div style={{
              fontSize: 10, color: 'var(--text-tertiary)',
              letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 2,
            }}>{m.label}</div>
          </div>
        ))}
      </div>
      {insights.pace.length > 0 && (
        <div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4,
          }}>
            <span>Weekly pace</span>
            <span>{insights.pace[insights.pace.length - 1].completed} this week</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 32 }}>
            {insights.pace.map((w, i) => {
              const max = Math.max(...insights.pace.map(p => p.completed), 1);
              const h = Math.max((w.completed / max) * 100, 6);
              const isLast = i === insights.pace.length - 1;
              return (
                <div key={i} style={{
                  flex: 1, height: `${h}%`,
                  background: isLast ? 'var(--accent)' : 'var(--accent-muted)',
                  borderRadius: 2,
                }} />
              );
            })}
          </div>
        </div>
      )}
      {insights.expertise.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {insights.expertise.slice(0, 6).map(e => (
            <span key={e.topic} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 99, fontWeight: 500,
              background: 'var(--accent-muted)', color: 'var(--accent)',
            }}>{e.topic}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export const insightsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.insights',
  title: 'My insights',
  description: 'Your personal activity snapshot.',
  category: 'insights',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: InsightsWidget,
};
