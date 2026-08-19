'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Boxes, Link2, Loader2, Plus, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  normalizeTaskModuleRecordLinks,
  type TaskModuleRecordLink,
} from '@/lib/module-task-links';

type ModuleSearchResult = {
  id: string;
  type: 'module_record';
  title: string;
  snippet: string | null;
  module_name: string;
  collection_name: string;
};

export function TaskModuleRecordLinks({
  taskId,
  canEdit,
  onCountChange,
}: {
  taskId: string;
  canEdit: boolean;
  onCountChange?: (count: number) => void;
}) {
  const [links, setLinks] = useState<TaskModuleRecordLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ModuleSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLinks([]);
    setError(null);
    onCountChange?.(0);
    try {
      const response = await api.get(`/api/tasks/${encodeURIComponent(taskId)}/module-records`);
      if (!response.ok) throw new Error('Unable to load module records.');
      const next = normalizeTaskModuleRecordLinks(await response.json());
      if (sequence !== loadSequence.current) return;
      setLinks(next);
      onCountChange?.(next.length);
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : 'Unable to load module records.');
      onCountChange?.(0);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [onCountChange, taskId]);

  useEffect(() => {
    setAdding(false);
    setQuery('');
    setResults([]);
    setBusyId(null);
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  useEffect(() => {
    const sequence = ++searchSequence.current;
    const trimmed = query.trim();
    if (!adding || trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get(`/api/search?q=${encodeURIComponent(trimmed)}`);
        if (!response.ok) throw new Error('Search failed.');
        const body = await response.json() as { modules?: unknown };
        if (sequence !== searchSequence.current) return;
        const rows = Array.isArray(body.modules) ? body.modules : [];
        setResults(rows.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const row = value as Record<string, unknown>;
          if (
            typeof row.id !== 'string' || !row.id.startsWith('module_record:')
            || typeof row.title !== 'string' || typeof row.module_name !== 'string'
            || typeof row.collection_name !== 'string'
          ) return [];
          return [{
            id: row.id,
            type: 'module_record' as const,
            title: row.title,
            snippet: typeof row.snippet === 'string' ? row.snippet : null,
            module_name: row.module_name,
            collection_name: row.collection_name,
          }];
        }));
      } catch (reason) {
        if (sequence === searchSequence.current) {
          setError(reason instanceof Error ? reason.message : 'Search failed.');
          setResults([]);
        }
      } finally {
        if (sequence === searchSequence.current) setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [adding, query]);

  const linkedIds = useMemo(() => new Set(links.map((link) => link.resourceId)), [links]);
  const availableResults = results.filter((result) => !linkedIds.has(result.id));

  const attach = async (resourceId: string) => {
    setBusyId(resourceId);
    setError(null);
    try {
      const response = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/module-records`, {
        resource_id: resourceId,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === 'string' ? body.error : 'Unable to attach the record.');
      }
      await load();
      setAdding(false);
      setQuery('');
      setResults([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to attach the record.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (link: TaskModuleRecordLink) => {
    setBusyId(link.resourceId);
    setError(null);
    try {
      const response = await api.delete(
        `/api/tasks/${encodeURIComponent(taskId)}/module-records/${encodeURIComponent(link.recordId)}`,
      );
      if (!response.ok) throw new Error('Unable to remove the link.');
      const next = links.filter((candidate) => candidate.edgeId !== link.edgeId);
      setLinks(next);
      onCountChange?.(next.length);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove the link.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Module records" className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="inline-flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
          <Boxes size={12} /> Module records
        </span>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setError(null); }}
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-2.5 text-[0.6875rem] font-medium"
            style={{ color: 'var(--primary)', background: 'var(--surface-container-high)' }}
          >
            <Plus size={12} /> Attach
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <Search size={13} style={{ color: 'var(--muted)' }} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search module records…"
              className="min-h-9 min-w-0 flex-1 bg-transparent text-[0.75rem] outline-none"
              style={{ color: 'var(--foreground)' }}
            />
            {searching && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--muted)' }} />}
            <button type="button" aria-label="Close record search" onClick={() => { setAdding(false); setQuery(''); setResults([]); }} className="p-1" style={{ color: 'var(--muted)' }}>
              <X size={13} />
            </button>
          </div>
          {query.trim() && !searching && availableResults.length === 0 && (
            <p className="px-1 py-2 text-[0.6875rem]" style={{ color: 'var(--muted)' }}>No matching records.</p>
          )}
          {availableResults.length > 0 && (
            <div className="mt-1 max-h-52 space-y-1 overflow-y-auto">
              {availableResults.map((result) => (
                <button
                  type="button"
                  key={result.id}
                  disabled={busyId !== null}
                  onClick={() => void attach(result.id)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                  style={{ background: 'var(--surface-container-low)' }}
                >
                  {busyId === result.id ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.75rem] font-medium" style={{ color: 'var(--foreground)' }}>{result.title}</span>
                    <span className="block truncate text-[0.625rem]" style={{ color: 'var(--muted)' }}>{result.module_name} · {result.collection_name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="px-1 text-[0.6875rem]" style={{ color: 'var(--error)' }}>{error}</p>}
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-2 text-[0.6875rem]" style={{ color: 'var(--muted)' }}><Loader2 size={12} className="animate-spin" /> Loading records…</div>
      ) : links.length === 0 ? (
        <p className="px-2 py-1 text-[0.6875rem]" style={{ color: 'var(--muted)' }}>No module records attached.</p>
      ) : (
        <div className="space-y-1.5">
          {links.map((link) => (
            <div key={link.edgeId} className="flex min-h-12 items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--surface-container)' }}>
              <Boxes size={14} className="flex-shrink-0" style={{ color: 'var(--primary)' }} />
              <Link href={link.url} className="min-w-0 flex-1">
                <span className="block truncate text-[0.75rem] font-medium" style={{ color: 'var(--foreground)' }}>{link.title}</span>
                <span className="block truncate text-[0.625rem]" style={{ color: 'var(--muted)' }}>{link.moduleName} · {link.collectionName}</span>
              </Link>
              {canEdit && (
                <button type="button" aria-label={`Remove ${link.title}`} disabled={busyId !== null} onClick={() => void remove(link)} className="flex min-h-9 min-w-9 items-center justify-center rounded" style={{ color: 'var(--muted)' }}>
                  {busyId === link.resourceId ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
