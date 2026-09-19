"use client";
import { useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionReadCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { moduleApiError, formatModuleFieldValue, type ModuleCollection } from '@/lib/modules';
type History = { merges: Array<{ id: string; source_record_id: string; target_record_id: string; source_data: Record<string, unknown>; target_data: Record<string, unknown>; created_at: string }>; next_offset: number | null };
export function ModuleMergeHistory({ slug, recordId, collection }: { slug: string; recordId: string; collection: ModuleCollection }) {
  const { sessionCacheScope } = useAuth();
  const [open, setOpen] = useState(false), [offset, setOffset] = useState(0);
  const path = open ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/merge-history?offset=${offset}` : null;
  const result = useSWR<History>(moduleSessionReadCacheKey(sessionCacheScope, path), async (key: string) => {
    const url = moduleSessionRequestPath(key);
    const response = await api.get(url);
    if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to load merge history.'));
    return response.json();
  });
  return <section className="rounded-xl border border-[var(--ghost-border)] p-4"><button type="button" className="min-h-11 text-sm font-semibold underline" aria-expanded={open} onClick={() => setOpen(!open)}>Merge history</button>{open && <div className="mt-3 space-y-4">
    <p className="text-sm">Original values before each merge. Current tasks and linked records use their live permissions. Restoring an absorbed record does not undo a merge.</p>
    {result.error && <p role="alert" className="text-sm">Unable to load merge history. <button className="min-h-11 underline" onClick={() => void result.mutate()}>Retry</button></p>}
    {result.isLoading ? <p role="status">Loading merge history…</p> : result.data?.merges.length === 0 ? <p className="text-sm">No recorded merges.</p> : result.data?.merges.map((merge) => <details key={merge.id} className="rounded-lg p-3" style={{ background: 'var(--surface-container-high)' }}><summary className="min-h-11 cursor-pointer text-sm">Merge on {new Date(merge.created_at).toLocaleString()}</summary><div className="grid min-w-0 gap-4 sm:grid-cols-2">{(['target', 'source'] as const).map((side) => <div key={side} className="min-w-0"><h3 className="text-sm font-semibold">{side === 'target' ? 'Primary before merge' : 'Absorbed original'}</h3><p className="my-2 break-all text-xs">{side === 'target' ? merge.target_record_id : merge.source_record_id}</p><dl className="space-y-2 text-sm">{Object.entries(side === 'target' ? merge.target_data : merge.source_data).map(([key, value]) => { const field = collection.fields.find((item) => item.key === key); return <div key={key}><dt className="font-medium">{field?.label ?? key}</dt><dd className="whitespace-pre-wrap break-words">{field ? formatModuleFieldValue(value, field) : JSON.stringify(value)}</dd></div>; })}</dl></div>)}</div></details>)}
    <div className="flex justify-between text-sm"><button className="min-h-11 underline" disabled={offset === 0 || result.isLoading} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous merges</button><button className="min-h-11 underline" disabled={result.data?.next_offset == null || result.isLoading} onClick={() => setOffset(result.data!.next_offset!)}>Next merges</button></div>
  </div>}</section>;
}
