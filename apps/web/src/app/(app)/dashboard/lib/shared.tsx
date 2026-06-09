'use client';

/**
 * Shared helpers used by multiple widgets. Kept here (not inside /widgets)
 * because importing widget → widget would create cycles and because these are
 * display utilities, not part of the widget contract.
 */
import type { Activity, AgentActivity } from './facade';
import { CheckCircle2, MessageSquare, FileText, CalendarDays, Zap } from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';
import { stripHtml } from '@/lib/strip-html';

export const PRI_COLOR: Record<string, string> = {
  p0: 'var(--status-red)',
  p1: 'var(--status-amber)',
  p2: 'var(--status-blue)',
  p3: 'var(--text-tertiary)',
};

export const PRI_LABEL: Record<string, string> = { p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3' };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] || '') + (parts[1]?.[0] || '')
  ).toUpperCase() || name.slice(0, 2).toUpperCase();
}

export function fmtActivityParts(a: Activity): { who: string; verb: string; task: string } {
  const task = a.task_prefix && a.task_number ? `${a.task_prefix}-${a.task_number}` : '';
  const who = a.user_name?.split(' ')[0] || 'Someone';
  if (a.action === 'created') return { who, verb: 'created', task };
  if (a.action === 'status_changed') return { who, verb: `moved to ${statusLabel(a.new_value || '')}`, task };
  if (a.action === 'assigned') return { who, verb: 'was assigned', task };
  if (a.action === 'priority_changed') return { who, verb: 'changed priority on', task };
  if (a.action === 'commented') return { who, verb: 'commented on', task };
  return { who, verb: 'updated', task };
}

export function fmtAgentAction(a: AgentActivity): string {
  const p = (a.params as Record<string, any>) || {};
  switch (a.action) {
    case 'create_task': return `Created task \u201c${stripHtml(p.title)}\u201d in ${p.project_name}`;
    case 'update_task_status': return `Moved ${p.task_identifier} to ${(p.new_status || '').replace(/_/g, ' ')}`;
    case 'assign_task': return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
    case 'post_message': return `Posted in #${p.space_name}`;
    case 'add_knowledge': return `Added ${p.type}: \u201c${p.title}\u201d`;
    case 'wiki_write': return `Updated wiki: ${p.title || p.slug}`;
    default: return a.action.replace(/_/g, ' ');
  }
}

export function agentActionIcon(action: string) {
  if (action.includes('task')) return <CheckCircle2 size={11} />;
  if (action.includes('message')) return <MessageSquare size={11} />;
  if (action.includes('knowledge') || action.includes('wiki')) return <FileText size={11} />;
  if (action.includes('calendar')) return <CalendarDays size={11} />;
  return <Zap size={11} />;
}

export { statusLabel };
