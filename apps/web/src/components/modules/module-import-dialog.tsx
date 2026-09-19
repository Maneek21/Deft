'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { refreshModuleCaches } from '@/hooks/use-modules';
import { parseModuleCsv, mapModuleImportRows } from '@/lib/module-import';
import { moduleApiError, moduleRecordHref, type ModuleCollection, type ModuleInstallation } from '@/lib/modules';

type Preview = { preview_digest: string; new_count: number; skipped_count: number; invalid_count: number;
  rows: { index: number; state: string; issues: string[]; matches: { id: string; label: string; archived: boolean }[] }[] };
type ImportInput = { collection_key: string; match_field: string; expected_manifest_digest: string | null; rows: Record<string, unknown>[] };

export function ModuleImportDialog({ installedModule, collection }: { installedModule: ModuleInstallation; collection: ModuleCollection }) {
  const [open, setOpen] = useState(false), [headers, setHeaders] = useState<string[]>([]), [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const fields = collection.fields.filter((field) => !['relation', 'resource_ref', 'member'].includes(field.type));
  const matchFields = fields.filter((field) => ['text', 'email', 'phone'].includes(field.type));
  const [matchField, setMatchField] = useState(matchFields.find((field) => field.type === 'email')?.key ?? matchFields[0]?.key ?? '');
  const [preview, setPreview] = useState<Preview | null>(null), [input, setInput] = useState<ImportInput | null>(null);
  const [intent, setIntent] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ results: { index: number; record_id: string; replayed: boolean }[]; skipped_count: number } | null>(null);
  const invalidate = () => { setPreview(null); setInput(null); setResult(null); setError(null); setIntent(crypto.randomUUID()); };
  if (!matchFields.length) return null;
  return <>
    <button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium transition-colors hover:bg-[var(--bg-active)]" style={{ background: 'var(--surface-container-high)' }} onClick={() => setOpen(true)}>Import CSV</button>
    <AppDialog open={open} onClose={() => { if (!busy) setOpen(false); }} width={900} title={`Import ${collection.name.toLowerCase()}`} footer={<button type="button" className="min-h-10 rounded-full px-4 text-sm" disabled={busy} onClick={() => setOpen(false)}>Close import</button>}>
      <div className="space-y-4">
        <p className="text-sm">Preview up to 100 rows. Existing matches, including archived records, are skipped; their data and relationships stay unchanged. Separate tags and multiple choices with semicolons. Link related records and assign owners after import.</p>
        <label className="block text-sm font-medium">CSV file<input type="file" accept=".csv,text/csv" disabled={busy} className="mt-2 block w-full text-sm" onChange={async (event) => {
          const file = event.target.files?.[0]; if (!file) return;
          invalidate(); setHeaders([]); setRows([]);
          try {
            if (file.size > 2_000_000) throw new Error('Choose a CSV file smaller than 2 MB.');
            const parsed = parseModuleCsv(await file.text()); setHeaders(parsed.headers); setRows(parsed.rows);
            setMapping(parsed.headers.map((header) => fields.find((field) => field.key.toLowerCase() === header.trim().toLowerCase() || field.label.toLowerCase() === header.trim().toLowerCase())?.key ?? ''));
          } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to read CSV.'); }
        }} /></label>
        {rows.length > 0 && <>
          <label className="block text-sm font-medium">Match duplicates using<select value={matchField} disabled={busy} onChange={(event) => { setMatchField(event.target.value); invalidate(); }} className="ml-3 min-h-11 rounded-lg p-2" style={{ background: 'var(--surface-container-high)' }}>
            {matchFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select></label>
          <p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Match values ignore case and surrounding spaces. Every row needs a match value. Edit cells to repair errors; use option names or values, and semicolons for multiple choices. Dates use YYYY-MM-DD; timestamps need a timezone.</p>
          <div className="max-h-[45vh] overflow-auto rounded-lg border border-[var(--ghost-border)]">
            <table className="w-full text-left text-xs"><thead><tr><th className="p-2">Row</th>{headers.map((header, index) => <th key={index} className="min-w-40 p-2"><span className="block">{header || `Column ${index + 1}`}</span><select disabled={busy} aria-label={`Map column ${index + 1}`} value={mapping[index] ?? ''} onChange={(event) => { setMapping((current) => current.map((value, col) => col === index ? event.target.value : value)); invalidate(); }} className="mt-2 min-h-11 w-full rounded p-2" style={{ background: 'var(--surface-container-high)' }}>
              <option value="">Ignore column</option>{fields.map((field) => <option key={field.key} value={field.key}>{field.label}{field.required ? ' *' : ''}</option>)}
            </select></th>)}</tr></thead><tbody>{rows.map((cells, rowIndex) => <tr key={rowIndex}><th className="p-2">{rowIndex + 1}</th>{cells.map((value, col) => <td key={col} className="p-1"><input disabled={busy} aria-label={`Row ${rowIndex + 1}, ${headers[col] || `column ${col + 1}`}`} value={value} className="min-h-11 w-full rounded p-2" style={{ background: 'var(--surface-container-low)' }} onChange={(event) => { setRows((current) => current.map((row, index) => index === rowIndex ? row.map((cell, column) => column === col ? event.target.value : cell) : row)); invalidate(); }} /></td>)}</tr>)}</tbody></table>
          </div>
          <button type="button" className="min-h-10 rounded-full px-4 font-medium transition-colors hover:bg-[var(--bg-active)]" disabled={busy} style={{ background: 'var(--surface-container-high)' }} onClick={async () => {
            setBusy(true); setError(null); setPreview(null); setResult(null);
            try {
              const next = { collection_key: collection.key, match_field: matchField, expected_manifest_digest: installedModule.manifestDigest, rows: mapModuleImportRows(collection, mapping, rows) };
              const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/import/preview`, next);
              if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to preview import.'));
              setPreview(await response.json()); setInput(next); if (!intent) setIntent(crypto.randomUUID());
            } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to preview import.'); } finally { setBusy(false); }
          }}>{busy ? 'Working…' : 'Preview import'}</button>
        </>}
        {error && <p role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{error}</p>}
        {preview && !result && <div className="space-y-3">
          <p role="status" className="font-medium">{preview.new_count} new · {preview.skipped_count} skipped · {preview.invalid_count} invalid</p>
          <ul className="max-h-48 overflow-auto space-y-2 text-xs">{preview.rows.map((row) => <li key={row.index}><strong>Row {row.index + 1}: {row.state.replaceAll('_', ' ')}</strong>{row.issues.map((issue) => <p key={issue}>{issue}</p>)}{row.matches.map((match) => <p key={match.id}>{match.archived ? `${match.label} (archived; skipped)` : <Link className="underline" href={moduleRecordHref(installedModule.slug, collection.key, match.id)}>{match.label}</Link>}</p>)}</li>)}</ul>
          <button type="button" className="min-h-10 rounded-full px-4 font-medium" style={{ background: 'var(--primary-container)', color: 'white' }} disabled={busy || preview.invalid_count > 0 || preview.new_count === 0} onClick={async () => {
            if (!input) return; setBusy(true); setError(null);
            try {
              const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/import/commit`, { ...input, expected_preview_digest: preview.preview_digest, idempotency_key: intent });
              if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to import records.'));
              setResult(await response.json()); await refreshModuleCaches(installedModule.slug);
            } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to import records.'); } finally { setBusy(false); }
          }}>Import {preview.new_count} new records; skip {preview.skipped_count} matches</button>
        </div>}
        {result && <div role="status" className="space-y-2 text-sm"><p>{result.results.length} imported · {result.skipped_count} skipped</p>{result.results.map((row) => <Link key={row.index} className="block underline" href={moduleRecordHref(installedModule.slug, collection.key, row.record_id)}>Open imported row {row.index + 1}</Link>)}</div>}
      </div>
    </AppDialog>
  </>;
}
