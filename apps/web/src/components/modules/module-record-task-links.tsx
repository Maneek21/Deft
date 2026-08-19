'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckSquare2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { normalizeModuleRecordTaskLinks, type ModuleRecordTaskLink } from '@/lib/module-task-links';
import { statusLabel } from '@/lib/task-status-labels';

export function ModuleRecordTaskLinks({ slug, recordId }: { slug: string; recordId: string }) {
  const [links, setLinks] = useState<ModuleRecordTaskLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLinks([]);
    setError(null);
    void api.get(`/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/tasks`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load linked tasks.');
        const next = normalizeModuleRecordTaskLinks(await response.json());
        if (live) setLinks(next);
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Unable to load linked tasks.');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [recordId, slug]);

  return (
    <section className="overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }} aria-label="Linked tasks">
      <header className="flex items-center gap-2 border-b border-[var(--ghost-border)] px-4 py-3">
        <CheckSquare2 size={14} style={{ color: 'var(--primary)' }} />
        <h2 className="text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Linked tasks</h2>
        {!loading && links.length > 0 && <span className="text-[0.625rem]" style={{ color: 'var(--outline)' }}>{links.length}</span>}
      </header>
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-[0.6875rem]" style={{ color: 'var(--outline)' }}><Loader2 size={12} className="animate-spin" /> Loading tasks…</div>
      ) : error ? (
        <p role="alert" className="px-4 py-4 text-[0.6875rem]" style={{ color: 'var(--error)' }}>{error}</p>
      ) : links.length === 0 ? (
        <p className="px-4 py-4 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--outline)' }}>Attach this record from a task’s References tab.</p>
      ) : (
        <div className="divide-y divide-[var(--ghost-border)]">
          {links.map((link) => (
            <Link key={link.edgeId} href={link.url} className="flex min-h-12 items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-container)]">
              <span className="rounded px-1.5 py-0.5 font-mono text-[0.625rem]" style={{ color: 'var(--primary)', background: 'var(--surface-container-high)' }}>
                {link.identifier ?? 'Task'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{link.title}</span>
                <span className="block truncate text-[0.625rem]" style={{ color: 'var(--outline)' }}>{link.projectName}</span>
              </span>
              <span className="text-[0.625rem]" style={{ color: 'var(--outline)' }}>{statusLabel(link.status)}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
