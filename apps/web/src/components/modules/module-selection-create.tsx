'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MODULE_LIMITS } from '@deft/shared/modules';
import { AppDialog } from '@/components/overlay-primitives';
import { ModuleRecordFormDialog } from './module-record-form';
import { api } from '@/lib/api';
import { refreshModuleCaches } from '@/hooks/use-modules';
import { getModuleRecordTitle, getModuleRecordSubtitle, moduleRecordHref, moduleApiError,
  type ModuleCollection, type ModuleInstallation, type ModuleRecord, type ModuleRelationGroup } from '@/lib/modules';

/** Contextual create using declared multiple relations, with no domain-specific storage. */
export function ModuleSelectionCreate({ installedModule, collection, records, hasMore, loading, error, loadMore }: {
  installedModule: ModuleInstallation; collection: ModuleCollection; records: ModuleRecord[];
  hasMore: boolean; loading: boolean; error?: string; loadMore: () => void;
}) {
  const router = useRouter();
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetKey, setTargetKey] = useState('');
  const [draft, setDraft] = useState<{ collection: ModuleCollection; relations: ModuleRelationGroup[]; digest: string | null } | null>(null);
  const targets = installedModule.manifest.collections.flatMap((target) => target.fields
    .filter((field) => field.type === 'relation' && field.multiple && field.targetCollection === collection.key)
    .map((field) => ({ key: `${target.key}:${field.key}`, collection: target, field })));
  const target = targets.find((item) => item.key === targetKey) ?? targets[0];
  const selectedRecords = records.filter((record) => selected.includes(record.id));
  if (!target) return null;
  const limit = MODULE_LIMITS.relation_values_per_field;
  const continueToForm = () => {
    if (!selectedRecords.length) return;
    setDraft({ collection: target.collection, digest: installedModule.manifestDigest, relations: [{
      fieldKey: target.field.key,
      records: selectedRecords.map((record) => ({ id: record.id, collectionKey: collection.key,
        label: getModuleRecordTitle(record, collection), subtitle: getModuleRecordSubtitle(record, collection) ?? undefined })),
    }] });
    setChoosing(false);
  };
  return <>
    <button type="button" className="min-h-11 rounded-lg px-3 text-sm font-medium" style={{ background: 'var(--surface-container-high)' }}
      disabled={loading || records.length === 0} onClick={() => { setSelected([]); setChoosing(true); }}>
      {targets.length === 1 ? `Prepare ${target.collection.singularName}` : 'Create from selected records'}
    </button>
    <AppDialog open={choosing} onClose={() => setChoosing(false)} title={`Select ${collection.name.toLowerCase()}`} footer={<button type="button" className="min-h-11 rounded-lg px-4 text-sm" onClick={() => setChoosing(false)}>Cancel selection</button>}>
      <div className="space-y-4 p-4">
        <p className="text-sm">Choose up to {limit} records from your current search and filters. This saves an explicit selection; later changes to a saved view do not change the draft.</p>
        {targets.length > 1 && <label className="block text-sm">Create linked record in<select className="mt-1 min-h-11 w-full rounded border p-2" value={target.key} onChange={(event) => setTargetKey(event.target.value)}>
          {targets.map((item) => <option key={item.key} value={item.key}>{item.collection.name} · {item.field.label}</option>)}
        </select></label>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span role="status">{selectedRecords.length} selected · {records.length}{hasMore ? '+' : ''} loaded</span>
          <button type="button" className="min-h-11 underline" disabled={loading} onClick={() => setSelected(records.slice(0, limit).map((record) => record.id))}>Select loaded (up to {limit})</button>
          <button type="button" className="min-h-11 underline" onClick={() => setSelected([])}>Clear selection</button>
        </div>
        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-[var(--ghost-border)]">
          {records.map((record) => <label key={record.id} className="flex min-h-14 items-center gap-3 border-b border-[var(--ghost-border)] p-3">
            <input type="checkbox" className="h-4 w-4 shrink-0" checked={selected.includes(record.id)} disabled={!selected.includes(record.id) && selectedRecords.length >= limit}
              onChange={(event) => setSelected((current) => event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id))} />
            <span className="min-w-0"><span className="block break-words text-sm font-medium">{getModuleRecordTitle(record, collection)}</span><span className="block break-words text-xs" style={{ color: 'var(--on-surface-variant)' }}>{getModuleRecordSubtitle(record, collection)}</span></span>
          </label>)}
        </div>
        {error && <p role="alert" className="text-sm">{error}</p>}
        {hasMore && <button type="button" className="min-h-11 underline" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more matching records'}</button>}
        <button type="button" className="min-h-11 rounded-lg px-4 font-medium" style={{ background: 'var(--primary-container)', color: 'white' }} disabled={!selectedRecords.length || loading || Boolean(error)} onClick={continueToForm}>Continue with {selectedRecords.length} selected</button>
      </div>
    </AppDialog>
    {draft && <ModuleRecordFormDialog open collection={draft.collection} slug={installedModule.slug} collections={installedModule.manifest.collections} initialRelations={draft.relations}
      onClose={() => setDraft(null)} onSubmit={async (data, idempotencyKey, _unsetFields, relations) => {
        const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/records`, {
          collection_key: draft.collection.key, data, relations, expected_manifest_digest: draft.digest, idempotency_key: idempotencyKey,
        });
        if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to create the linked record.'));
        const result = await response.json();
        await refreshModuleCaches(installedModule.slug);
        setDraft(null);
        router.push(moduleRecordHref(installedModule.slug, draft.collection.key, result.record.id));
      }} />}
  </>;
}
