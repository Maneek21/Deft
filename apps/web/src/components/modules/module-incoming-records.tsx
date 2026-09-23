'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Clock3, Loader2, Plus } from 'lucide-react';
import { useIncomingModuleRecords, refreshModuleCaches } from '@/hooks/use-modules';
import { incomingCreateRelations, incomingModuleFields } from '@/lib/module-form-relations';
import { api } from '@/lib/api';
import { formatModuleFieldValue, getModuleRecordTitle, getModuleRecordSubtitle, moduleRecordHref, moduleApiError, type ModuleCollection, type ModuleField, type ModuleInstallation, type ModuleRecord } from '@/lib/modules';
import { incomingTimelineDateField } from '@/lib/module-form-relations';
import { ModuleRecordFormDialog } from './module-record-form';

export function ModuleIncomingRecords({ installedModule, collection, record, canWrite }: {
  installedModule: ModuleInstallation;
  collection: ModuleCollection;
  record: ModuleRecord;
  canWrite: boolean;
}) {
  const panelId = useId();
  const sources = incomingModuleFields(installedModule.manifest.collections, collection.key)
    .sort((left, right) => Number(Boolean(incomingTimelineDateField(right.collection))) - Number(Boolean(incomingTimelineDateField(left.collection))));
  const [selected, setSelected] = useState<string | null>(null);
  const active = sources.find(({ collection: source, field }) => `${source.key}:${field.key}` === selected) ?? sources[0];
  if (!active) return null;
  return <div className="min-w-0 space-y-3">
    {sources.length > 1 && <div className="flex flex-wrap gap-1 rounded-xl p-1" aria-label="Related work" style={{ background: 'var(--surface-container-low)' }}>
      {sources.map(({ collection: source, field }) => {
        const current = source.key === active.collection.key && field.key === active.field.key;
        const duplicate = sources.filter((item) => item.collection.key === source.key).length > 1;
        return <button key={`${source.key}:${field.key}`} type="button" aria-pressed={current} aria-controls={panelId} onClick={() => setSelected(`${source.key}:${field.key}`)} className="min-h-10 rounded-full px-4 text-sm font-medium transition-colors" style={{ background: current ? 'var(--bg-active)' : undefined, color: current ? 'var(--primary)' : 'var(--on-surface-variant)' }}>{source.name}{duplicate ? ` · ${field.label}` : ''}</button>;
      })}
    </div>}
    <div id={panelId}>
      <IncomingCollection key={`${record.id}:${active.collection.key}:${active.field.key}`} installedModule={installedModule} collection={active.collection} field={active.field} target={record} targetLabel={getModuleRecordTitle(record, collection)} canWrite={canWrite} />
    </div>
  </div>;
}

