'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, Link2, Loader2, Pencil, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  buildModuleRelationReplacePayload,
  getModuleRecordSubtitle,
  getModuleRecordTitle,
  humanizeIdentifier,
  moduleApiError,
  moduleRecordHref,
  type ModuleCollection,
  type ModuleField,
  type ModuleRelationGroup,
} from '@/lib/modules';
import { useModuleRecords, useModuleRelations } from '@/hooks/use-modules';

export function ModuleRecordRelations({
  slug,
  collection,
  collections,
  recordId,
  recordRevision,
  manifestDigest,
  canWrite,
  onRecordChanged,
}: {
  slug: string;
  collection: ModuleCollection;
  collections: ModuleCollection[];
  recordId: string;
  recordRevision: number;
  manifestDigest: string;
  canWrite: boolean;
  onRecordChanged: () => Promise<unknown>;
}) {
  const relationFields = collection.fields.filter((field) => field.type === 'relation' && field.targetCollection);
  const relationState = useModuleRelations(slug, recordId, relationFields.length > 0);

  if (relationFields.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-xl"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
      aria-labelledby="module-relations-heading"
    >
      <header className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--ghost-border)' }}>
        <Link2 size={14} style={{ color: 'var(--primary)' }} />
        <h2 id="module-relations-heading" className="text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
          Related records
        </h2>
      </header>
      {relationState.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading relationships…
        </div>
      ) : relationState.error ? (
        <div className="px-4 py-4 text-[0.75rem]" style={{ color: 'var(--error)' }}>
          Relationships could not be loaded.
          <button type="button" onClick={() => void relationState.mutate()} className="ml-2 font-medium underline">Retry</button>
        </div>
      ) : (
        <div className="divide-y divide-[var(--ghost-border)]">
          {relationFields.map((field) => (
            <RelationField
              key={field.key}
              slug={slug}
              field={field}
              targetDefinition={collections.find((candidate) => candidate.key === field.targetCollection) ?? null}
              recordId={recordId}
              recordRevision={recordRevision}
              manifestDigest={manifestDigest}
              group={relationState.relations.find((candidate) => candidate.fieldKey === field.key)}
              canWrite={canWrite}
              onSaved={() => Promise.all([relationState.mutate(), onRecordChanged()])}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RelationField({
  slug,
  field,
  targetDefinition,
  recordId,
  recordRevision,
  manifestDigest,
  group,
  canWrite,
  onSaved,
}: {
  slug: string;
  field: ModuleField;
  targetDefinition: ModuleCollection | null;
  recordId: string;
  recordRevision: number;
  manifestDigest: string;
  group?: ModuleRelationGroup;
  canWrite: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetCollection = field.targetCollection ?? '';
  const displayCollection = targetDefinition ?? {
    key: targetCollection,
    name: humanizeIdentifier(targetCollection),
    singularName: humanizeIdentifier(targetCollection),
    description: null,
    fields: [],
    titleField: null,
    subtitleFields: [],
    views: [],
  };
  const candidates = useModuleRecords(slug, editing ? targetCollection : '');

  useEffect(() => {
    if (editing) setSelected(group?.records.map((record) => record.id) ?? []);
  }, [editing, group?.records]);

  const toggle = (id: string) => {
    setSelected((current) => field.multiple
      ? current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
      : current.includes(id) ? [] : [id]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const activeIntentKey = intentKey ?? createRelationIntentKey();
    if (!intentKey) setIntentKey(activeIntentKey);
    try {
      const response = await api.put(
        `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/relations/${encodeURIComponent(field.key)}`,
        buildModuleRelationReplacePayload({
          recordIds: selected,
          expectedRevision: recordRevision,
          expectedManifestDigest: manifestDigest,
          idempotencyKey: activeIntentKey,
        }),
      );
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${field.label.toLowerCase()}.`));
      await onSaved();
      setIntentKey(null);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update this relationship.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--outline)' }}>{field.label}</h3>
          <p className="mt-0.5 text-[0.625rem]" style={{ color: 'var(--outline)' }}>
            {field.multiple ? 'Multiple' : 'One'} · {humanizeIdentifier(targetCollection)}
          </p>
        </div>
        {canWrite && !editing && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setIntentKey(createRelationIntentKey());
              setEditing(true);
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[0.6875rem] font-medium"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {!editing ? (
        group && group.records.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {group.records.map((related) => (
              <Link
                key={related.id}
                href={moduleRecordHref(slug, related.collectionKey, related.id)}
                className="flex min-h-10 items-center gap-2 rounded-lg px-2.5"
                style={{ background: 'var(--surface-container)' }}
              >
                <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{related.label}</span>
                <ChevronRight size={13} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[0.75rem]" style={{ color: 'var(--outline)' }}>No related records.</p>
        )
      ) : (
        <div className="mt-3">
          {candidates.isLoading ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
              <Loader2 size={14} className="animate-spin" /> Loading options…
            </div>
          ) : candidates.error ? (
            <p className="py-3 text-[0.75rem]" style={{ color: 'var(--error)' }}>Options could not be loaded.</p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg p-1" style={{ background: 'var(--surface-container)' }}>
              {candidates.records.filter((candidate) => candidate.id !== recordId).length === 0 ? (
                <p className="px-3 py-4 text-center text-[0.75rem]" style={{ color: 'var(--outline)' }}>No records available.</p>
              ) : candidates.records.filter((candidate) => candidate.id !== recordId).map((candidate) => {
                const checked = selected.includes(candidate.id);
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggle(candidate.id)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 text-left"
                    style={{ background: checked ? 'var(--bg-active)' : 'transparent' }}
                  >
                    <span
                      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded"
                      style={{ border: `1px solid ${checked ? 'var(--primary)' : 'var(--outline-variant)'}`, background: checked ? 'var(--primary)' : 'transparent', color: 'white' }}
                    >
                      {checked && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(candidate, displayCollection)}</span>
                      <span className="block truncate text-[0.625rem]" style={{ color: 'var(--outline)' }}>{getModuleRecordSubtitle(candidate, displayCollection) || candidate.id.slice(0, 8)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-[0.6875rem]" style={{ color: 'var(--error)' }}>{error}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setIntentKey(null);
                setEditing(false);
              }}
              disabled={busy}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-[0.75rem] font-medium disabled:opacity-50"
              style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
            >
              <X size={13} /> Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || candidates.isLoading}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-[0.75rem] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--primary-container)' }}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function createRelationIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `module-relation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
