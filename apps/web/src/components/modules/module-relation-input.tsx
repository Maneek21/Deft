'use client';

import { useDeferredValue, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { useModuleRecords } from '@/hooks/use-modules';
import { getModuleRecordTitle, getModuleRecordSubtitle, type ModuleCollection, type ModuleField, type ModuleRelationGroup } from '@/lib/modules';

export function ModuleRelationInput({ slug, field, targetCollection, value, initial, error, disabled, onChange }: {
  slug: string;
  field: ModuleField;
  targetCollection?: ModuleCollection;
  value: unknown;
  initial: ModuleRelationGroup[];
  error?: string;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [chosenLabels, setChosenLabels] = useState<Record<string, string>>({});
  const [chosenSubtitles, setChosenSubtitles] = useState<Record<string, string>>({});
  const chooseButton = useRef<HTMLButtonElement>(null);
  const deferredSearch = useDeferredValue(search);
  const state = useModuleRecords(expanded ? slug : '', field.targetCollection ?? '', { search: deferredSearch });
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  const initialRecords = initial.find((group) => group.fieldKey === field.key)?.records ?? [];
  const labelFor = (id: string) => chosenLabels[id] ?? initialRecords.find((record) => record.id === id)?.label ?? 'Selected record';
  const subtitleFor = (id: string) => chosenSubtitles[id] ?? initialRecords.find((record) => record.id === id)?.subtitle;
  const panelId = useId();

  return <fieldset className="min-w-0 space-y-2" disabled={disabled}>
    <legend className="text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>{field.label}{field.required ? ' *' : ''}</legend>
    {ids.length > 0 && <ul className="flex flex-wrap gap-2" aria-label={`Selected ${field.label.toLowerCase()}`}>
      {ids.map((id) => <li key={id} className="flex max-w-full items-center gap-1 rounded-full pl-3" style={{ background: 'var(--surface-container-high)' }}>
        <span className="min-w-0 break-words py-2 text-xs"><span className="block">{labelFor(id)}</span>{subtitleFor(id) && <span className="mt-1 block text-[var(--on-surface-variant)]">{subtitleFor(id)}</span>}</span>
        <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center" aria-label={`Remove ${labelFor(id)}`} onClick={() => onChange(ids.filter((candidate) => candidate !== id))}><X size={14} /></button>
      </li>)}
    </ul>}
    <button ref={chooseButton} type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-full border px-4 text-left text-[0.8125rem]" style={{ borderColor: error ? 'var(--error)' : 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
      {ids.length ? `Change ${field.label.toLowerCase()}` : `Choose ${field.label.toLowerCase()}`}<ChevronDown size={14} />
    </button>
    {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
    {expanded && <div id={panelId} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--ghost-border)' }} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        chooseButton.current?.focus();
      }
    }}>
      <label className="flex items-center gap-2 border-b px-3" style={{ borderColor: 'var(--ghost-border)' }}>
        <Search size={14} aria-hidden="true" />
        <input autoFocus type="search" aria-label={`Search ${field.label.toLowerCase()}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${targetCollection?.name.toLowerCase() ?? 'records'}…`} className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <div className="max-h-52 overflow-y-auto p-1">
        {state.isLoading ? <p role="status" className="flex items-center gap-2 p-3 text-xs"><Loader2 size={14} className="animate-spin" />Loading…</p>
          : state.error ? <div role="alert" className="p-3 text-xs"><p>Unable to load choices.</p><button type="button" onClick={() => void state.mutate()} className="min-h-11 underline">Try again</button></div>
            : state.records.length === 0 ? <p className="p-3 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{search ? 'No matching records. Try another search.' : `No ${targetCollection?.name.toLowerCase() ?? 'records'} yet. Create one in its collection first.`}</p>
              : state.records.map((record) => {
                const label = targetCollection ? getModuleRecordTitle(record, targetCollection) : record.id;
                const selected = ids.includes(record.id);
                return <button type="button" key={record.id} aria-pressed={selected} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-[var(--surface-container-high)]" onClick={() => {
                  setChosenLabels((current) => ({ ...current, [record.id]: label }));
                  setChosenSubtitles((current) => ({ ...current, [record.id]: targetCollection ? getModuleRecordSubtitle(record, targetCollection) : '' }));
                  onChange(field.multiple ? selected ? ids.filter((id) => id !== record.id) : [...ids, record.id] : [record.id]);
                  if (!field.multiple) {
                    setExpanded(false);
                    chooseButton.current?.focus();
                  }
                }}>
                  <span className="min-w-0"><span className="block break-words text-sm">{label}</span>{targetCollection && <span className="block truncate text-xs" style={{ color: 'var(--on-surface-variant)' }}>{getModuleRecordSubtitle(record, targetCollection)}</span>}</span>
                  {selected && <Check size={14} className="shrink-0" />}
                </button>;
              })}
        {state.nextCursor && <button type="button" disabled={state.isLoadingMore} onClick={() => void state.loadMore()} className="min-h-11 w-full text-xs underline">{state.isLoadingMore ? 'Loading…' : 'Load more choices'}</button>}
      </div>
    </div>}
  </fieldset>;
}
