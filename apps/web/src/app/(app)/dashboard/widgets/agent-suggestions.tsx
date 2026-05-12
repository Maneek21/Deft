'use client';
import Link from 'next/link';
import { Lightbulb, ArrowRight } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';

type Suggestion = {
  id: string;
  label: string;
  detail: string;
  href: string;
  accent?: string;
};

function AgentSuggestionsWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;

  const suggestions: Suggestion[] = [];
  const overdueN = core.overdue.length;
  const unreadTotal = core.unread_spaces.reduce((s, u) => s + u.unread_count, 0);
  const reviewN = core.my_work.filter(t => t.status === 'in_review').length;

  if (overdueN > 0) {
    suggestions.push({
      id: 'overdue',
      label: `Chase ${overdueN} overdue task${overdueN === 1 ? '' : 's'}`,
      detail: 'Draft a nudge to each assignee.',
      href: '/chat',
      accent: 'var(--status-red)',
    });
  }
  if (!core.standup) {
    suggestions.push({
      id: 'standup',
      label: 'Write today\u2019s standup',
      detail: 'Summarize yesterday, today, blockers.',
      href: '#standup',
      accent: 'var(--status-amber)',
    });
  }
  if (unreadTotal > 10) {
    suggestions.push({
      id: 'unread',
      label: `Summarize ${unreadTotal} unread message${unreadTotal === 1 ? '' : 's'}`,
      detail: 'Short digest across all spaces.',
      href: '/chat',
      accent: 'var(--status-blue)',
    });
  }
  if (reviewN > 0) {
    suggestions.push({
      id: 'review',
      label: `${reviewN} task${reviewN === 1 ? '' : 's'} in review`,
      detail: 'Walk through them in a single pass.',
      href: '/tasks?filter=in_review',
      accent: 'var(--accent)',
    });
  }
  if (core.projects.some(p => p.total_tasks > 0 && p.done_tasks / p.total_tasks > 0.8)) {
    suggestions.push({
      id: 'project',
      label: 'Tee up a project retro',
      detail: 'One project is >80% complete.',
      href: '/chat',
      accent: 'var(--status-green)',
    });
  }

  if (suggestions.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <Lightbulb size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          Nothing obvious. Things are calm.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {suggestions.map(s => (
        <Link key={s.id} href={s.href} style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 10px', borderRadius: 8,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
          textDecoration: 'none', color: 'inherit',
          transition: 'background 140ms, border-color 140ms',
        }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border-strong)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'var(--bg-primary)';
            e.currentTarget.style.borderColor = 'var(--border-default)';
          }}>
          <span style={{
            width: 6, height: 6, borderRadius: 99, marginTop: 7,
            background: s.accent ?? 'var(--accent)', flexShrink: 0,
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500,
              lineHeight: 1.35,
            }}>{s.label}</div>
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
            }}>{s.detail}</div>
          </div>
          <ArrowRight size={12} strokeWidth={1.8}
            style={{ color: 'var(--text-tertiary)', marginTop: 2, flexShrink: 0 }} />
        </Link>
      ))}
    </div>
  );
}

export const agentSuggestionsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.agent-suggestions',
  title: 'Nudges',
  description: 'What the agent could do for you right now.',
  icon: Lightbulb,
  category: 'agent',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: AgentSuggestionsWidget,
};
