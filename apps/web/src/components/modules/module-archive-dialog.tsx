'use client';

import { useDeferredValue, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { refreshModuleCaches } from '@/hooks/use-modules';
import { sessionSWRKey, sessionSWRPath } from '@/lib/session-cache';
import { moduleApiError, moduleRecordHref, formatModuleFieldValue, type ModuleCollection, type ModuleInstallation } from '@/lib/modules';

type ArchiveRow = { id: string; label: string; subtitle: string | null; revision: number; archived_at: string | null; data: Record<string, unknown> };
type ArchivePage = { records: ArchiveRow[]; next_offset: number | null };
export function ModuleArchiveDialog({ installedModule, collection }: { installedModule: ModuleInstallation; collection: ModuleCollection }) {
  const { sessionCacheScope } = useAuth();
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const query = useDeferredValue(search);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ id: string; label: string } | null>(null);
  const intents = useRef(new Map<string, string>());
  const path = `/api/modules/${encodeURIComponent(installedModule.slug)}/archive?${new URLSearchParams({ collection_key: collection.key, search: query, offset: String(offset), limit: '25' })}`;
  const archive = useSWR<ArchivePage>(sessionSWRKey(sessionCacheScope, open ? path : null), async (key: string) => {
    const url = sessionSWRPath(key);
    const response = await api.get(url);
    if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to load archived records.'));
    return response.json();
  }, { revalidateOnFocus: true });
  const restore = async (row: ArchiveRow) => {
    const key = `${row.id}:${row.revision}`;
    const intent = intents.current.get(key) ?? crypto.randomUUID(); intents.current.set(key, intent);
    setBusy(row.id); setError(null); setRestored(null);
    try {
      const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/records/${encodeURIComponent(row.id)}/restore`, {
        expected_revision: row.revision, expected_manifest_digest: installedModule.manifestDigest, idempotency_key: intent,
      });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to restore this record.'));
      setOffset(0);
      await refreshModuleCaches(installedModule.slug);
      setRestored({ id: row.id, label: row.label });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to restore this record.'); }
    finally { setBusy(null); }
  };
  return <>
    <button type="button" className="min-h-11 rounded-lg px-3 text-sm font-medium" style={{ background: 'var(--surface-container-high)' }} onClick={() => setOpen(true)}>Archived records</button>
    <AppDialog open={open} onClose={() => { if (!busy) setOpen(false); }} width={680} title={`Archived ${collection.name.toLowerCase()}`}
      footer={<button type="button" className="min-h-11 rounded-lg px-4 text-sm" disabled={Boolean(busy)} onClick={() => setOpen(false)}>Close archive</button>}>
      <div className="space-y-4">
        <p className="text-sm">Restore the original record with its retained data and links. Links removed separately stay removed; links to other archived records stay hidden.</p>
        <div className="flex gap-2"><input aria-label="Search archived records" placeholder="Search archived names" className="min-h-11 min-w-0 flex-1 rounded-lg px-3 text-sm" style={{ background: 'var(--surface-container-high)' }} value={search} maxLength={240} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} />
          <button type="button" className="min-h-11 px-3 text-sm underline" disabled={Boolean(busy)} onClick={() => { setError(null); void archive.mutate(); }}>Refresh</button></div>
        {(error || archive.error) && <p role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{error ?? (archive.error instanceof Error ? archive.error.message : 'Unable to load archive.')}</p>}
        {restored && <p role="status" className="text-sm">Restored <Link className="underline" href={moduleRecordHref(installedModule.slug, collection.key, restored.id)}>{restored.label}</Link>.</p>}
        {archive.isLoading ? <p role="status">Loading archive…</p> : !archive.error && archive.data?.records.length === 0 ? <p className="py-6 text-sm">No archived records match this search.</p> : <ul className="space-y-3">{archive.data?.records.map((row) => <li key={row.id} className="rounded-lg border border-[var(--ghost-border)] p-3">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm font-semibold">{row.label}</h3>{row.subtitle && <p className="mt-1 break-words text-xs" style={{ color: 'var(--on-surface-variant)' }}>{row.subtitle}</p>}{row.archived_at && <p className="mt-1 text-xs">Archived {new Date(row.archived_at).toLocaleString()}</p>}</div>
            <button type="button" className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium" style={{ background: 'var(--primary-container)', color: 'white' }} disabled={Boolean(busy)} onClick={() => void restore(row)}>{busy === row.id ? 'Restoring…' : 'Restore'}</button></div>
          <details className="mt-3 text-xs"><summary className="min-h-8 cursor-pointer">Review retained data</summary><dl className="space-y-2">{Object.entries(row.data).map(([key, value]) => { const field = collection.fields.find((item) => item.key === key); return <div key={key}><dt className="font-medium">{field?.label ?? key}</dt><dd className="whitespace-pre-wrap break-words" style={{ color: 'var(--on-surface-variant)' }}>{field ? formatModuleFieldValue(value, field) : JSON.stringify(value)}</dd></div>; })}</dl></details>
        </li>)}</ul>}
        <div className="flex items-center justify-between text-sm"><button type="button" className="min-h-11 underline" disabled={offset === 0 || Boolean(busy)} onClick={() => setOffset((value) => Math.max(0, value - 25))}>Previous</button><span>Page {Math.floor(offset / 25) + 1}</span><button type="button" className="min-h-11 underline" disabled={archive.data?.next_offset == null || Boolean(busy)} onClick={() => setOffset(archive.data!.next_offset!)}>Next</button></div>
      </div>
    </AppDialog>
  </>;
}
