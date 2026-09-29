'use client';

import { useEffect, useRef, useState } from 'react';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { composerCompletion, composerFields, composerValidationError, composerRecoveryMode, createComposerSaver, mergeComposerDraft, type ComposerField, type ComposerInput, type ExperienceComposeRequest } from '@/lib/app-experience-action-composer';
import { createDraftRecoveryJournal, type DraftRecoveryScope } from '@/lib/app-experience-draft-recovery';

type Context = { label: string; input_schema: unknown; contract_digest: string; runtime_binding_id: string; app_version_id: string; grant_snapshot_id: string; expires_at: string };
type Run = { id: string; state: string; submitted_input?: ComposerInput };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function scalars(value: unknown): ComposerInput {
  if (!object(value) || Object.keys(value).length > 32 || Object.values(value).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) throw Error('Invalid saved data');
  return value as ComposerInput;
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) { await response.body?.cancel(); throw Error('Unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw Error('Unavailable');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 131072) throw Error('Response too large'); chunks.push(chunk.value); } }
  catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(value)) throw Error('Invalid response'); return value;
}

export function ExperienceActionComposer({ request, sessionId, draftScope, ensureAuthority, suspended = false, onClose, onResult }: {
  request: ExperienceComposeRequest; sessionId: string; ensureAuthority: () => Promise<boolean>;
  draftScope: Pick<DraftRecoveryScope, 'orgId' | 'userId' | 'installationId'>;
  suspended?: boolean;
  onClose: (unknown?: boolean) => void; onResult: (run: Run) => void;
}) {
  const [context, setContext] = useState<Context | null>(null), [fields, setFields] = useState<readonly ComposerField[]>([]);
  const [input, setInput] = useState<ComposerInput>({}), [notice, setNotice] = useState('Opening…');
  const [advancedKeys, setAdvancedKeys] = useState<readonly string[]>([]), [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [blocked, setBlocked] = useState(false), [hidden, setHidden] = useState(false);
  const [recovered, setRecovered] = useState<{baseRevision:number;value:ComposerInput} | null>(null), [localSaving, setLocalSaving] = useState(false), [savedRevision, setSavedRevision] = useState(0);
  const localPending = useRef(0), localFailed = useRef(false);
  const recovery = useRef<Awaited<ReturnType<typeof createDraftRecoveryJournal>> | null>(null), recoveryTail = useRef(Promise.resolve()), latestDraft = useRef<ComposerInput>({});
  const active = useRef(false), pending = useRef(new Set<AbortController>()), draft = useRef<ComposerInput>({}), saver = useRef<ReturnType<typeof createComposerSaver> | null>(null);
  const generation = useRef(0);
  const sending = useRef(false);
  const paused = useRef(suspended); paused.current = suspended;
  const reopen = useRef<(() => Promise<void>) | null>(null), wasSuspended = useRef(suspended);
  const authority = useRef(ensureAuthority);
  useEffect(() => { authority.current = ensureAuthority; }, [ensureAuthority]);
  const base = `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}`;
  async function call(path: string, body?: unknown, keepalive = false) {
    const capturedGeneration = generation.current;
    if (!active.current || paused.current || !(await authority.current())) throw Error('Access changed');
    if (!active.current || paused.current || capturedGeneration !== generation.current) throw Error('Access changed');
    const controller = new AbortController(); if (!keepalive) pending.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try { const response = await api.fetch(path, { signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), keepalive }); const value = await json(response);
      if (!active.current || paused.current || controller.signal.aborted || capturedGeneration !== generation.current || !(await authority.current())) throw Error('Access changed');
      if (!active.current || paused.current || capturedGeneration !== generation.current) throw Error('Access changed'); return value;
    } finally { clearTimeout(timeout); pending.current.delete(controller); }
  }
  useEffect(() => {
    active.current = true;
    const capturedGeneration = ++generation.current;
    const controllers = pending.current;
    const update = () => { const value = saver.current; setSaving(Boolean(value?.saving)); setDirty(Boolean(value?.dirty)); setBlocked(Boolean(value?.blocked) || localFailed.current); setSavedRevision(value?.revision || 0); };
    let unsubscribe: (() => void) | undefined;
    let opening = false, retryOpening = false;
    const load = async () => {
      if (opening) { retryOpening = true; return; }
      if (paused.current) return;
      opening = true;
      let failed = false;
      try {
        const contextValue = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/context`);
        if (contextValue.schema_version !== 'deft.experience_human_action_context.v1' || contextValue.action_key !== request.action_key || typeof contextValue.label !== 'string' || typeof contextValue.expires_at !== 'string' || !Number.isFinite(Date.parse(contextValue.expires_at)) || Date.parse(contextValue.expires_at) <= Date.now() || !['contract_digest','runtime_binding_id','app_version_id','grant_snapshot_id'].every(key => typeof contextValue[key] === 'string')) throw Error('Invalid action');
        const loadedFields = composerFields(contextValue.input_schema);
        const savedResponse = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, { operation: 'read', record_id: request.draft_id });
        const output = savedResponse.output; if (!object(output) || !object(output.item) || output.item.record_id !== request.draft_id || !Number.isSafeInteger(output.item.revision)) throw Error('Invalid saved draft');
        const saved = scalars(output.item.value); draft.current = saved;
        setSavedRevision(Number(output.item.revision));
        latestDraft.current = saved;
        const journal = await createDraftRecoveryJournal({...draftScope,stateKey:request.draft_state_key,recordId:request.draft_id});
        if (!active.current || generation.current !== capturedGeneration || !(await authority.current())) { journal.close(); throw Error('Access changed'); }
        recovery.current = journal; const restored = await journal.read();
        // Reconcile a committed Send even when its response never reached this
        // browser. This reads metadata only; it cannot authorize another action.
        const submission = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/submissions/${encodeURIComponent(request.draft_id)}`);
        if (!Object.hasOwn(submission, 'run')) throw Error('Invalid submission history');
        if (submission.run !== null) {
          if (!object(submission.run) || typeof submission.run.id !== 'string' || typeof submission.run.state !== 'string') throw Error('Invalid submission history');
          const known = { id: submission.run.id, state: submission.run.state };
          if (!active.current || generation.current !== capturedGeneration || !await authority.current()) return;
          await journal.put(Number(output.item.revision), restored?.value ?? saved, { key: request.draft_id, state: 'known', runId: known.id }).catch(() => undefined);
          if (active.current && generation.current === capturedGeneration) { onResult(known); onClose(); }
          return;
        }
        const recoveryMode = composerRecoveryMode(saved, Number(output.item.revision), restored);
        if (recoveryMode === 'submission') { setUncertain(true); setNotice('This draft was already submitted. Check its activity before sending again.'); }
        else if (recoveryMode === 'conflict') setRecovered(restored);
        else if (recoveryMode === 'none' && restored) await journal.clear();
        const initialDraft = recoveryMode === 'restore' ? restored!.value : saved;
        latestDraft.current = initialDraft;
        const value: ComposerInput = {};
        for (const field of loadedFields) value[field.key] = Object.hasOwn(initialDraft, field.key) ? initialDraft[field.key] : request.input?.[field.key] ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
        saver.current = createComposerSaver(Number(output.item.revision), async (revision, next) => {
          const result = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, { operation: 'put', record_id: request.draft_id, expected_revision: revision, value: next }, true);
          if (!object(result.output) || !object(result.output.item) || result.output.item.record_id !== request.draft_id || !Number.isSafeInteger(result.output.item.revision) || Number(result.output.item.revision) <= revision) throw Error('Unconfirmed save');
          draft.current = next; return Number(result.output.item.revision);
        });
        unsubscribe = saver.current.subscribe(update);
        if (recoveryMode === 'restore') saver.current.change(initialDraft);
        setAdvancedKeys(loadedFields.filter(field => field.readOnly || (!field.required && value[field.key] === '')).map(field => field.key));
        setFields(loadedFields); setInput(value); setContext(contextValue as unknown as Context); if (!restored?.submission) setNotice('');
      } catch { failed = true; if (active.current && generation.current === capturedGeneration) setNotice('This action or saved draft is unavailable. Reopen it after checking your access.'); }
      finally { opening = false; const retry = retryOpening; retryOpening = false;
        if (retry && failed && active.current && !paused.current && generation.current === capturedGeneration) void load(); }
    };
    reopen.current = load; void load();
    const hide = () => { setHidden(document.hidden); if (document.hidden) void saver.current?.flush(true); };
    const pageHide = () => { void saver.current?.flush(true); };
    const unload = (event: BeforeUnloadEvent) => { if (saver.current?.dirty || saver.current?.blocked || localPending.current > 0) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hide); addEventListener('pagehide', pageHide); addEventListener('beforeunload', unload);
    return () => { active.current = false; generation.current++; if (reopen.current === load) reopen.current = null; unsubscribe?.(); saver.current?.close(); saver.current = null; controllers.forEach(controller => controller.abort()); controllers.clear(); const journal = recovery.current; recovery.current = null; void recoveryTail.current.finally(() => journal?.close()); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', pageHide); removeEventListener('beforeunload', unload); };
    // A new captured session/request remounts this component; callbacks remain current through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, request.draft_id, request.action_key]);
  useEffect(() => {
    const returning = wasSuspended.current && !suspended; wasSuspended.current = suspended;
    if (!returning) return;
    if (!context) { void reopen.current?.(); return; }
    const capturedGeneration = generation.current;
    void (async () => {
      await recoveryTail.current; await saver.current?.flush();
      if (!active.current || paused.current || capturedGeneration !== generation.current || localFailed.current || uncertain) return;
      const current = saver.current;
      if (!current?.blocked) return;
      try {
        const saved = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, {operation:'read',record_id:request.draft_id});
        if (!object(saved.output) || !object(saved.output.item) || saved.output.item.record_id !== request.draft_id || !Number.isSafeInteger(saved.output.item.revision)) throw Error('Invalid saved draft');
        const value = scalars(saved.output.item.value), revision = Number(saved.output.item.revision);
        const local = {baseRevision:current.revision,value:latestDraft.current};
        const mode = composerRecoveryMode(value,revision,local);
        draft.current = value;
        if (mode === 'conflict') { setSavedRevision(revision); setRecovered(local); setNotice('This draft changed in another tab.'); }
        else if (current.resumeAfterRead(revision, mode === 'none')) setNotice('');
      } catch { /* Keep the encrypted recovery and existing save block. */ }
    })();
    // Authority is supplied through the ref; only a confirmed connection return resumes saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended]);
  function change(key: string, value: string | number | boolean) {
    if (paused.current || localFailed.current || recovered || uncertain) return;
    const next = { ...input, [key]: value }; setInput(next);
    try {
      const merged = mergeComposerDraft(draft.current, next), journal = recovery.current, capturedGeneration = generation.current;
      if (!journal) throw Error('Recovery unavailable'); latestDraft.current = merged; localPending.current++; setLocalSaving(true); setNotice('');
      recoveryTail.current = recoveryTail.current.then(async () => { if(localFailed.current)return; await journal.put(saver.current?.revision || 0, merged); if (active.current && capturedGeneration === generation.current) saver.current?.change(merged); }).catch(() => { localFailed.current=true; if(active.current && capturedGeneration === generation.current) { setBlocked(true); setNotice('Browser recovery could not be saved. Keep this draft open; no automatic overwrite or send will occur.'); } }).finally(() => { localPending.current--; if(active.current && capturedGeneration === generation.current) setLocalSaving(localPending.current>0); });
    }
    catch { setBlocked(true); setNotice('This draft exceeds its saved-data limit. Shorten it before sending.'); }
  }
  async function send() {
    if (!context || paused.current || busy || sending.current || uncertain || blocked || recovered || document.hidden) return;
    const invalid=composerValidationError(fields,input); if(invalid){setNotice(invalid);return;}
    sending.current=true;
    const current = composerCompletion(() => ({active:active.current,generation:generation.current}));
    setBusy(true); setNotice('');
    try {
      await recoveryTail.current; if (!current()) return;
      await saver.current?.flush(); if (!current()) return;
      if (saver.current?.dirty || saver.current?.blocked || localFailed.current) throw Error('Unconfirmed saved draft');
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65536) throw Error('Action input too large');
      const refreshed = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/context`);
      if (!current()) return;
      if (refreshed.schema_version !== 'deft.experience_human_action_context.v1' || refreshed.action_key !== request.action_key
        || !['contract_digest','runtime_binding_id','app_version_id','grant_snapshot_id'].every(key => refreshed[key] === context[key as keyof Context])
        || JSON.stringify(refreshed.input_schema) !== JSON.stringify(context.input_schema)
        || typeof refreshed.expires_at !== 'string' || !Number.isFinite(Date.parse(refreshed.expires_at)) || Date.parse(refreshed.expires_at) <= Date.now()) throw Error('Action changed');
      setContext(refreshed as unknown as Context);
      const prepared = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/prepare`, { input, idempotency_key: request.draft_id });
      if (!current()) return;
      if (prepared.schema_version !== 'deft.experience_human_action_ticket.v1' || typeof prepared.ticket !== 'string' || typeof prepared.input_digest !== 'string' || typeof prepared.expires_at !== 'string' || Date.parse(prepared.expires_at) <= Date.now()) throw Error('Invalid preparation');
      if (!recovery.current) throw Error('Recovery unavailable');
      await recovery.current.put(saver.current?.revision || 0, latestDraft.current, { key: request.draft_id, state: 'pending' });
      if (!current()) return; setUncertain(true);
      const confirmed = await call(`${base}/human-actions/confirm`, { ticket: prepared.ticket, expected_input_digest: prepared.input_digest });
      if (!current()) return;
      if (!object(confirmed.run) || typeof confirmed.run.id !== 'string' || typeof confirmed.run.state !== 'string') throw Error('Unconfirmed action');
      // The durable pending marker already prevents resend; a local CAS failure cannot erase a definitive Run response.
      await recovery.current.put(saver.current?.revision || 0, latestDraft.current, { key: request.draft_id, state: 'known', runId: confirmed.run.id }).catch(() => undefined);
      if (!current()) return;
      onResult({ id: confirmed.run.id, state: confirmed.run.state, submitted_input: { ...input } }); onClose();
    } catch { if (current()) setNotice('Sending could not be confirmed. Check the action history before trying again. Your saved draft remains available.'); }
    finally { sending.current=false; if (current()) setBusy(false); }
  }
  async function copyRecovered() {
    if (!recovered || uncertain || busy) return;
    setBusy(true);
    try {
      const copyId = crypto.randomUUID();
      const result = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, { operation:'put', record_id:copyId, expected_revision:0, value:recovered.value }, true);
      if (!object(result.output) || !object(result.output.item) || result.output.item.record_id !== copyId || result.output.item.revision !== 1) throw Error('Unconfirmed copy');
      await recovery.current?.clear(); setRecovered(null); setNotice('Recovered edits were saved as a separate draft. Close this form and open the new draft from your saved app data.');
    } catch { setNotice('The separate copy could not be confirmed. Browser recovery remains available; check saved app data before trying again.'); }
    finally { if(active.current)setBusy(false); }
  }
  async function discardRecovery() {
    if (busy || uncertain) return;
    try {
      await recovery.current?.clear();
      const value: ComposerInput = {};
      for (const field of fields) value[field.key] = draft.current[field.key] ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
      setInput(value); latestDraft.current = draft.current;
      saver.current?.resumeAfterRead(savedRevision, true); setRecovered(null); setNotice('');
    } catch { setNotice('This draft changed in another tab. Reopen it before choosing a version.'); }
  }
  function close() {
    if (busy) return;
    const current = composerCompletion(() => ({active:active.current,generation:generation.current}));
    if (!saver.current) { onClose(uncertain); return; }
    void recoveryTail.current.then(() => current() ? saver.current?.flush() : undefined).then(() => {
      if (!current()) return;
      if (!saver.current?.dirty && !saver.current?.blocked && !localFailed.current) onClose(uncertain);
      else setNotice('Save is unconfirmed. Keep this draft open or reload its saved copy.');
    });
  }
  if (hidden || suspended) return null;
  const advancedHasValue = fields.some(field => advancedKeys.includes(field.key) && !field.readOnly && input[field.key] !== '' && input[field.key] !== undefined);
  const fieldControl = (field: ComposerField) => <label key={field.key} className="block text-sm">
    <span className="block mb-1.5 font-medium">{field.label}</span>
    {field.readOnly ? <output className="block break-all text-[var(--on-surface-variant)]">{String(input[field.key] ?? '')}</output> : field.type === 'boolean' ? <input type="checkbox" checked={input[field.key] === true} disabled={busy || blocked || uncertain || Boolean(recovered)} onChange={event => change(field.key, event.target.checked)} />
      : field.type === 'string' && Number(field.maxLength) > 512 ? <textarea className="w-full min-h-48 sm:min-h-64 resize-y rounded-xl border border-[var(--outline-variant)] px-3 py-2.5 bg-[var(--surface)] leading-relaxed outline-none focus:border-[var(--primary)]" maxLength={field.maxLength} value={String(input[field.key] ?? '')} disabled={busy || blocked || uncertain || Boolean(recovered)} onChange={event => change(field.key, event.target.value)} />
        : <input className="w-full min-h-11 rounded-xl border border-[var(--outline-variant)] px-3 py-2.5 bg-[var(--surface)] outline-none focus:border-[var(--primary)]" type={field.type === 'number' ? 'number' : field.format === 'email' ? 'email' : 'text'} minLength={field.minLength} maxLength={field.maxLength} min={field.minimum} max={field.maximum} value={String(input[field.key] ?? '')} disabled={busy || blocked || uncertain || Boolean(recovered)} onChange={event => change(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)} />}
  </label>;
  return <AppDialog title={context?.label || 'Compose'} onClose={close} width={640} presentation="editor" footer={<div className="flex items-center justify-between gap-3">
    <p role="status" className="min-w-0 text-xs text-[var(--on-surface-variant)]">{notice || (!context ? 'Opening draft…' : blocked ? 'Draft needs attention' : saving || localSaving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved')}</p>
    <div className="flex shrink-0 gap-2"><button type="button" className="deft-pill px-4" style={{ minHeight: 44 }} disabled={busy} onClick={close}>Close</button>
      <button type="button" className="deft-pill deft-pill-active px-5" style={{ minHeight: 44 }} disabled={!context || busy || blocked || uncertain || Boolean(recovered)} onClick={() => { void send(); }}>{busy ? 'Sending…' : 'Send'}</button></div>
  </div>}>
    <div className="space-y-4">
      {recovered && <div role="status" className="text-sm"><p>This draft changed in another tab. Your edits are kept below.</p>
        <div className="space-y-2 my-3">{Object.entries(recovered.value).map(([key,value])=><label key={key} className="block"><span className="block capitalize">{key.replaceAll('_',' ')}</span><textarea readOnly className="w-full border rounded p-2 bg-transparent" value={String(value??'')} /></label>)}</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="min-h-11 px-3 border rounded-full" disabled={busy || uncertain} onClick={()=>{void copyRecovered();}}>Save edits as a copy</button>
          <button type="button" className="min-h-11 px-3 border rounded-full" disabled={busy || uncertain} onClick={() => { void discardRecovery(); }}>Use saved version</button>
        </div>
      </div>}
      {fields.filter(field => !advancedKeys.includes(field.key)).map(fieldControl)}
      {advancedKeys.length > 0 && <div className="space-y-4">
        {!advancedHasValue && <button type="button" className="min-h-11 text-sm text-[var(--on-surface-variant)]" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>{advancedOpen ? 'Hide details' : 'More details'}</button>}
        {(advancedOpen || advancedHasValue) && fields.filter(field => advancedKeys.includes(field.key)).map(fieldControl)}
      </div>}
      {blocked && <p className="text-sm text-[var(--on-surface-variant)]">The save could not be confirmed. Your edits are kept on this device; reopen the draft to check its saved version.</p>}
    </div>
  </AppDialog>;
}
