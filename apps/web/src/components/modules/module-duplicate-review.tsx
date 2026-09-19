"use client";

import { useDeferredValue, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ModuleMergeReview } from '@/components/modules/module-merge-review';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionReadCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { formatModuleFieldValue, moduleApiError, moduleRecordHref, type ModuleCollection, type ModuleInstallation } from '@/lib/modules';

type Candidate = { id: string; label: string; subtitle: string | null; revision: number; data: Record<string, unknown> };
type Group = { value: string; count: number; records: Candidate[]; record_offset: number; next_record_offset: number | null };
type Result = { groups: Group[]; next_offset: number | null };

export function ModuleDuplicateReview({ installedModule, collection }: { installedModule: ModuleInstallation; collection: ModuleCollection }) {
  const { sessionCacheScope } = useAuth();
  const fields = collection.fields.filter((field) => ['text', 'email', 'phone'].includes(field.type));
  const [open, setOpen] = useState(false);
  const [primary, setPrimary] = useState<{ record: Candidate; group: string } | null>(null);
  const [pair, setPair] = useState<{ source: Candidate; target: Candidate } | null>(null);
  const [busy, setBusy] = useState(false);
  const [matchField, setMatchField] = useState(fields.find((field) => field.type === 'email')?.key ?? fields[0]?.key ?? '');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [recordOffset, setRecordOffset] = useState(0);
  const params = new URLSearchParams({ collection_key: collection.key, match_field: matchField, search: query,
    offset: String(offset), limit: '10', record_offset: String(recordOffset), ...(selected === null ? {} : { match_value: selected }) });
  const path = open && matchField ? `/api/modules/${encodeURIComponent(installedModule.slug)}/duplicates?${params}` : null;
  const result = useSWR<Result>(moduleSessionReadCacheKey(sessionCacheScope, path),
    async (key: string) => {
      const url = moduleSessionRequestPath(key);
      const response = await api.get(url);
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to load duplicate candidates.'));
      return response.json();
    });
  const reset = () => { setOffset(0); setSelected(null); setRecordOffset(0); };
  if (!fields.length) return null;
  return <>
    <button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium transition-colors hover:bg-[var(--bg-active)]" style={{ background: 'var(--surface-container-high)' }} onClick={() => setOpen(true)}>Review duplicates</button>
    <AppDialog open={open} onClose={() => { if (!busy) setOpen(false); }} width={920} title={`Review duplicate ${collection.name.toLowerCase()}`}
      footer={<button type="button" className="min-h-10 rounded-full px-4 text-sm" disabled={busy} onClick={() => setOpen(false)}>Close duplicate review</button>}>
      {pair ? <ModuleMergeReview key={`${pair.source.id}:${pair.target.id}`} installedModule={installedModule} collection={collection} source={pair.source} target={pair.target} onBusy={setBusy} onBack={() => { setPair(null); setPrimary(null); void result.mutate(); }} /> : <div className="space-y-4">
        <p className="text-sm">Matching values identify candidates, not confirmed duplicates. Compare the original records and their linked context before resolving them. Choose a primary record, then review a second candidate for merging.</p>
        <div className="flex flex-wrap gap-3">
          <label className="min-w-0 flex-1 text-sm">Match by<select aria-label="Duplicate match field" value={matchField} className="mt-1 min-h-11 w-full rounded-lg px-3" style={{ background: 'var(--surface-container-high)' }} onChange={(event) => { setMatchField(event.target.value); reset(); }}>{fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label>
          <label className="min-w-0 flex-1 text-sm">Search matching values<input aria-label="Search duplicate values" value={search} maxLength={240} className="mt-1 min-h-11 w-full rounded-lg px-3" style={{ background: 'var(--surface-container-high)' }} onChange={(event) => { setSearch(event.target.value); reset(); }} /></label>
        </div>
        <p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Checks all live records in this collection. Capitalization and surrounding spaces are ignored; empty values and archived records are excluded.</p>
        {selected !== null && <button type="button" className="min-h-11 text-sm underline" onClick={() => { setSelected(null); setRecordOffset(0); }}>Back to candidate groups</button>}
        {result.error && <div role="alert" className="rounded-xl p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{result.error instanceof Error ? result.error.message : 'Unable to load candidates.'} <button className="min-h-11 underline" onClick={() => void result.mutate()}>Retry</button></div>}
        {result.isLoading ? <p role="status">Finding duplicate candidates…</p> : !result.error && result.data?.groups.length === 0 ? <p className="py-6 text-sm">No duplicate candidates match this field and search.</p> : result.data?.groups.map((group) => <section key={group.value} className="min-w-0 rounded-xl bg-[var(--surface-container-low)] p-3">
          <h3 className="break-words text-sm font-semibold">{group.value}</h3><p className="mt-1 text-xs">{group.count} matching records · Showing {group.record_offset + 1}–{group.record_offset + group.records.length}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{group.records.map((record) => <article key={record.id} className="min-w-0 rounded-xl p-3" style={{ background: 'var(--surface-container-high)' }}>
            <Link className="break-words text-sm font-semibold underline" href={moduleRecordHref(installedModule.slug, collection.key, record.id)}>{record.label}</Link>
            <div className="mt-2 flex flex-wrap gap-2 text-xs"><button type="button" className="min-h-11 underline" onClick={() => setPrimary({ record, group: group.value })}>{primary?.record.id === record.id ? 'Selected primary' : 'Keep as primary'}</button>{primary && primary.group === group.value && primary.record.id !== record.id && <button type="button" className="min-h-11 underline" onClick={() => setPair({ source: record, target: primary.record })}>Review merge into primary</button>}</div>
            {record.subtitle && <p className="mt-1 break-words text-xs">{record.subtitle}</p>}
            <details className="mt-2 text-xs"><summary className="min-h-8 cursor-pointer">Compare field values</summary><dl className="space-y-2">{Object.entries(record.data).map(([key, value]) => { const field = collection.fields.find((item) => item.key === key); return <div key={key}><dt className="font-medium">{field?.label ?? key}</dt><dd className="whitespace-pre-wrap break-words" style={{ color: 'var(--on-surface-variant)' }}>{field ? formatModuleFieldValue(value, field) : JSON.stringify(value)}</dd></div>; })}</dl><p className="mt-3 break-all" style={{ color: 'var(--on-surface-variant)' }}>Record {record.id}</p></details>
          </article>)}</div>
          <div className="mt-3 flex justify-between gap-3 text-sm">
            {group.record_offset > 0 ? <button className="min-h-11 underline" onClick={() => setRecordOffset(Math.max(0, group.record_offset - 10))}>Previous records</button> : <span />}
            {group.next_record_offset !== null && <button className="min-h-11 underline" onClick={() => { setSelected(group.value); setRecordOffset(group.next_record_offset!); }}>Next records</button>}
          </div>
        </section>)}
        {selected === null && <div className="flex items-center justify-between text-sm"><button className="min-h-11 underline" disabled={offset === 0 || result.isLoading} onClick={() => setOffset(Math.max(0, offset - 10))}>Previous groups</button><span>Page {Math.floor(offset / 10) + 1}</span><button className="min-h-11 underline" disabled={result.data?.next_offset == null || result.isLoading} onClick={() => setOffset(result.data!.next_offset!)}>Next groups</button></div>}
      </div>}
    </AppDialog>
  </>;
}
