'use client';

import { useEffect, useState } from 'react';
import { Bookmark, Check, Loader2, Pencil, Save, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  buildModuleSavedViewConfig,
  normalizeModuleSavedViewsResponse,
  type ModuleQueryFilter,
  type ModuleQuerySort,
  type ModuleSavedView,
} from '@/lib/module-saved-views';
import {
  moduleApiError,
  type ModuleCollection,
  type ModuleView,
} from '@/lib/modules';

export function ModuleSavedViews({
  slug,
  collection,
  currentView,
  filters,
  sort,
  views,
  activeView,
  disabled = false,
  onSelect,
  onViewsChanged,
}: {
  slug: string;
  collection: ModuleCollection;
  currentView: ModuleView;
  filters: ModuleQueryFilter[];
  sort: ModuleQuerySort | undefined;
  views: ModuleSavedView[];
  activeView: ModuleSavedView | null;
  disabled?: boolean;
  onSelect: (view: ModuleSavedView | null) => void;
  onViewsChanged: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'closed' | 'create' | 'rename' | 'delete'>('closed');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'rename') setName(activeView?.name ?? '');
  }, [activeView?.name, mode]);

  const config = () => buildModuleSavedViewConfig({
    collection,
    view: currentView,
    filters,
    querySort: sort,
  });

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.post(`/api/modules/${encodeURIComponent(slug)}/saved-views`, {
        collection_key: collection.key,
        name: trimmed,
        config: config(),
      });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to create the personal view.'));
      const body = await response.json() as { view?: unknown };
      const created = normalizeModuleSavedViewsResponse({ views: [body.view] })[0];
      await onViewsChanged();
      if (created) onSelect(created);
      setMode('closed');
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create the personal view.');
    } finally {
      setSaving(false);
    }
  };

  const patch = async (body: { name?: string; config?: ReturnType<typeof config> }) => {
    if (!activeView) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.patch(
        `/api/modules/${encodeURIComponent(slug)}/saved-views/${encodeURIComponent(activeView.id)}`,
        body,
      );
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to update the personal view.'));
      const payload = await response.json() as { view?: unknown };
      const updated = normalizeModuleSavedViewsResponse({ views: [payload.view] })[0];
      await onViewsChanged();
      if (updated) onSelect(updated);
      setMode('closed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update the personal view.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!activeView) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.delete(
        `/api/modules/${encodeURIComponent(slug)}/saved-views/${encodeURIComponent(activeView.id)}`,
      );
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to delete the personal view.'));
      onSelect(null);
      await onViewsChanged();
      setMode('closed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete the personal view.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="flex min-h-10 min-w-[180px] flex-1 items-center gap-2 rounded-lg px-3 sm:max-w-[280px]"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
        >
          <Bookmark size={14} className="flex-shrink-0" style={{ color: activeView ? 'var(--primary)' : 'var(--outline)' }} />
          <span className="sr-only">Personal view</span>
          <select
            value={activeView?.id ?? ''}
            onChange={(event) => onSelect(views.find((view) => view.id === event.target.value) ?? null)}
            className="min-w-0 flex-1 bg-transparent text-[0.75rem] outline-none"
            style={{ color: 'var(--on-surface-variant)' }}
            aria-label="Personal view"
            disabled={disabled || saving}
          >
            <option value="">Manifest view</option>
            {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>

        <button
          type="button"
          onClick={() => { setMode('create'); setName(''); setError(null); }}
          disabled={disabled || saving}
          className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-[0.75rem] font-medium disabled:opacity-50"
          style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface-variant)', border: '1px solid var(--ghost-border)' }}
        >
          <Save size={14} /> Save view
        </button>

        {activeView && (
          <>
            <button
              type="button"
              onClick={() => void patch({ config: config() })}
              disabled={disabled || saving}
              className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-[0.75rem] font-medium disabled:opacity-50"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
            >
              {saving && mode === 'closed' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Update
            </button>
            <button
              type="button"
              onClick={() => { setMode('rename'); setError(null); }}
              disabled={disabled || saving}
              className="flex h-10 w-10 items-center justify-center rounded-lg disabled:opacity-50"
              style={{ color: 'var(--outline)', background: 'var(--surface-container-low)' }}
              aria-label={`Rename ${activeView.name}`}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => { setMode('delete'); setError(null); }}
              disabled={disabled || saving}
              className="flex h-10 w-10 items-center justify-center rounded-lg disabled:opacity-50"
              style={{ color: 'var(--error)', background: 'var(--danger-subtle)' }}
              aria-label={`Delete ${activeView.name}`}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>

      {(mode === 'create' || mode === 'rename') && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'create') void create();
            else void patch({ name: name.trim() });
          }}
          className="flex flex-col gap-2 rounded-xl p-3 sm:flex-row sm:items-center"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[0.6875rem] font-medium" style={{ color: 'var(--outline)' }}>
              {mode === 'create' ? 'New personal view name' : 'Rename personal view'}
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              className="min-h-10 w-full rounded-lg px-3 text-[0.8125rem] outline-none"
              style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--ghost-border)' }}
            />
          </label>
          <div className="flex items-center gap-2 sm:self-end">
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[0.75rem] font-medium text-white disabled:opacity-50 sm:flex-none"
              style={{ background: 'var(--primary-container)' }}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {mode === 'create' ? 'Create' : 'Rename'}
            </button>
            <button
              type="button"
              onClick={() => setMode('closed')}
              disabled={saving}
              className="flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ color: 'var(--outline)' }}
              aria-label="Cancel"
            >
              <X size={15} />
            </button>
          </div>
        </form>
      )}

      {mode === 'delete' && activeView && (
        <div
          className="flex flex-col gap-2 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between"
          style={{ background: 'var(--danger-subtle)', border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)' }}
        >
          <p className="text-[0.75rem]" style={{ color: 'var(--on-surface)' }}>
            Delete <strong>{activeView.name}</strong>? Records and manifest views are unaffected.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setMode('closed')} disabled={saving} className="min-h-10 rounded-lg px-3 text-[0.75rem] font-medium" style={{ color: 'var(--outline)' }}>
              Cancel
            </button>
            <button type="button" onClick={() => void remove()} disabled={saving} className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-[0.75rem] font-medium text-white disabled:opacity-50" style={{ background: 'var(--error)' }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-[0.75rem]" style={{ color: 'var(--error)' }}>{error}</p>}
      {!error && activeView && (
        <p className="text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
          Personal to you. Update saves the current fields, filter, sort, and layout.
        </p>
      )}
    </div>
  );
}
