'use client';

import Link from 'next/link';
import { useModuleRelatedLatest } from '@/hooks/use-modules';
import { moduleRecordHref } from '@/lib/modules';

export function ModuleRelatedLatest({ slug, recordId }: { slug: string; recordId: string }) {
  const state = useModuleRelatedLatest(slug, recordId);
  return <section aria-label="Related summaries" className="space-y-3 rounded-xl border border-[var(--ghost-border)] bg-[var(--surface-container-low)] p-4">
    {state.error ? <div role="alert"><p className="text-sm">Unable to load related summaries.</p><button type="button" className="min-h-11 text-sm underline" onClick={() => void state.mutate()}>Try again</button></div>
      : !state.data ? <p role="status" className="text-sm">Loading related summaries…</p>
        : state.data.summaries.map((summary) => <div key={summary.key}>
          <h2 className="text-sm font-semibold">{summary.label}</h2>
          {summary.latest ? <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <time dateTime={summary.latest.date} className="block text-sm text-[var(--on-surface-variant)]">{summary.date_type === 'date'
              ? new Date(`${summary.latest.date}T12:00:00`).toLocaleDateString()
              : new Date(summary.latest.date).toLocaleString()}</time>
            <Link className="block min-h-11 break-words py-3 text-sm text-[var(--primary)] underline" href={moduleRecordHref(slug, summary.latest.record.collection_key, summary.latest.record.id)}>{summary.latest.record.label}</Link>
          </div> : <p className="mt-2 text-sm text-[var(--on-surface-variant)]">Nothing recorded yet.</p>}
          {summary.description && <details className="mt-1 text-xs leading-relaxed text-[var(--on-surface-variant)]"><summary className="min-h-9 cursor-pointer py-2">About this summary</summary><p className="pt-1">{summary.description}</p></details>}
        </div>)}
  </section>;
}
