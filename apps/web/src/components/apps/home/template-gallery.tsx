'use client';

import { useId, useState } from 'react';
import { ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { ModuleIcon } from '@/components/modules/module-primitives';

export type GalleryTemplate = { key: string; name: string; description: string; icon: string };

/**
 * Starters that install in the browser, with no file anywhere: pick one, name
 * it, choose whether to add sample records, install.
 */
export function TemplateGallery<T extends GalleryTemplate>({
  templates,
  busy,
  locked = false,
  onInstall,
}: {
  templates: readonly T[];
  busy: boolean;
  /** True while another action on the page runs, or the app list is loading. */
  locked?: boolean;
  /** Resolves true when the app is installed, which closes the form. */
  onInstall: (template: T, name: string, withSamples: boolean) => Promise<boolean> | void;
}) {
  const [chosen, setChosen] = useState<T | null>(null);
  const [name, setName] = useState('');
  const [withSamples, setWithSamples] = useState(true);
  const nameId = useId();
  if (templates.length === 0) return null;
  const choose = (template: T) => { setChosen(template); setName(template.name); setWithSamples(true); };
  const trimmed = name.trim();
  return (
    <section aria-labelledby="template-gallery-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="template-gallery-title" className="flex items-center gap-2 text-[0.8125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
          <Sparkles size={14} aria-hidden style={{ color: 'var(--primary)' }} /> Start from a template
        </h2>
        <p className="text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>Installs as your own app, so you can change it later.</p>
      </div>
      {chosen ? (
        <form
          className="rounded-xl p-4 md:p-5"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary-container)' }}
          onSubmit={(event) => { event.preventDefault(); if (!trimmed) return; void Promise.resolve(onInstall(chosen, trimmed, withSamples)).then((ok) => { if (ok) setChosen(null); }); }}
          aria-label={`Install the ${chosen.name} template`}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
              <ModuleIcon token={chosen.icon} size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide" style={{ color: 'var(--primary)' }}>Template</p>
              <h3 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{chosen.name}</h3>
              <p className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>{chosen.description}</p>
            </div>
            <button type="button" onClick={() => setChosen(null)} disabled={busy} aria-label="Choose a different template" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg md:h-9 md:w-9" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
              <X size={15} aria-hidden />
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:pl-[52px]">
            <label htmlFor={nameId} className="text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>
              Name
              <input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                autoFocus
                className="mt-1.5 block min-h-11 w-full rounded-lg border px-3 text-[0.875rem] font-normal md:min-h-10"
                style={{ background: 'var(--surface-container-high)', borderColor: 'var(--ghost-border)', color: 'var(--on-surface)' }}
              />
            </label>
            <label className="flex min-h-11 items-center gap-2.5 text-[0.8125rem]" style={{ color: 'var(--on-surface)' }}>
              <input type="checkbox" checked={withSamples} onChange={(event) => setWithSamples(event.target.checked)} className="h-4 w-4" />
              Add a few sample records so you can see how it works
            </label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setChosen(null)} disabled={busy} className="min-h-11 rounded-lg px-4 text-[0.8125rem] font-medium" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}>Cancel</button>
              <button type="submit" disabled={busy || locked || !trimmed} className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>
                {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Install {trimmed || chosen.name}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {templates.map((template) => (
            <li key={template.key}>
              <button
                type="button"
                onClick={() => choose(template)}
                disabled={busy || locked}
                className="group flex h-full w-full flex-col rounded-xl p-4 text-left disabled:opacity-60"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
                aria-label={`Use the ${template.name} template`}
              >
                <span className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
                    <ModuleIcon token={template.icon} size={16} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{template.name}</span>
                  <ArrowRight size={14} aria-hidden className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-2 line-clamp-2 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>{template.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
