"use client";

import { useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { refreshModuleCaches } from '@/hooks/use-modules';
import { useAuth } from '@/lib/auth-context';
import { moduleSessionPostCacheKey, moduleSessionRequestPath } from '@/lib/module-session-cache';
import { formatModuleFieldValue, moduleApiError, moduleRecordHref, type ModuleCollection, type ModuleInstallation } from '@/lib/modules';

type Candidate = { id: string; label: string };
type Choice = 'source' | 'target';
type Preview = {
  source: Candidate; target: Candidate; preview_digest: string; ready: boolean;
  conflicts: Array<{ kind: 'field' | 'relation'; key: string; source: unknown; target: unknown; choice: Choice | null }>;
  merged_data: Record<string, unknown>; related_records: Candidate[];
  relations: Array<{ field_key: string; records: Array<Candidate & { archived: boolean }> }>;
  incoming_record_count: number; task_count: number;
};

export function ModuleMergeReview({ installedModule, collection, source, target, onBack, onBusy }: {
  installedModule: ModuleInstallation; collection: ModuleCollection; source: Candidate; target: Candidate;
  onBack: () => void; onBusy: (busy: boolean) => void;
}) {
  const { sessionCacheScope } = useAuth();
  const [fieldChoices, setFieldChoices] = useState<Record<string, Choice>>({});
  const [relationChoices, setRelationChoices] = useState<Record<string, Choice>>({});
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [done, setDone] = useState(false);
  const intent = useRef<{ digest: string; key: string } | null>(null);
  const input = { source_record_id: source.id, target_record_id: target.id, expected_manifest_digest: installedModule.manifestDigest, field_choices: fieldChoices, relation_choices: relationChoices };
  const previewPath = `/api/modules/${encodeURIComponent(installedModule.slug)}/merge/preview`;
  const preview = useSWR<Preview>(moduleSessionPostCacheKey(sessionCacheScope, done ? null : previewPath, input), async (key: string) => {
    const response = await api.post(moduleSessionRequestPath(key), input);
    if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to review this merge.'));
    return response.json();
  }, { revalidateOnFocus: false, shouldRetryOnError: false });
  const valueLabel = (key: string, value: unknown, relation = false) => {
    if (relation && Array.isArray(value)) return value.map((id) => preview.data?.related_records.find((record) => record.id === id)?.label ?? id).join(', ') || 'No link';
    const field = collection.fields.find((item) => item.key === key);
    return field ? formatModuleFieldValue(value, field) : JSON.stringify(value);
  };
  const commit = async () => {
    if (!confirmed || !preview.data?.ready || busy) return;
    const digest = preview.data.preview_digest;
    if (intent.current?.digest !== digest) intent.current = { digest, key: crypto.randomUUID() };
    setBusy(true); onBusy(true); setError(null);
    try {
      const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/merge/commit`, {
        ...input, expected_preview_digest: digest, idempotency_key: intent.current.key,
      });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to merge these records.'));
      setDone(true); await refreshModuleCaches(installedModule.slug);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to merge these records.'); }
    finally { setBusy(false); onBusy(false); }
  };
  if (done) return <div className="space-y-4"><p role="status">Merged into <Link className="underline" href={moduleRecordHref(installedModule.slug, collection.key, target.id)}>{target.label}</Link>.</p><p className="text-sm">The absorbed record is archived. Original values remain in merge history; restoring the archive does not undo transferred links.</p><button className="min-h-11 underline" onClick={onBack}>Back to duplicate review</button></div>;
  return <div className="space-y-4">
    <button className="min-h-11 text-sm underline" disabled={busy} onClick={onBack}>Back to duplicate review</button>
    <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-container-high)' }}><p>Keep <strong>{target.label}</strong> as the primary record.</p><p className="mt-2">Merge and archive <strong>{source.label}</strong>.</p></div>
    <p className="text-sm">Review every conflicting value. Missing fields are filled; activity, audience and task links are preserved on the primary record. Both original value sets remain in merge history.</p>
    {(error || preview.error) && <div role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{error ?? (preview.error instanceof Error ? preview.error.message : 'Unable to load merge.')} <button className="min-h-11 underline" disabled={busy} onClick={() => { setError(null); setConfirmed(false); void preview.mutate(); }}>Refresh merge review</button></div>}
    {preview.isLoading ? <p role="status">Reviewing records and linked work…</p> : preview.data && <>
      {preview.data.conflicts.map((conflict) => <fieldset key={`${conflict.kind}:${conflict.key}`} className="min-w-0 rounded-lg border border-[var(--ghost-border)] p-3" disabled={busy}>
        <legend className="px-1 text-sm font-semibold">{collection.fields.find((field) => field.key === conflict.key)?.label ?? conflict.key}</legend>
        {(['target', 'source'] as const).map((choice) => <label key={choice} className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="radio" className="mt-1" name={`${conflict.kind}:${conflict.key}`} checked={conflict.choice === choice} onChange={() => { setConfirmed(false); setError(null); if (conflict.kind === 'field') setFieldChoices((values) => ({ ...values, [conflict.key]: choice })); else setRelationChoices((values) => ({ ...values, [conflict.key]: choice })); }} /><span className="min-w-0 break-words"><strong>{choice === 'target' ? 'Primary' : 'Absorbed'}:</strong> {valueLabel(conflict.key, conflict[choice], conflict.kind === 'relation') || '(empty)'}</span></label>)}
      </fieldset>)}
      <details className="text-sm"><summary className="min-h-11 cursor-pointer">Review resulting field values</summary><dl className="space-y-2">{Object.entries(preview.data.merged_data).map(([key, value]) => <div key={key}><dt className="font-medium">{collection.fields.find((field) => field.key === key)?.label ?? key}</dt><dd className="whitespace-pre-wrap break-words">{valueLabel(key, value)}</dd></div>)}</dl></details>
      <ul className="space-y-2 text-sm">{preview.data.relations.filter((group) => group.records.length).map((group) => <li key={group.field_key}><strong>{collection.fields.find((field) => field.key === group.field_key)?.label ?? group.field_key}:</strong> {group.records.map((record) => `${record.label}${record.archived ? ' (archived)' : ''}`).join(', ')}</li>)}</ul>
      <p className="text-sm">{preview.data.incoming_record_count} linked records will be updated. {preview.data.task_count} distinct task links will be retained.</p>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || !preview.data.ready || preview.isValidating} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed the retained values and want to merge these records. The absorbed record will be archived.</span></label>
      <button type="button" className="min-h-11 rounded-lg px-4 text-sm font-medium" style={{ background: 'var(--primary-container)', color: 'white' }} disabled={busy || !confirmed || !preview.data.ready || preview.isValidating || Boolean(preview.error)} onClick={() => void commit()}>{busy ? 'Merging…' : 'Merge reviewed records'}</button>
    </>}
  </div>;
}
