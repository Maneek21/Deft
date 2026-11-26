'use client';

import type { ReactNode } from 'react';
import { Download, FileCheck2, Loader2, RefreshCw, X } from 'lucide-react';
import type { ModuleManifestPreview, ModuleManifestUploadDecision } from '@/lib/modules';

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The confirm step for an uploaded app file, before anything is installed. */
export function ModuleUploadReview({
  preview,
  decision,
  busy,
  onCancel,
  onConfirm,
  summary,
}: {
  preview: ModuleManifestPreview;
  decision: ModuleManifestUploadDecision;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** A plain-words description of the file, when one is available. */
  summary?: ReactNode;
}) {
  const upgrade = decision.mode === 'upgrade';
  const fromVersion = upgrade ? decision.target.manifest.version : null;
  return (
    <section
      aria-labelledby="app-upload-review-title"
      className="rounded-xl p-4 md:p-5"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary-container)' }}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
          <FileCheck2 size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide" style={{ color: 'var(--primary)' }}>
            {upgrade ? 'Check the update' : 'Check before installing'}
          </p>
          <h2 id="app-upload-review-title" className="mt-0.5 break-words text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
            {preview.name}{' '}
            <span className="font-normal" style={{ color: 'var(--on-surface-variant)' }}>
              {upgrade && fromVersion ? `v${fromVersion} → v${preview.version}` : `v${preview.version}`}
            </span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel this upload"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg disabled:opacity-50 md:h-9 md:w-9"
          style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-high)' }}
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      <div className="mt-4 space-y-3 md:pl-[52px]">
        {summary ?? (
          <ul className="space-y-1.5" aria-label="Record types in this app">
            {preview.manifest.collections.map((collection) => (
              <li key={collection.key} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[0.8125rem]" style={{ background: 'var(--surface-container-high)' }}>
                <span className="min-w-0 truncate font-medium" style={{ color: 'var(--on-surface)' }}>{collection.name}</span>
                <span className="shrink-0 text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
                  {plural(collection.fields.length, 'field')} · {plural(collection.views?.length ?? 0, 'view')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
          {upgrade
            ? 'Every record is kept. If a change would break a record that already exists, Deft refuses the update and tells you which field.'
            : 'Owners, admins and members can use it. Guests can’t. Deft stores only this file: it runs no code and fetches nothing. You can turn an app off later, but not delete it.'}
        </p>
        <details className="text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
          <summary className="min-h-11 cursor-pointer py-3 md:min-h-0 md:py-1">File details</summary>
          <dl className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Detail label="Id" value={preview.moduleId} />
            <Detail label="Slug" value={preview.slug} />
            <Detail label="Digest" value={preview.digest} wide />
          </dl>
        </details>
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-11 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-50"
            style={{ color: 'var(--on-surface)', background: 'var(--surface-container-high)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--primary-container)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : upgrade ? <RefreshCw size={14} aria-hidden /> : <Download size={14} aria-hidden />}
            {upgrade ? `Update to v${preview.version}` : `Install ${preview.name}`}
          </button>
        </div>
      </div>
    </section>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <dt>{label}</dt>
      <dd className="mt-0.5 break-all" style={{ color: 'var(--on-surface)', fontFamily: 'var(--font-mono)' }}>{value}</dd>
    </div>
  );
}
