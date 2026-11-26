'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Download, Loader2, Lock, Save, X } from 'lucide-react';
import type { ModuleInstallation } from '@/lib/modules';

/** Pretty-printed active manifest, the text the editor starts from. */
export function appFileText(module: ModuleInstallation): string {
  return `${JSON.stringify(module.manifest.raw, null, 2)}\n`;
}

/** Suggested download name: `<slug>.app.json`. */
export function appFileName(module: ModuleInstallation): string {
  return `${module.slug}.app.json`;
}

/** The JSON Schema editors use to check an app file as you type. */
export const APP_FILE_SCHEMA_URL = 'https://deft.ing/schemas/deft.module.v1.schema.json';

/** The downloaded file: the active app file with a `$schema` line first. */
export function appFileDownloadText(module: ModuleInstallation): string {
  return `${JSON.stringify({ $schema: APP_FILE_SCHEMA_URL, ...module.manifest.raw }, null, 2)}\n`;
}

/** Saves the active manifest as a file in the browser. */
export function downloadAppFile(module: ModuleInstallation): void {
  const url = URL.createObjectURL(new Blob([appFileDownloadText(module)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = appFileName(module);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Why an installed app's file can't be edited here, or null when it can. */
export function appFileReadOnlyReason(module: ModuleInstallation): string | null {
  if (module.owningAppInstallationId) return 'This app is part of an App Kit package, so its file changes only with a new version of that package.';
  if (module.source !== 'sideloaded') return 'This app comes with Deft and updates with Deft. To change it, download its file, give it a new "id" and "slug", and upload it as your own app.';
  return null;
}

type CheckResult = { ok: true; version: string } | { ok: false; lines: string[] };

export function AppFileEditor({
  module,
  locked = false,
  onClose,
  onCheck,
  onSave,
}: {
  module: ModuleInstallation;
  /** True while another action on the page runs: Save waits. */
  locked?: boolean;
  onClose: () => void;
  onCheck: (source: string) => Promise<CheckResult>;
  /** Saves and resolves with the new version and the saved text, or throws readable text. */
  onSave: (source: string) => Promise<{ version: string; source?: string }>;
}) {
  const name = module.manifest.name || module.slug;
  const readOnlyReason = appFileReadOnlyReason(module);
  const [source, setSource] = useState(() => appFileText(module));
  const [result, setResult] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editorId = useId();
  const hintId = useId();
  const dirty = source !== appFileText(module);

  useEffect(() => { headingRef.current?.focus(); }, []);
  // After a save, start again from the new active file once it arrives.
  const savedRef = useRef(false);
  const digest = module.manifestDigest;
  useEffect(() => {
    if (!savedRef.current) return;
    savedRef.current = false;
    setSource(appFileText(module));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest]);

  const check = async () => {
    setBusy('check'); setResult(null);
    try {
      const checked = await onCheck(source);
      setResult(checked.ok
        ? { tone: 'success', text: `Looks good. Saving will update ${name} to v${checked.version}.` }
        : { tone: 'error', text: checked.lines.join('\n') });
    } finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save'); setResult(null);
    try {
      const { version, source: saved } = await onSave(source);
      savedRef.current = true;
      if (saved) setSource(saved);
      setResult({ tone: 'success', text: `Saved. ${name} is now v${version}, and every record was kept.` });
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error && error.message ? error.message : 'Unable to save this app.' });
    } finally { setBusy(null); }
  };

  return (
    <section aria-labelledby={`${editorId}-title`} className="rounded-xl p-4 md:p-5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary-container)' }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide" style={{ color: 'var(--primary)' }}>{readOnlyReason ? 'View app file' : 'Edit app file'}</p>
          <h2 id={`${editorId}-title`} ref={headingRef} tabIndex={-1} className="text-[0.9375rem] font-semibold outline-none" style={{ color: 'var(--on-surface)' }}>
            {name} <span className="font-normal" style={{ color: 'var(--on-surface-variant)' }}>v{module.manifest.version ?? '—'}</span>
          </h2>
        </div>
        <button type="button" onClick={onClose} disabled={busy !== null} aria-label={`Close the ${name} file`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg md:h-9 md:w-9" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
          <X size={15} aria-hidden />
        </button>
      </div>
      <p id={hintId} className="mt-2 flex items-start gap-2 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
        {readOnlyReason ? <><Lock size={13} aria-hidden className="mt-0.5 shrink-0" /> {readOnlyReason}</> : 'Change fields, options and views, then Check and Save. If you leave the version as it is, Save raises it for you. Changes that would break existing records are refused.'}
      </p>
      <label htmlFor={editorId} className="sr-only">{name} app file</label>
      <textarea
        id={editorId}
        value={source}
        onChange={(event) => { setSource(event.target.value); setResult(null); }}
        readOnly={Boolean(readOnlyReason)}
        aria-describedby={hintId}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={18}
        className="mt-3 block w-full resize-y rounded-lg border p-3 text-[0.75rem] leading-[1.55]"
        style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-container-high)', borderColor: 'var(--ghost-border)', color: 'var(--on-surface)', tabSize: 2 }}
      />
      {result && (
        <p role={result.tone === 'error' ? 'alert' : 'status'} className="mt-3 whitespace-pre-line rounded-lg px-3 py-2 text-[0.8125rem] leading-relaxed" style={{ background: result.tone === 'error' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.12)', color: result.tone === 'error' ? 'var(--error)' : 'var(--status-green)' }}>
          {result.text}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => downloadAppFile(module)} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium md:min-h-9" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}>
          <Download size={14} aria-hidden /> Download
        </button>
        {!readOnlyReason && (
          <div className="ml-auto flex flex-wrap gap-2">
            {dirty && <button type="button" onClick={() => { setSource(appFileText(module)); setResult(null); }} disabled={busy !== null} className="inline-flex min-h-11 items-center rounded-lg px-3 text-[0.8125rem] font-medium md:min-h-9" style={{ color: 'var(--on-surface-variant)' }}>Undo changes</button>}
            <button type="button" onClick={() => void check()} disabled={busy !== null} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium md:min-h-9" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}>
              {busy === 'check' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />} Check
            </button>
            <button type="button" onClick={() => void save()} disabled={busy !== null || locked || !dirty} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium text-white disabled:opacity-50 md:min-h-9" style={{ background: 'var(--primary-container)' }}>
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />} Save
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
