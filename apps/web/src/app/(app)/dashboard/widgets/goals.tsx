'use client';
import { Target } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type Goal = {
  id: string;
  title: string;
  progress: number; // 0..1
  confidence: 'on-track' | 'at-risk' | 'off-track';
};

function GoalsWidget(_props: WidgetProps) {
  // Goals data isn't in the facade yet. Renders shape, plugs in later.
  const goals: Goal[] = [];

  if (goals.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <Target size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          No goals set for this quarter.<br/>Track OKRs here once they're defined.
        </p>
      </div>
    );
  }

  const dot = (c: Goal['confidence']) =>
    c === 'on-track' ? 'var(--status-green)' :
    c === 'at-risk' ? 'var(--status-amber)' :
    'var(--status-red)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {goals.map(g => (
        <div key={g.id}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 99,
              background: dot(g.confidence), flexShrink: 0,
            }} />
            <span style={{
              flex: 1, fontSize: 12.5, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{g.title}</span>
            <span style={{
              fontSize: 11, color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}>{Math.round(g.progress * 100)}%</span>
          </div>
          <div style={{
            height: 4, borderRadius: 2,
            background: 'var(--border-default)', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: `${g.progress * 100}%`,
              background: dot(g.confidence),
              borderRadius: 2,
              transition: 'width 400ms',
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export const goalsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.goals',
  title: 'Goals',
  description: 'Quarterly goals and OKR progress.',
  icon: Target,
  category: 'insights',
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 3, h: 2 },
  Component: GoalsWidget,
};
