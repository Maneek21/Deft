'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, Link2, Loader2, Pencil, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  humanizeIdentifier,
  moduleApiError,
  resourceRefKey,
  resourceRefPayload,
  type ModuleCollection,
  type ModuleField,
  type ResourceRef,
} from '@/lib/modules';
import { useResourceRelation, useResourceRelationOptions } from '@/hooks/use-modules';

export function ModuleResourceRelations({
  slug,
  collection,
  recordId,
  canWrite,
}: {
  slug: string;
  collection: ModuleCollection;
  recordId: string;
  canWrite: boolean;
}) {
  const fields = collection.fields.filter((field) => field.type === 'resource_ref');
  if (fields.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-xl"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
      aria-labelledby="module-resource-relations-heading"
    >
      <header className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--ghost-border)' }}>
        <Link2 size={14} style={{ color: 'var(--primary)' }} />
        <h2 id="module-resource-relations-heading" className="text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
          Connected resources
        </h2>
      </header>
      <div className="divide-y divide-[var(--ghost-border)]">
        {fields.map((field) => (
          <ResourceReferenceField
            key={field.key}
            slug={slug}
            recordId={recordId}
            field={field}
            canWrite={canWrite}
          />
        ))}
      </div>
    </section>
  );
}

function ResourceReferenceField({
  slug,
  recordId,
  field,
  canWrite,
}: {
  slug: string;
  recordId: string;
  field: ModuleField;
  canWrite: boolean;
}) {
  const relationState = useResourceRelation(slug, recordId, field.key);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const optionsState = useResourceRelationOptions(slug, recordId, field.key, query, editing);
  const [selected, setSelected] = useState<ResourceRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) setSelected(relationState.relation.items.map((item) => item.ref));
  }, [editing, relationState.relation.items]);

  const toggle = (ref: ResourceRef) => {
    const key = resourceRefKey(ref);
    setSelected((current) => {
      const present = current.some((candidate) => resourceRefKey(candidate) === key);
      if (present) return current.filter((candidate) => resourceRefKey(candidate) !== key);
      return field.multiple ? [...current, ref] : [ref];
    });
  };
  const selectedUnavailable = relationState.relation.items.filter((item) => (
    item.state === 'unavailable'
    && selected.some((candidate) => resourceRefKey(candidate) === resourceRefKey(item.ref))
  ));

  const save = async () => {
    setBusy(true);
    setError(null);
    const activeIntentKey = intentKey ?? createResourceRelationIntentKey();
    if (!intentKey) setIntentKey(activeIntentKey);
    try {
      const response = await api.put(
        `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/resource-relations/${encodeURIComponent(field.key)}`,
        {
          refs: selected.map(resourceRefPayload),
          expected_revision: relationState.relation.revision,
          idempotency_key: activeIntentKey,
        },
      );
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${field.label.toLowerCase()}.`));
      await relationState.mutate();
      setIntentKey(null);
      setQuery('');
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update connected resources.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--outline)' }}>{field.label}</h3>
          <p className="mt-0.5 truncate text-[0.625rem]" style={{ color: 'var(--outline)' }}>
            {field.multiple ? 'Multiple' : 'One'} · {humanizeIdentifier(field.targetResourceType ?? '')}
          </p>
        </div>
        {canWrite && !editing && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setIntentKey(createResourceRelationIntentKey());
              setEditing(true);
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[0.6875rem] font-medium"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {relationState.isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading resources…
        </div>
      ) : relationState.error ? (
        <p className="mt-3 text-[0.75rem]" style={{ color: 'var(--error)' }}>Connected resources could not be loaded.</p>
      ) : !editing ? (
        relationState.relation.items.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {relationState.relation.items.map((item) => item.state === 'available' && item.resource ? (
              <Link
                key={resourceRefKey(item.ref)}
                href={item.resource.href ?? '#'}
                className="flex min-h-10 items-center gap-2 rounded-lg px-2.5"
                style={{ background: 'var(--surface-container)' }}
              >
                <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{item.resource.label}</span>
                <ChevronRight size={13} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
              </Link>
            ) : (
              <div
                key={resourceRefKey(item.ref)}
                className="flex min-h-10 items-center rounded-lg px-2.5 text-[0.75rem]"
                style={{ background: 'var(--surface-container)', color: 'var(--outline)' }}
              >
                Unavailable resource
              </div>
            ))}
          </div>
        ) : <p className="mt-3 text-[0.75rem]" style={{ color: 'var(--outline)' }}>No connected resources.</p>
      ) : (
        <div className="mt-3">
          {selectedUnavailable.length > 0 && (
            <div className="mb-2 space-y-1 rounded-lg p-2" style={{ background: 'var(--surface-container)' }}>
              {selectedUnavailable.map((item) => (
                <div key={resourceRefKey(item.ref)} className="flex min-h-9 items-center gap-2 px-1">
                  <span className="min-w-0 flex-1 truncate text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
                    Unavailable resource
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(item.ref)}
                    className="flex min-h-8 items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium"
                    style={{ color: 'var(--error)' }}
                  >
                    <X size={11} /> Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="relative block">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--outline)' }} />
            <span className="sr-only">Search {field.label}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${humanizeIdentifier(field.targetResourceType ?? 'resources').toLowerCase()}`}
              className="min-h-10 w-full rounded-lg pl-9 pr-3 text-[0.75rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
              style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--outline-variant)' }}
            />
          </label>
          <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg p-1" style={{ background: 'var(--surface-container)' }}>
            {optionsState.isLoading ? (
              <div className="flex min-h-20 items-center justify-center gap-2 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
                <Loader2 size={14} className="animate-spin" /> Loading options…
              </div>
            ) : optionsState.error ? (
              <p className="px-3 py-4 text-center text-[0.75rem]" style={{ color: 'var(--error)' }}>Options could not be loaded.</p>
            ) : optionsState.options.length === 0 ? (
              <p className="px-3 py-4 text-center text-[0.75rem]" style={{ color: 'var(--outline)' }}>No resources available.</p>
            ) : optionsState.options.map((option) => {
              const checked = selected.some((candidate) => resourceRefKey(candidate) === resourceRefKey(option.ref));
              return (
                <button
                  key={resourceRefKey(option.ref)}
                  type="button"
                  onClick={() => toggle(option.ref)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 text-left"
                  style={{ background: checked ? 'var(--bg-active)' : 'transparent' }}
                >
                  <span
                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded"
                    style={{ border: `1px solid ${checked ? 'var(--primary)' : 'var(--outline-variant)'}`, background: checked ? 'var(--primary)' : 'transparent', color: 'white' }}
                  >
                    {checked && <Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{option.label}</span>
                </button>
              );
            })}
          </div>
          {error && <p role="alert" className="mt-2 text-[0.6875rem]" style={{ color: 'var(--error)' }}>{error}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setIntentKey(null); setQuery(''); setEditing(false); }}
              disabled={busy}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-[0.75rem] font-medium disabled:opacity-50"
              style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
            >
              <X size={13} /> Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || optionsState.isLoading}
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

function createResourceRelationIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `resource-relation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
