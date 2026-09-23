'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, CalendarCheck2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionReadCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { moduleApiError } from '@/lib/modules';
import { moduleTaskCalendarDay, moduleTaskDueLabel, normalizeModuleTaskQueue } from '@/lib/module-task-links';
import { statusLabel } from '@/lib/task-status-labels';
import { ModuleLoadingState } from './module-primitives';

const buckets = [
  ['open', 'All open'], ['overdue', 'Overdue'], ['today', 'Today'],
  ['upcoming', 'Upcoming'], ['undated', 'No due date'], ['closed', 'Closed'],
] as const;

export function ModuleFollowUpQueue({ slug }: { slug: string }) {
  const { sessionCacheScope } = useAuth();
  const [bucket, setBucket] = useState('open');
  const [assignee, setAssignee] = useState('all');
  const [offset, setOffset] = useState(0);
  const [today, setToday] = useState(moduleTaskCalendarDay);
  // Roll over the filter day without requiring a tab reload at midnight.
  useEffect(() => {
    const update = () => {
      const next = moduleTaskCalendarDay();
      if (next !== today) { setToday(next); setOffset(0); }
    };
    const timer = window.setInterval(update, 30000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [today]);
  const query = new URLSearchParams({ bucket, assignee, today, offset: String(offset), limit: '25' });
  const path = `/api/modules/${encodeURIComponent(slug)}/task-queue?${query}`;
  const state = useSWR(moduleSessionReadCacheKey(sessionCacheScope, path), async (key: string) => {
    const url = moduleSessionRequestPath(key);
    const response = await api.get(url);
    if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to load follow-ups.'));
    return normalizeModuleTaskQueue(await response.json());
  }, { refreshInterval: 30000, revalidateOnFocus: true, revalidateOnReconnect: true });
  const tasks = state.data?.tasks ?? [];
  return <section aria-label="Follow-up queue" className="mx-auto max-w-5xl space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><CalendarCheck2 size={19} style={{ color: 'var(--primary)' }} />Linked tasks</h2><p className="mt-1 text-sm" style={{ color: 'var(--on-surface-variant)' }}>Open a task to complete it or update its owner and date.</p><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Calendar day: {today} · Your local date</p></div>
      <button type="button" onClick={() => void state.mutate()} disabled={state.isValidating} className="flex min-h-10 items-center gap-2 rounded-full px-4 text-xs disabled:opacity-60" style={{ background: 'var(--surface-container-high)' }}><RefreshCw size={14} />Refresh</button>
    </div>
    <div className="flex flex-wrap items-center gap-2" aria-label="Follow-up filters">
      {buckets.map(([key, label]) => <button key={key} type="button" aria-pressed={bucket === key} onClick={() => { setBucket(key); setOffset(0); }} className="min-h-10 rounded-full px-4 text-sm" style={{ background: bucket === key ? 'var(--bg-active)' : 'var(--surface-container-low)', color: bucket === key ? 'var(--primary)' : 'var(--on-surface)' }}>{label}</button>)}
      <select aria-label="Filter by assignee" value={assignee} onChange={(event) => { setAssignee(event.target.value); setOffset(0); }} className="min-h-10 max-w-full rounded-full border px-4 text-sm sm:ml-auto" style={{ background: 'var(--surface-container-low)', borderColor: 'var(--ghost-border)' }}><option value="all">Everyone</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select>
    </div>
    {state.isLoading ? <ModuleLoadingState label="Loading follow-ups…" /> : state.error ? <div role="alert" className="rounded-xl p-5 text-sm" style={{ background: 'var(--danger-subtle)' }}><p>{state.error instanceof Error ? state.error.message : 'Unable to load follow-ups.'}</p><button type="button" onClick={() => void state.mutate()} className="mt-2 min-h-11 underline">Try again</button></div>
      : tasks.length === 0 ? <div className="rounded-xl border p-6" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}><h3 className="font-medium">No follow-ups in this view</h3><p className="mt-2 text-sm" style={{ color: 'var(--on-surface-variant)' }}>Change the filters, or open a record and add a follow-up. Only tasks linked to live records in this module appear here.</p></div>
        : <ul className="divide-y overflow-hidden rounded-xl border" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>{tasks.map((task) => {
          const dueLabel = moduleTaskDueLabel(task, new Date(`${today}T12:00:00`));
          const overdue = dueLabel.startsWith('Overdue');
          return <li key={task.taskId} className="space-y-3 p-4" style={{ borderColor: 'var(--ghost-border)' }}>
            <Link href={task.url} className="group flex min-h-11 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.6875rem] font-medium" style={{ color: 'var(--on-surface-variant)' }}>{task.identifier} · {task.projectName}</span>
                  <span className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={{ background: overdue ? 'var(--danger-subtle)' : 'var(--surface-container-high)', color: overdue ? 'var(--error)' : 'var(--on-surface-variant)' }}>{dueLabel}</span>
                </div>
                <h3 className="mt-1.5 break-words text-sm font-semibold group-hover:underline">{task.title}</h3>
              </div>
              <ArrowRight size={16} className="mt-2 shrink-0" aria-hidden style={{ color: 'var(--outline)' }} />
            </Link>
            <p className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--on-surface-variant)' }}>
              <span>{task.assigneeName ?? 'Unassigned'}</span>
              <span aria-hidden>·</span>
              <span className="rounded-full px-2 py-0.5" style={{ background: 'var(--surface-container-high)' }}>{statusLabel(task.status)}</span>
            </p>
            <div className="flex flex-wrap gap-2">{task.records.map((record) => <Link key={record.id} href={record.url} className="inline-flex min-h-9 max-w-full items-center rounded-lg px-2 text-xs underline" style={{ background: 'var(--surface-container-high)', color: 'var(--primary)' }}><span className="truncate">{record.title}</span></Link>)}{task.recordCount > task.records.length && <Link href={task.url} className="inline-flex min-h-9 items-center px-2 text-xs underline">+{task.recordCount - task.records.length} more in task</Link>}</div>
          </li>;
        })}</ul>}
    {!state.isLoading && !state.error && <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><p style={{ color: 'var(--on-surface-variant)' }}>{tasks.length ? `Showing ${offset + 1}–${offset + tasks.length}` : '0 shown'}{state.data?.nextOffset ? ' · More available' : ''}</p><div className="flex gap-2"><button type="button" disabled={offset === 0 || state.isValidating} onClick={() => setOffset(Math.max(0, offset - 25))} className="min-h-10 rounded-full px-4 disabled:opacity-40" style={{ background: 'var(--surface-container-high)' }}>Previous</button><button type="button" disabled={!state.data?.nextOffset || state.isValidating} onClick={() => { if (state.data?.nextOffset) setOffset(state.data.nextOffset); }} className="min-h-10 rounded-full px-4 disabled:opacity-40" style={{ background: 'var(--surface-container-high)' }}>Next</button></div></div>}
  </section>;
}
