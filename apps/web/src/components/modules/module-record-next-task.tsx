'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionPostCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { moduleTaskDueLabel, normalizeModuleRecordNextTasks, type ModuleNextTaskResult } from '@/lib/module-task-links';

export function useModuleRecordNextTasks(slug: string, recordIds: string[]) {
  const { sessionCacheScope } = useAuth();
  const ids = [...new Set(recordIds)].sort();
  const path = `/api/modules/${encodeURIComponent(slug)}/records/next-tasks`;
  const key = moduleSessionPostCacheKey(sessionCacheScope, ids.length ? path : null, { record_ids: ids });
  return useSWR(key, async (scopedKey: string) => {
    const requestPath = moduleSessionRequestPath(scopedKey);
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    const results = await Promise.all(batches.map(async (batch): Promise<Record<string, ModuleNextTaskResult>> => {
      try {
        const response = await api.post(requestPath, { record_ids: batch });
        if (!response.ok) throw new Error('Unable to load next actions.');
        return normalizeModuleRecordNextTasks(await response.json(), batch);
      } catch {
        return Object.fromEntries(batch.map((id) => [id, { state: 'error' as const }]));
      }
    }));
    return Object.assign({}, ...results) as Record<string, ModuleNextTaskResult>;
  }, { revalidateOnFocus: true, revalidateOnReconnect: true, refreshInterval: 30000 });
}

export function ModuleRecordNextTask({ result, onRetry }: { result?: ModuleNextTaskResult; onRetry: () => void }) {
  const next = result?.state === 'available' ? result.task : null;
  return <div className="border-t border-[var(--ghost-border)] px-3 py-2 text-xs" aria-label="Next action">
    <p className="mb-1 font-medium text-[var(--on-surface-variant)]">Next action</p>
    {result?.state === 'error' ? <p>Unavailable. <button className="min-h-11 underline" onClick={onRetry}>Retry task</button></p>
      : result?.state === 'unavailable' ? <p>Record unavailable. Refresh this view.</p>
        : !result ? <p role="status">Loading…</p>
          : next ? <Link href={next.url} className="block rounded py-1 focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
            <span className="block break-words font-medium text-[var(--primary)]">{next.title}</span>
            <span className="mt-1 block break-words text-[var(--on-surface-variant)]">{next.assigneeName ?? 'Unassigned'} · {moduleTaskDueLabel(next)}</span>
          </Link> : <p className="text-[var(--on-surface-variant)]">No open task visible</p>}
  </div>;
}
