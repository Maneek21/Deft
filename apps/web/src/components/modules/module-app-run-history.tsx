'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { AppRunInspector } from '@/components/apps/app-run-inspector';
import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { useAuth } from '@/lib/auth-context';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { resourceRefKey, resourceRefPayload, type ResourceRef } from '@/lib/modules';
import { appRunPresentation } from '@/lib/app-run-presentation';
import { moduleSessionPostCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import type { AppRunState } from '@/lib/app-actions';

type Cursor = { created_at: string; id: string };
type History = {
  runs: Array<{ id: string; operation_name: string; state: AppRunState; created_at: string; updated_at: string; provider_call_attempted: boolean; outcome_success: boolean | null; error_code: string | null; environment: 'sandbox' | 'unknown'; can_inspect_receipts: boolean; from_merged_record: boolean }>;
  next_cursor: Cursor | null;
};

export function ModuleAppRunHistory({ resourceRef }: { resourceRef: ResourceRef }) {
  const { sessionCacheScope } = useAuth();
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const before = cursors.at(-1);
  const input = { resource_ref: resourceRefPayload(resourceRef), ...(before ? { before } : {}) };
  const result = useSWR<History>(moduleSessionPostCacheKey(sessionCacheScope, APPS_ENABLED ? '/api/app-runs/record-history' : null, {
    resource_ref: resourceRefKey(resourceRef), before: before ?? null,
  }), async (key: string) => {
    const response = await api.post(moduleSessionRequestPath(key), input);
    if (!response.ok) throw new Error(await appApiError(response, 'Unable to load action history.'));
    return response.json();
  }, { refreshInterval: 10_000, revalidateOnFocus: true, revalidateOnReconnect: true });
  if (!APPS_ENABLED) return null;
  return <section aria-label="Action history" className="rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)' }}>
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Action history</h2><button type="button" className="min-h-11 text-xs underline" disabled={result.isValidating} onClick={() => void result.mutate()}>Refresh history</button></div>
    <p className="mb-3 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Actions involving this record, including history retained through merges. Execution status does not confirm the external provider outcome.</p>
    {result.error ? <p role="alert" className="text-sm">Unable to load action history. <button type="button" className="min-h-11 underline" onClick={() => void result.mutate()}>Retry history</button></p>
      : result.isLoading ? <p role="status" className="text-sm">Loading action history…</p>
      : result.data?.runs.length === 0 ? <p className="text-sm">No actions recorded yet.</p>
      : <ol className="space-y-3">{result.data?.runs.map(run => { const presentation = appRunPresentation({ state: run.state, environment: run.environment, providerCallAttempted: run.provider_call_attempted, outcomeSuccess: run.outcome_success }); return <li key={run.id} className="rounded-lg p-3" style={{ background: 'var(--surface-container-high)' }}>
        <p className="break-words text-sm font-medium">{run.operation_name.replaceAll('_', ' ')}</p>
        {run.from_merged_record && <p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>From a merged record</p>}
        <p className="mt-1 text-sm">{presentation.label}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{presentation.detail}</p>
        <time className="mt-1 block text-xs" dateTime={run.created_at} style={{ color: 'var(--on-surface-variant)' }}>{new Date(run.created_at).toLocaleString()}</time>
        <div className="mt-2 flex flex-wrap gap-3">
          {run.can_inspect_receipts && <button type="button" className="min-h-11 text-xs underline" onClick={() => setInspectId(run.id)}>View receipts</button>}
          {run.state === 'pending_approval' && <Link className="inline-flex min-h-11 items-center text-xs underline" href="/inbox">Open Inbox</Link>}
        </div>
      </li>; })}</ol>}
    {(cursors.length > 0 || result.data?.next_cursor) && <div className="mt-3 flex justify-between gap-2 text-xs">
      <button type="button" className="min-h-11 underline disabled:opacity-50" disabled={!cursors.length || result.isValidating} onClick={() => setCursors(current => current.slice(0, -1))}>Newer actions</button>
      <button type="button" className="min-h-11 underline disabled:opacity-50" disabled={!result.data?.next_cursor || result.isValidating || Boolean(result.error)} onClick={() => { const next = result.data?.next_cursor; if (next) setCursors(current => [...current, next]); }}>Older actions</button>
    </div>}
    <AppRunInspector runId={inspectId} onClose={() => setInspectId(null)} />
  </section>;
}
