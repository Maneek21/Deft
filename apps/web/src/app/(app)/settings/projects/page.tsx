'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { Archive, RotateCcw, Loader2, FolderX } from 'lucide-react';
import { formatRelative } from '@/lib/time';

type DeletedProject = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  deleted_at: string;
};

export default function ProjectsRecoveryPage() {
  const [projects, setProjects] = useState<DeletedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/api/projects/recently-deleted');
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error || `Failed to load (HTTP ${res.status})`);
        return;
      }
      setProjects(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${id}/restore`, {});
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error || `Restore failed (HTTP ${res.status})`);
        return;
      }
      // Drop the restored project from the list locally; refetch in
      // case the backend changed any other state (timestamps etc.).
      setProjects((prev) => prev.filter((p) => p.id !== id));
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-[20px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
          Deleted projects
        </h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
          Soft-deleted projects within the last 7 days. After 7 days they&apos;re purged and can no longer be restored.
        </p>
      </div>

      {error && (
        <div className="text-[12px] px-3 py-2 rounded-md mb-4" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-16 px-6 rounded-lg text-center"
          style={{ background: 'var(--surface-container-low)', border: '1px dashed var(--border-default, var(--outline-variant))' }}
        >
          <FolderX size={32} strokeWidth={1.25} style={{ color: 'var(--muted)' }} />
          <p className="text-[13px] mt-3" style={{ color: 'var(--foreground)' }}>No recently deleted projects.</p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--muted)' }}>
            Anything deleted in the last 7 days shows up here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 px-3 py-3 rounded-lg"
              style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default, var(--outline-variant))' }}
            >
              <div className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: p.color ?? 'var(--surface-container)' }}>
                <Archive size={14} strokeWidth={1.5} style={{ color: 'var(--on-primary, white)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{p.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface-container)', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                    {p.prefix}
                  </span>
                </div>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  Deleted {formatRelative(p.deleted_at)}
                </p>
              </div>
              <button
                onClick={() => handleRestore(p.id)}
                disabled={restoringId === p.id}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium disabled:opacity-50"
                style={{ background: 'var(--surface-container-high, var(--accent-muted))', color: 'var(--on-surface)' }}
              >
                {restoringId === p.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} strokeWidth={1.75} />}
                {restoringId === p.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
