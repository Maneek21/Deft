'use client';
import { PartyPopper, Cake, Briefcase } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type Celebration = {
  id: string;
  kind: 'birthday' | 'anniversary' | 'onboarding';
  who: string;
  when: string;
  detail?: string;
};

function CelebrationsWidget(_props: WidgetProps) {
  // Celebration data isn't in the facade yet. This widget renders the shape
  // so the intent is visible; real data plugs in via a future api method.
  const items: Celebration[] = [];

  if (items.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <PartyPopper size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          No celebrations this week.<br/>Birthdays and work anniversaries will show up here.
        </p>
      </div>
    );
  }

  const icon = (k: Celebration['kind']) =>
    k === 'birthday' ? <Cake size={12} strokeWidth={1.8} style={{ color: 'var(--status-amber)' }} /> :
    k === 'anniversary' ? <Briefcase size={12} strokeWidth={1.8} style={{ color: 'var(--accent)' }} /> :
    <PartyPopper size={12} strokeWidth={1.8} style={{ color: 'var(--status-green)' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(c => (
        <div key={c.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', borderRadius: 8,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
        }}>
          {icon(c.kind)}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500 }}>{c.who}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.detail ?? c.kind}</div>
          </div>
          <span style={{
            fontSize: 10.5, color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}>{c.when}</span>
        </div>
      ))}
    </div>
  );
}

export const celebrationsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.celebrations',
  title: 'Celebrations',
  description: 'Birthdays, work anniversaries, onboarding milestones.',
  icon: PartyPopper,
  category: 'team',
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 3, h: 2 },
  Component: CelebrationsWidget,
};
