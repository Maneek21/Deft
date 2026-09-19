'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import { CheckSquare2, Link2, Loader2, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { registerModuleInfiniteCacheRevalidator } from '@/hooks/use-modules';
import { moduleSessionReadCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { subscribeModulePageResume } from '@/lib/module-page-resume';
import { moduleTaskHrefWithRecordReturn } from '@/lib/module-list-context';
import { normalizeModuleRecordTaskLinkPage, moduleTaskDueLabel, isModuleTaskClosed } from '@/lib/module-task-links';
import { statusLabel } from '@/lib/task-status-labels';
import { ModuleFollowUpForm } from './module-followup-form';
import { ModuleLinkTaskDialog } from './module-link-task-dialog';

export function ModuleRecordTaskLinks({ slug, recordId, resourceId, title, returnHref, canWrite = false }: { slug: string; recordId: string; resourceId?: string; title?: string; returnHref: string; canWrite?: boolean }) {
  const pageSize = 100;
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { sessionCacheScope } = useAuth();
  const state = useSWRInfinite((pageIndex, previousPage) => {
    if (!sessionCacheScope) return null;
    if (pageIndex > 0 && previousPage.nextOffset === null) return null;
    const offset = pageIndex === 0 ? 0 : previousPage.nextOffset;
    const url = `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/tasks?limit=${pageSize}&offset=${offset}`;
    return moduleSessionReadCacheKey(sessionCacheScope, url);
  }, async (key: string) => {
    const url = moduleSessionRequestPath(key);
    const response = await api.get(url);
    if (!response.ok) throw new Error('Unable to load linked tasks.');
    return normalizeModuleRecordTaskLinkPage(await response.json());
  }, { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateOnMount: true, revalidateFirstPage: false, refreshInterval: 30000 });
  useEffect(
    () => subscribeModulePageResume(sessionCacheScope, () => state.mutate(), window, document),
    [sessionCacheScope, state.mutate],
  );
  useEffect(
    () => registerModuleInfiniteCacheRevalidator(
      sessionCacheScope,
      slug,
      () => state.mutate(),
      { taskCache: true },
    ),
    [sessionCacheScope, slug, state.mutate],
  );
  const links = useMemo(() => {
    const seen = new Set<string>();
    return (state.data ?? []).flatMap((page) => page.links.filter((link) => {
      if (seen.has(link.edgeId)) return false;
      seen.add(link.edgeId);
      return true;
    }));
  }, [state.data]);
  const loading = state.isLoading && links.length === 0;
  const error = state.error;
  const nextOffset = state.data?.at(-1)?.nextOffset ?? null;
  const next = links.find((link) => !isModuleTaskClosed(link.status));
  const openLinks = links.filter((link) => !isModuleTaskClosed(link.status));
  const closedLinks = links.filter((link) => isModuleTaskClosed(link.status));
  const taskRow = (link: typeof links[number]) => (
    <Link key={link.edgeId} href={moduleTaskHrefWithRecordReturn(link.url, returnHref)} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-[var(--surface-container)]">
      <span className="min-w-0 flex-1">
        {link.taskId === next?.taskId && <span className="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--primary)]">Next action</span>}
        <span className="block break-words text-sm font-medium text-[var(--on-surface)]">{link.title}</span>
        <span className="mt-1 block text-xs text-[var(--on-surface-variant)]">{link.identifier ?? link.projectName} · {link.assigneeName ?? 'Unassigned'}</span>
      </span>
      <span className="max-w-[42%] shrink-0 text-right text-xs">
        <span className="block font-medium" style={{ color: moduleTaskDueLabel(link).startsWith('Overdue') ? 'var(--error)' : 'var(--on-surface-variant)' }}>{moduleTaskDueLabel(link)}</span>
        <span className="mt-1 block text-[var(--on-surface-variant)]">{statusLabel(link.status)}</span>
      </span>
    </Link>
  );

  return (
    <section className="overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }} aria-label="Linked tasks">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--ghost-border)] px-4 py-3">
        <CheckSquare2 size={14} style={{ color: 'var(--primary)' }} />
        <h2 className="text-sm font-semibold" style={{ color: 'var(--on-surface)' }}>Linked tasks</h2>
        {!loading && <span className="rounded-full bg-[var(--surface-container-high)] px-2 py-0.5 text-xs text-[var(--on-surface-variant)]">{links.length} loaded</span>}
        {canWrite && resourceId && <div className="ml-auto flex flex-wrap gap-1">
          <button type="button" onClick={() => { setNotice(null); setLinking(true); }} className="flex min-h-10 items-center gap-1 rounded-full px-3 text-xs text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)]"><Link2 size={13} />Link task</button>
          <button type="button" onClick={() => { setNotice(null); setCreating(true); }} className="flex min-h-10 items-center gap-1 rounded-full px-4 text-xs font-medium" style={{ background: 'var(--bg-active)', color: 'var(--primary)' }}><Plus size={13} />Add follow-up</button>
        </div>}
      </header>
      {notice && <p role="status" className="px-4 py-3 text-xs">{notice}</p>}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}><Loader2 size={12} className="animate-spin" /> Loading tasks…</div>
      ) : error && links.length === 0 ? (
        <div role="alert" className="px-4 py-4 text-xs">Unable to load linked tasks. <button type="button" onClick={() => void state.mutate()} className="min-h-11 underline">Try again</button></div>
      ) : links.length === 0 ? (
        <p className="px-4 py-4 text-sm leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>No follow-ups yet.{canWrite ? ' Add the next step or link an existing Deft task.' : ''}</p>
      ) : (
        <div className="divide-y divide-[var(--ghost-border)]">
          {openLinks.length === 0 && <p className="px-4 py-4 text-sm text-[var(--on-surface-variant)]">{nextOffset === null ? 'All linked tasks are closed.' : 'All loaded tasks are closed.'} Add a follow-up when there’s a next step.</p>}
          {openLinks.slice(0, 3).map(taskRow)}
          {openLinks.length > 3 && <details><summary className="min-h-11 cursor-pointer px-4 py-3 text-xs text-[var(--primary)]">Show {openLinks.length - 3} more loaded open tasks</summary>{openLinks.slice(3).map(taskRow)}</details>}
          {closedLinks.length > 0 && <details><summary className="min-h-11 cursor-pointer px-4 py-3 text-xs text-[var(--on-surface-variant)]">Closed tasks loaded · {closedLinks.length}</summary>{closedLinks.map(taskRow)}</details>}
        </div>
      )}
      {!loading && error && links.length > 0 && <div role="alert" className="px-4 py-3 text-xs">Unable to load more linked tasks. <button type="button" onClick={() => void state.mutate()} className="min-h-11 underline">Try again</button></div>}
      {!loading && !error && nextOffset !== null && <button type="button" disabled={state.isValidating} onClick={() => void state.setSize((size) => size + 1)} className="flex min-h-11 w-full items-center justify-center border-t px-4 text-xs underline disabled:opacity-60" style={{ borderColor: 'var(--ghost-border)', color: 'var(--primary)' }}>{state.isValidating ? <><Loader2 size={12} className="mr-2 animate-spin" />Loading more…</> : 'Load more linked tasks'}</button>}
      <Link href={`/modules/${encodeURIComponent(slug)}?workspace=follow-ups`} className="flex min-h-11 items-center border-t px-4 text-xs underline" style={{ borderColor: 'var(--ghost-border)', color: 'var(--primary)' }}>View follow-up queue</Link>
      {creating && resourceId && <ModuleFollowUpForm resourceId={resourceId} title={title ?? 'this record'} onClose={() => setCreating(false)} onLinked={async () => { await state.mutate().catch(() => undefined); setNotice('Follow-up created and linked.'); }} />}
      {linking && resourceId && <ModuleLinkTaskDialog resourceId={resourceId} linkedTaskIds={links.map((link) => link.taskId)} onClose={() => setLinking(false)} onLinked={async () => { await state.mutate().catch(() => undefined); setNotice('Task linked. Open it to update its owner, date, or status.'); }} />}
    </section>
  );
}
