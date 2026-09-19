'use client';

import { useRef, useState } from 'react';
import { AppDialog } from '@/components/overlay-primitives';
import { formatModuleFieldValue, getModuleRecordTitle, type ModuleCollection, type ModuleField, type ModuleRecord } from '@/lib/modules';
import type { ModuleBoardMove } from '@/lib/module-board';

export function ModuleBoardMoveDialog({ record, field, collection, manifestDigest, onMove, onClose }: {
  record: ModuleRecord; field: ModuleField; collection: ModuleCollection; manifestDigest: string;
  onMove: ModuleBoardMove; onClose: () => void;
}) {
  const original = record.data[field.key] === null || record.data[field.key] === undefined ? '' : String(record.data[field.key]);
  const [value, setValue] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const options = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options;
  const title = getModuleRecordTitle(record, collection);
  return <AppDialog open title={`Change ${field.label.toLowerCase()}`} description={title} width={460} onClose={() => { if (!busy) onClose(); }} footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    <button type="button" onClick={onClose} disabled={busy} className="min-h-10 rounded-full px-4 text-sm">Cancel</button>
    <button type="submit" form="module-board-move" disabled={busy || value === original || (field.required && value === '')} className="min-h-10 rounded-full px-4 text-sm font-medium text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>{busy ? 'Saving…' : 'Save change'}</button>
  </div>}>
    <form id="module-board-move" className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || value === original) return;
      setBusy(true); setError(null);
      try { await onMove(record, field, value, manifestDigest, key.current); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change this record.'); }
      finally { setBusy(false); }
    }}>
      <p className="text-sm" style={{ color: 'var(--on-surface-variant)' }}>Current {field.label.toLowerCase()}: {formatModuleFieldValue(record.data[field.key], field)}</p>
      <label className="block text-sm">New {field.label.toLowerCase()}<select aria-label={`New ${field.label.toLowerCase()}`} value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); key.current = crypto.randomUUID(); setError(null); }} className="mt-2 min-h-11 w-full rounded-lg border px-3" style={{ background: 'var(--surface-container-high)', borderColor: 'var(--ghost-border)' }}>
        {!field.required && <option value="">No value</option>}
        {field.required && !options.some((option) => option.value === original) && <option value="" disabled>Choose a value</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      {error && <div role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--danger-subtle)' }}>{error}</div>}
    </form>
  </AppDialog>;
}
