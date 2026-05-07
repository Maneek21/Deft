'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, Archive, Trash2 } from 'lucide-react';
import ConfirmDialog from './confirm-dialog';

const PRESET_COLORS = [
  '#D4A853', // amber
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#22C55E', // green
  '#EF4444', // red
  '#6B7280', // gray
];

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  description: string | null;
  lead_id: string | null;
  is_archived?: boolean;
  task_counter?: number;
  total_tasks?: number;
  done_tasks?: number;
};

type Member = {
  id: string;
  name: string;
  avatar_url?: string | null;
};

type Props = {
  project: Project;
  onClose: () => void;
  // Called after any successful mutation so the sidebar can refresh.
  // `action` communicates what happened so the parent can update local
  // state without a round-trip (e.g. remove from active list on archive).
  onUpdated?: (project: Project, action: 'updated' | 'archived' | 'deleted') => void;
};

export function ProjectSettingsModal({ project, onClose, onUpdated }: Props) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [color, setColor] = useState(project.color ?? PRESET_COLORS[0]!);
  const [leadId, setLeadId] = useState<string | ''>(project.lead_id ?? '');
  const [members, setMembers] = useState<Member[]>([]);

  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape' && !confirmDelete) onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose, confirmDelete]);

  // Load org members for the lead picker. Silent-fail — if it fails the
  // lead dropdown simply shows only the currently-selected lead (if any).
  useEffect(() => {
    let cancelled = false;
    api.get('/api/members').then(async (res) => {
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as Member[];
      if (!cancelled) setMembers(data);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hasChanges =
    name.trim() !== project.name ||
    (description.trim() || null) !== (project.description ?? null) ||
    color !== (project.color ?? PRESET_COLORS[0]) ||
    (leadId || null) !== (project.lead_id ?? null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch(`/api/projects/${project.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        color,
        lead_id: leadId || null,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to save' }));
        throw new Error(data.error || 'Failed to save');
      }
      const updated = (await res.json()) as Project;
      onUpdated?.(updated, 'updated');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    setError(null);
    try {
      const res = await api.patch(`/api/projects/${project.id}`, {
        is_archived: true,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to archive' }));
        throw new Error(data.error || 'Failed to archive');
      }
      const updated = (await res.json()) as Project;
      onUpdated?.(updated, 'archived');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive');
    } finally {
      setArchiving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await api.delete(`/api/projects/${project.id}`);
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({ error: 'Failed to delete' }));
        throw new Error(data.error || 'Failed to delete');
      }
      onUpdated?.(project, 'deleted');
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || archiving || deleting;

  return (
    <>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center"
        style={{ background: 'rgba(0, 0, 0, 0.5)' }}
        onClick={() => {
          if (!busy) onClose();
        }}
      >
        <div
          className="w-[calc(100vw-2rem)] max-w-[480px] max-h-[90vh] overflow-y-auto rounded-2xl"
          style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className="px-5 py-4 flex items-center justify-between"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <h2
              className="text-[15px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Project settings
            </h2>
            <button
              onClick={onClose}
              disabled={busy}
              className="p-1 rounded-md"
              style={{ color: 'var(--muted)' }}
              aria-label="Close"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          <div className="p-5">
            {/* Name */}
            <div className="mb-3">
              <label
                className="text-[12px] font-medium mb-1 block"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                Name
              </label>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                }}
              />
            </div>

            {/* Prefix (read-only) */}
            <div className="mb-3">
              <label
                className="text-[12px] font-medium mb-1 block"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                Prefix{' '}
                <span style={{ color: 'var(--muted)' }}>
                  (immutable — task IDs reference it)
                </span>
              </label>
              <input
                type="text"
                value={project.prefix}
                readOnly
                disabled
                className="w-full px-3 py-2 rounded-lg text-[13px] uppercase cursor-not-allowed"
                style={{
                  background: 'var(--surface-container)',
                  border: '1px solid var(--input-border)',
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-body)',
                  letterSpacing: '0.05em',
                }}
              />
            </div>

            {/* Description */}
            <div className="mb-3">
              <label
                className="text-[12px] font-medium mb-1 block"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                Description <span style={{ color: 'var(--muted)' }}>(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                }}
              />
            </div>

            {/* Color */}
            <div className="mb-4">
              <label
                className="text-[12px] font-medium mb-2 block"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                Color
              </label>
              <div className="flex gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className="w-7 h-7 rounded-full flex items-center justify-center transition-transform"
                    style={{
                      background: c,
                      transform: color === c ? 'scale(1.15)' : 'scale(1)',
                      boxShadow:
                        color === c ? `0 0 0 2px var(--card-bg), 0 0 0 4px ${c}` : 'none',
                    }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </div>

            {/* Lead */}
            <div className="mb-4">
              <label
                className="text-[12px] font-medium mb-1 block"
                style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                Project lead <span style={{ color: 'var(--muted)' }}>(optional)</span>
              </label>
              <select
                value={leadId}
                onChange={(e) => setLeadId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <option value="">No lead</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
                {leadId && !members.some((m) => m.id === leadId) && (
                  <option value={leadId}>(current lead)</option>
                )}
              </select>
            </div>

            {error && (
              <p className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}

            {/* Primary save action */}
            <div className="flex items-center gap-2 mb-5">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground-secondary)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !name.trim() || !hasChanges}
                className="flex-1 py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
                style={{
                  background: 'var(--accent)',
                  opacity: busy || !name.trim() || !hasChanges ? 0.5 : 1,
                  fontFamily: 'var(--font-heading)',
                }}
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            </div>

            {/* Destructive zone */}
            <div
              className="pt-4 flex flex-col gap-2"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <div
                className="text-[11px] font-medium uppercase tracking-wide mb-1"
                style={{ color: 'var(--muted)' }}
              >
                Danger zone
              </div>

              <button
                type="button"
                onClick={handleArchive}
                disabled={busy || project.is_archived}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  background: 'var(--surface-container)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                  opacity: busy || project.is_archived ? 0.5 : 1,
                }}
              >
                <span className="flex items-center gap-2">
                  <Archive size={14} strokeWidth={1.5} />
                  {project.is_archived ? 'Already archived' : 'Archive project'}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  {archiving ? 'Archiving...' : 'Hide from sidebar'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--danger)',
                  color: 'var(--danger)',
                  fontFamily: 'var(--font-body)',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <span className="flex items-center gap-2">
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete project
                </span>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  7-day recovery window
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete project?"
          message={`"${project.name}" will be soft-deleted. Tasks remain in the database for audit but stop appearing in views. You can restore the project within 7 days from Settings → Recently deleted.`}
          confirmLabel={deleting ? 'Deleting...' : 'Delete'}
          cancelLabel="Cancel"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
