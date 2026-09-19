'use client';

import useSWR from 'swr';
import { useId, useState } from 'react';
import { ModuleRecordSummaryResponseSchema } from '@deft/shared/modules';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionPostCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { formatModuleNumberValue, type ModuleCollection, type ModuleView } from '@/lib/modules';
import type { ModuleQueryFilter } from '@/lib/module-saved-views';

export function ModuleRecordSummary({ slug, collection, view, search, filters, today, pending }: {
  slug: string; collection: ModuleCollection; view: ModuleView;
  search: string; filters: ModuleQueryFilter[]; today?: string; pending: boolean;
}) {
  const { sessionCacheScope } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const totalsId = useId();
  const path = `/api/modules/${encodeURIComponent(slug)}/records/summary`;
  const config = view.summary;
  const body = { collection_key: collection.key, value_field: config?.valueField, unit_field: config?.unitField,
    group_field: view.groupBy, filters, ...(today ? { today } : {}), ...(search.trim() ? { search: search.trim() } : {}) };
  const key = moduleSessionPostCacheKey(sessionCacheScope, config ? path : null, body);
  const state = useSWR(key, async (scopedKey: string) => {
    const response = await api.post(moduleSessionRequestPath(scopedKey), body);
    if (!response.ok) throw new Error('Summary could not be loaded.');
    return ModuleRecordSummaryResponseSchema.parse(await response.json());
  }, { refreshInterval: 30000, revalidateOnFocus: true, revalidateOnReconnect: true });
  if (!config) return null;
  const groupField = collection.fields.find((field) => field.key === view.groupBy);
  const unitField = collection.fields.find((field) => field.key === config.unitField);
  const valueField = collection.fields.find((field) => field.key === config.valueField);
  const summarizedRecordCount = state.data?.groups.reduce((total, group) => total + Number(group.record_count), 0) ?? null;
  const label = (value: string | null, field: typeof groupField) => value === null ? 'Unspecified' : field?.options.find((option) => option.value === value)?.label ?? value;
  return <section aria-label="Record summary" className={`rounded-xl border border-[var(--outline-variant)] px-4 ${expanded ? 'py-4' : 'py-2'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{valueField?.label ?? 'Value'} by {groupField?.label.toLowerCase() ?? 'group'}</h2>
        {!expanded && state.data && <p className="mt-0.5 text-xs text-[var(--on-surface-variant)]">
          {summarizedRecordCount} matching {summarizedRecordCount === 1 ? 'record' : 'records'} across {state.data.groups.length} {state.data.groups.length === 1 ? 'total' : 'totals'}
        </p>}
      </div>
      <button type="button" className="min-h-11 text-xs underline" aria-expanded={expanded} aria-controls={totalsId} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Hide totals' : 'Show totals'}{state.data ? ` (${state.data.groups.length})` : ''}
      </button>
    </div>
    {expanded && <p className="text-xs text-[var(--on-surface-variant)]">All matching records · every page</p>}
    {state.error ? <div role="alert" className="mt-3 text-sm">Summary unavailable. <button className="underline" onClick={() => void state.mutate()}>Retry summary</button></div>
      : state.isLoading || pending ? <p role="status" className="mt-3 text-sm">Loading summary…</p>
      : <>
        {state.isValidating && <p role="status" className="mt-2 text-xs">Refreshing summary…</p>}
        <div id={totalsId} hidden={!expanded} className={expanded ? 'mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'hidden'}>
          {state.data?.groups.map((group) => <div key={JSON.stringify([group.group, group.unit])} className="min-w-0 rounded-lg bg-[var(--surface-container)] p-3">
            <p className="text-xs text-[var(--on-surface-variant)]">{label(group.group, groupField)} · {group.unit === null ? `${unitField?.label ?? 'Unit'} unknown` : label(group.unit, unitField)}</p>
            <p className="mt-1 break-words text-lg font-semibold">{group.total === null ? (group.unit === null ? 'Unclassified' : 'No amount') : formatModuleNumberValue(group.total)}</p>
            <p className="mt-1 text-xs text-[var(--on-surface-variant)]">{group.record_count} {group.record_count === '1' ? 'record' : 'records'} · {group.valued_count} with an amount</p>
          </div>)}
        </div>
        {expanded && state.data?.groups.length === 0 && <p className="mt-3 text-sm text-[var(--on-surface-variant)]">No matching records.</p>}
      </>}
    {expanded && <p className="mt-3 text-xs text-[var(--on-surface-variant)]">Units are kept separate. Unknown units are excluded from totals; missing amounts are not treated as zero.</p>}
  </section>;
}
