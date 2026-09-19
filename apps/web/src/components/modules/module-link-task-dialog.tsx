'use client';

import { useEffect, useState } from 'react';
import { Link2, Loader2, Search } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { moduleApiError } from '@/lib/modules';
import { statusLabel } from '@/lib/task-status-labels';

type Task = { id: string; title: string; project_prefix: string; number: number; status: string };
function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0 && typeof row.title === 'string'
    && typeof row.project_prefix === 'string' && typeof row.number === 'number' && Number.isSafeInteger(row.number)
    && typeof row.status === 'string';
}

export function ModuleLinkTaskDialog({ resourceId, linkedTaskIds, onClose, onLinked }: {
  resourceId: string; linkedTaskIds: string[]; onClose: () => void; onLinked: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Task[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setResults([]);
    setError(null);
    const text = query.trim();
    setSearching(Boolean(text));
    if (!text) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get(`/api/tasks/search?q=${encodeURIComponent(text)}`);
        if (!response.ok) throw new Error('Unable to search tasks.');
        const data: unknown = await response.json();
        if (!Array.isArray(data) || !data.every(isTask)) throw new Error('Task search response is invalid.');
        if (current) setResults(data);
      } catch {
        if (current) setError('Unable to search tasks. Try again.');
      } finally { if (current) setSearching(false); }
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query, retry]);

  const attach = async (task: Task) => {
    if (busy) return;
    setBusy(task.id);
    setError(null);
    try {
      const response = await api.post(`/api/tasks/${encodeURIComponent(task.id)}/module-records`, { resource_id: resourceId });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to link this task.'));
      await onLinked();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to link this task.'); }
    finally { setBusy(null); }
  };

  return <AppDialog title="Link an existing task" onClose={() => { if (!busy) onClose(); }} footer={<button type="button" disabled={Boolean(busy)} onClick={onClose} className="min-h-10 rounded-full px-4 text-sm">Cancel</button>}>
    <p className="mb-4 text-sm text-[var(--on-surface-variant)]">Keep the same task, assignee, due date, and conversation in Deft.</p>
    <label className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--ghost-border)] px-3 focus-within:border-[var(--primary)]">
      <Search size={16} aria-hidden="true" />
      <input autoFocus aria-label="Search existing tasks" value={query} disabled={Boolean(busy)} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or task ID…" className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none focus:shadow-none! focus-visible:outline-none!" />
    </label>
    {error && <div role="alert" className="mt-3 text-sm text-[var(--error)]">{error}<button type="button" disabled={Boolean(busy)} onClick={() => setRetry((value) => value + 1)} className="ml-2 min-h-11 underline">Retry search</button></div>}
    {searching ? <p role="status" className="flex items-center gap-2 py-4 text-sm"><Loader2 size={14} className="animate-spin" />Searching tasks…</p>
      : !query.trim() ? <p className="py-4 text-sm text-[var(--on-surface-variant)]">Find a task to connect it to this record.</p>
        : !error && !results.length ? <p className="py-4 text-sm text-[var(--on-surface-variant)]">No matching tasks. Try another title.</p>
          : <><ul className="mt-3 divide-y divide-[var(--ghost-border)]">{results.map((task) => {
            const linked = linkedTaskIds.includes(task.id);
            return <li key={task.id}><button type="button" disabled={Boolean(busy) || linked} onClick={() => void attach(task)} className="flex min-h-16 w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-[var(--surface-container-high)] disabled:opacity-60">
              <span className="min-w-0 flex-1"><span className="block text-xs text-[var(--on-surface-variant)]">{task.project_prefix}-{task.number} · {statusLabel(task.status)}</span><span className="mt-1 block break-words text-sm font-medium">{task.title}</span></span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--primary)]">{busy === task.id ? <Loader2 size={14} className="animate-spin" /> : linked ? 'Linked' : <><Link2 size={14} />Link task</>}</span>
            </button></li>;
          })}</ul>{results.length >= 20 && <p className="pt-3 text-xs text-[var(--on-surface-variant)]">Showing the first 20 matches. Refine your search to find a specific task.</p>}</>}
  </AppDialog>;
}