function IncomingCollection({ installedModule, collection, field, target, targetLabel, canWrite }: {
  installedModule: ModuleInstallation;
  collection: ModuleCollection;
  field: ModuleField;
  target: ModuleRecord;
  targetLabel: string;
  canWrite: boolean;
}) {
  const dateField = incomingTimelineDateField(collection);
  const state = useIncomingModuleRecords(installedModule.slug, target.id, collection.key, field.key, dateField?.key);
  const [creating, setCreating] = useState(false);
  const [initialData, setInitialData] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const heading = `${collection.name} · ${field.label}`;
  const typeField = dateField ? collection.fields.find((candidate) => candidate.type === 'single_select' && collection.subtitleFields.includes(candidate.key)) : undefined;
  const directRelation = {
    fieldKey: field.key,
    records: [{ id: target.id, collectionKey: target.collectionKey, label: targetLabel }],
  };
  const targetCollection = installedModule.manifest.collections.find((candidate) => candidate.key === target.collectionKey);
  const initialRelations = targetCollection
    ? incomingCreateRelations(collection, targetCollection, target, directRelation)
    : [directRelation];
  const startCreate = (preset: Record<string, unknown> = {}) => {
    setNotice(null);
    setInitialData({ ...(dateField?.type === 'datetime' ? { [dateField.key]: new Date().toISOString() } : {}), ...preset });
    setCreating(true);
  };

  const create = async (data: Record<string, unknown>, idempotencyKey: string, _unsetFields: string[], relations: Record<string, string[]>) => {
    const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/records`, {
      collection_key: collection.key,
      data,
      relations,
      expected_manifest_digest: installedModule.manifestDigest,
      idempotency_key: idempotencyKey,
    });
    if (!response.ok) throw new Error(await moduleApiError(response, `Unable to create ${collection.singularName.toLowerCase()}.`));
    await refreshModuleCaches(installedModule.slug);
    await state.mutate();
    setNotice(`${collection.singularName} created${relations[field.key]?.includes(target.id) ? ` and linked to ${targetLabel}` : ''}.`);
  };

  return <section aria-label={heading} className="min-w-0 overflow-hidden rounded-xl border" style={{ background: 'var(--surface-container-low)', borderColor: 'var(--ghost-border)' }}>
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--ghost-border)' }}>
      <div className="min-w-0"><h2 className="text-sm font-semibold">{collection.name}</h2><p className="mt-0.5 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{dateField ? `Newest first · Linked to this ${field.label.toLowerCase()}` : `Linked through ${field.label.toLowerCase()}`}</p></div>
      {canWrite && <button type="button" onClick={() => startCreate()} className="flex min-h-10 items-center gap-1.5 rounded-full px-4 text-xs font-medium transition-colors hover:bg-[var(--bg-active)]" style={{ background: 'var(--surface-container-high)' }}><Plus size={14} />Add {collection.singularName.toLowerCase()}</button>}
    </header>
    {canWrite && typeField && typeField.options.length > 0 && typeField.options.length <= 6 && <div className="flex flex-wrap gap-2 border-b px-4 py-2" style={{ borderColor: 'var(--ghost-border)' }} aria-label={`Quick add ${collection.singularName.toLowerCase()}`}>
      {typeField.options.map((option) => <button key={option.value} type="button" onClick={() => startCreate({ [typeField.key]: option.value })} className="min-h-10 rounded-full px-4 text-xs font-medium hover:bg-[var(--surface-container-high)]" style={{ color: 'var(--primary)' }}>+ {option.label}</button>)}
    </div>}
    {notice && <p role="status" className="break-words px-4 pt-3 text-xs" style={{ color: 'var(--status-green)' }}>{notice}</p>}
    {state.isLoading ? <p role="status" className="flex items-center gap-2 p-4 text-xs"><Loader2 size={14} className="animate-spin" />Loading {collection.name.toLowerCase()}…</p>
      : state.error ? <div role="alert" className="px-4 py-3 text-sm"><p>Unable to load related {collection.name.toLowerCase()}.</p><button type="button" className="min-h-11 underline" onClick={() => void state.mutate()}>Try again</button></div>
        : state.records.length === 0 ? <p className="px-4 py-5 text-sm" style={{ color: 'var(--on-surface-variant)' }}>No linked {collection.name.toLowerCase()} yet.</p>
          : dateField ? <ol className="divide-y divide-[var(--ghost-border)]">{state.records.map((record) => <li key={record.id}>
            <IncomingTimelineEntry slug={installedModule.slug} collection={collection} record={record} dateField={dateField} />
          </li>)}</ol> : <ul className="divide-y divide-[var(--ghost-border)]">{state.records.map((record) => <li key={record.id}>
            <Link href={moduleRecordHref(installedModule.slug, collection.key, record.id)} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--surface-container-high)]">
              <span className="min-w-0"><span className="block break-words text-sm font-medium">{getModuleRecordTitle(record, collection)}</span><span className="mt-0.5 block truncate text-xs" style={{ color: 'var(--on-surface-variant)' }}>{getModuleRecordSubtitle(record, collection)}</span></span><ChevronRight size={16} className="shrink-0" />
            </Link>
          </li>)}</ul>}
    {state.nextCursor && <button type="button" disabled={state.isLoadingMore} onClick={() => void state.loadMore()} className="min-h-11 w-full border-t px-4 text-xs underline" style={{ borderColor: 'var(--ghost-border)' }}>{state.isLoadingMore ? 'Loading…' : `Load more ${collection.name.toLowerCase()}`}</button>}
    {creating && <ModuleRecordFormDialog open slug={installedModule.slug} collections={installedModule.manifest.collections} collection={collection} initialData={initialData} initialRelations={initialRelations} onClose={() => setCreating(false)} onSubmit={create} />}
  </section>;
}

function IncomingTimelineEntry({ slug, collection, record, dateField }: {
  slug: string; collection: ModuleCollection; record: ModuleRecord; dateField: ModuleField;
}) {
  const date = record.data[dateField.key];
  const summaryFields = collection.fields.filter((candidate) => candidate.type === 'long_text');
  const metadata = collection.subtitleFields
    .filter((key) => key !== dateField.key && key !== collection.titleField)
    .map((key) => collection.fields.find((candidate) => candidate.key === key))
    .filter((candidate): candidate is ModuleField => Boolean(candidate && !['relation', 'resource_ref', 'member', 'long_text'].includes(candidate.type)))
    .filter((candidate) => record.data[candidate.key] !== undefined && record.data[candidate.key] !== null && record.data[candidate.key] !== '');
  return <Link href={moduleRecordHref(slug, collection.key, record.id)} className="flex gap-3 px-4 py-4 hover:bg-[var(--surface-container-high)]">
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--surface-container-high)', color: 'var(--primary)' }}><Clock3 size={15} aria-hidden="true" /></span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>
        {metadata.map((candidate) => <span key={candidate.key} className="break-words rounded-full px-2 py-0.5" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>{formatModuleFieldValue(record.data[candidate.key], candidate)}</span>)}
        {typeof date === 'string' && date ? <time dateTime={date}>{formatModuleFieldValue(date, dateField)}</time> : <span>No date recorded</span>}
      </div>
      <h3 className="mt-1.5 break-words text-sm font-semibold">{getModuleRecordTitle(record, collection)}</h3>
      {summaryFields.map((candidate) => typeof record.data[candidate.key] === 'string' && record.data[candidate.key] ? <p key={candidate.key} className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>{String(record.data[candidate.key])}</p> : null)}
    </div>
    <ChevronRight size={16} className="mt-2 shrink-0" aria-hidden="true" />
  </Link>;
}
