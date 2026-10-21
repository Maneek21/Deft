'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ExperienceComposeRichEditor } from './experience-compose-controls-rich-editor';
import { ChevronDown } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { composerCompletion, composerFields, composerValidationError, composerRecoveryMode, createComposerSaver, mergeComposerDraft, type ComposerField, type ComposerInput, type ExperienceComposeRequest } from '@/lib/app-experience-action-composer';
import { createDraftRecoveryJournal, type DraftRecoveryScope } from '@/lib/app-experience-draft-recovery';
import { ExperienceComposeCapturedSummary, ExperienceComposeFilesControl, ExperienceComposeMailboxControl, ExperienceComposePlainEditor } from './experience-compose-controls';
import { composerFileDigest, composerFileSelectionError, composerInputDigest, composerSnapshotCurrent,
  parseComposerDraftPolicy, parseComposerPrivateFiles, parseComposerSnapshot, privateFilesForControls,
  type ComposerDraftPolicy, type ComposerFilesPolicy, type ComposerPrivateFile, type ComposerSnapshot } from '@/lib/app-experience-compose-files';
import { parseAddressList } from '../../../../../packages/app-kit/src/structured-address';

type Context = { label: string; input_schema: unknown; contract_digest: string; runtime_binding_id: string; app_version_id: string; grant_snapshot_id: string; expires_at: string; draft_policy?: ComposerDraftPolicy };
type LocalFile = { key: string; file: File; status: 'pending' | 'uploading' | 'failed'; notice?: string };
type Run = { id: string; state: string; submitted_input?: ComposerInput };
const isPlainEditor = (field: ComposerField) => field.type === 'string' && field.format !== 'mailbox_list' && field.format !== 'single_line' && field.format !== 'resource_record_list' && Number(field.maxLength) > 512 && !field.readOnly;
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
  draftScope: Pick<DraftRecoveryScope, 'orgId' | 'userId' | 'installationId' | 'resourceTargetKey'>;
  suspended?: boolean;
  onClose: (unknown?: boolean) => void; onResult: (run: Run) => void;
}) {
  const [context, setContext] = useState<Context | null>(null), [fields, setFields] = useState<readonly ComposerField[]>([]);
  const [input, setInput] = useState<ComposerInput>({}), [notice, setNotice] = useState('Opening…');
  const [revealedRecipients, setRevealedRecipients] = useState<readonly string[]>([]);
  const [collapsedRecipients, setCollapsedRecipients] = useState<readonly string[]>([]), [previewOpen, setPreviewOpen] = useState(false);
  const previewDisclosure = useRef<HTMLDivElement>(null), previewId = useId();
  const writingSurface = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null), writingFocused = useRef(false);
  const [advancedKeys, setAdvancedKeys] = useState<readonly string[]>([]), [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [blocked, setBlocked] = useState(false), [hidden, setHidden] = useState(false);
  const [recovered, setRecovered] = useState<{baseRevision:number;value:ComposerInput} | null>(null), [localSaving, setLocalSaving] = useState(false), [savedRevision, setSavedRevision] = useState(0);
  const localPending = useRef(0), localFailed = useRef(false);
  const [files, setFiles] = useState<readonly ComposerPrivateFile[]>([]), filesRef = useRef<readonly ComposerPrivateFile[]>([]);
  const [localFiles, setLocalFiles] = useState<readonly LocalFile[]>([]), localFilesRef = useRef<readonly LocalFile[]>([]);
  const [fileBusy, setFileBusy] = useState(false), fileBusyRef = useRef(false);
  const [filesUnavailable, setFilesUnavailable] = useState(false);
  const [snapshot, setSnapshot] = useState<ComposerSnapshot | null>(null), snapshotRef = useRef<ComposerSnapshot | null>(null);
  const [snapshotCycle, setSnapshotCycle] = useState(0);
  const snapshotEpoch = useRef(0), inputRef = useRef(input); inputRef.current = input;
  const recovery = useRef<Awaited<ReturnType<typeof createDraftRecoveryJournal>> | null>(null), recoveryTail = useRef(Promise.resolve()), latestDraft = useRef<ComposerInput>({});
  const active = useRef(false), pending = useRef(new Set<AbortController>()), draft = useRef<ComposerInput>({}), saver = useRef<ReturnType<typeof createComposerSaver> | null>(null);
  const generation = useRef(0);
  const sending = useRef(false);
  const paused = useRef(suspended); paused.current = suspended;
  const reopen = useRef<(() => Promise<void>) | null>(null), wasSuspended = useRef(suspended);
  const authority = useRef(ensureAuthority);
  useEffect(() => { authority.current = ensureAuthority; }, [ensureAuthority]);
  const base = `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}`;
  const filesPath = `${base}/state/${encodeURIComponent(request.draft_state_key)}/${encodeURIComponent(request.draft_id)}/files`;
  const draftRef = (revision: number) => ({ draft_state_key: request.draft_state_key, draft_id: request.draft_id, expected_revision: revision });
  function replaceFiles(value: readonly ComposerPrivateFile[]) { filesRef.current = value; setFiles(value); }
  function replaceLocalFiles(value: readonly LocalFile[]) { localFilesRef.current = value; setLocalFiles(value); }
  function invalidateSnapshot() { snapshotEpoch.current++; snapshotRef.current = null; setSnapshot(null); setPreviewOpen(false); }
  async function fetchValue(path: string, options: RequestInit = {}) {
    const capturedGeneration = generation.current;
    if (!active.current || paused.current || !(await authority.current())) throw Error('Access changed');
    if (!active.current || paused.current || capturedGeneration !== generation.current) throw Error('Access changed');
    const controller = new AbortController(); if (!options.keepalive) pending.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try { const response = await api.fetch(path, { ...options, signal: controller.signal }); const value = await json(response);
      if (!active.current || paused.current || controller.signal.aborted || capturedGeneration !== generation.current || !(await authority.current())) throw Error('Access changed');
      if (!active.current || paused.current || capturedGeneration !== generation.current) throw Error('Access changed'); return value;
    } finally { clearTimeout(timeout); pending.current.delete(controller); }
  }
  function call(path: string, body?: unknown, keepalive = false, method = 'POST') {
    return fetchValue(path, { ...(body === undefined ? {} : { method, body: JSON.stringify(body) }), keepalive });
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
        const policy = parseComposerDraftPolicy(contextValue.draft_policy, request.draft_state_key);
        const savedResponse = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, { operation: 'read', record_id: request.draft_id });
        const output = savedResponse.output; if (!object(output) || !object(output.item) || output.item.record_id !== request.draft_id || !Number.isSafeInteger(output.item.revision)) throw Error('Invalid saved draft');
        const saved = scalars(output.item.value); draft.current = saved;
        if (policy?.files) {
          const manifest = parseComposerPrivateFiles(await call(filesPath), request.draft_id, policy.files);
          if (manifest.draft.revision !== output.item.revision) throw Error('Draft changed');
          replaceFiles(manifest.files);
        }
        setFilesUnavailable(false);
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
        setAdvancedKeys(loadedFields.filter(field => !loadedFields.some(rich=>rich.format==='safe_html'&&rich.plainTextKey===field.key) && !(field.readOnly && field.format === 'resource_record_list') && field.format !== 'mailbox_list' && !isPlainEditor(field) && (field.readOnly && field.format !== 'email' || !field.required && value[field.key] === '')).map(field => field.key));
        setFields(loadedFields); setInput(value); inputRef.current = value;
        setContext({ ...contextValue, ...(policy ? { draft_policy: policy } : {}) } as unknown as Context); if (!restored?.submission) setNotice('');
      } catch { failed = true; if (active.current && generation.current === capturedGeneration) setNotice('This action or saved draft is unavailable. Reopen it after checking your access.'); }
      finally { opening = false; const retry = retryOpening; retryOpening = false;
        if (retry && failed && active.current && !paused.current && generation.current === capturedGeneration) void load(); }
    };
    reopen.current = load; void load();
    const hide = () => { setHidden(document.hidden); if (document.hidden) { invalidateSnapshot(); controllers.forEach(controller => controller.abort()); void saver.current?.flush(true); } };
    const pageHide = () => { controllers.forEach(controller => controller.abort()); void saver.current?.flush(true); };
    const unload = (event: BeforeUnloadEvent) => { if (saver.current?.dirty || saver.current?.blocked || localPending.current > 0 || fileBusyRef.current || localFilesRef.current.length) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hide); addEventListener('pagehide', pageHide); addEventListener('beforeunload', unload);
    return () => { active.current = false; generation.current++; if (reopen.current === load) reopen.current = null; unsubscribe?.(); saver.current?.close(); saver.current = null; controllers.forEach(controller => controller.abort()); controllers.clear(); const journal = recovery.current; recovery.current = null; void recoveryTail.current.finally(() => journal?.close()); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', pageHide); removeEventListener('beforeunload', unload); };
    // A new captured session/request remounts this component; callbacks remain current through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, request.draft_id, request.draft_state_key, request.action_key]);
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
        if (context.draft_policy?.files) {
          const manifest = parseComposerPrivateFiles(await call(filesPath), request.draft_id, context.draft_policy.files);
          if (manifest.draft.revision !== revision) throw Error('Draft changed');
          replaceFiles(manifest.files); setFilesUnavailable(false);
        }
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
  useEffect(() => {
    invalidateSnapshot();
    if (!context?.draft_policy?.max_payload_bytes || !saver.current || busy || fileBusy || filesUnavailable || localFiles.length
      || blocked || dirty || saving || localSaving || uncertain || recovered || suspended || hidden || document.hidden || composerValidationError(fields, input)) return;
    const capturedGeneration = generation.current, epoch = snapshotEpoch.current, revision = saver.current.revision;
    const capturedInput = { ...input }, capturedFiles = files;
    let retired = false, expiryTimer: ReturnType<typeof setTimeout> | undefined;
    // Capture after the save lane settles; typing never invokes human Send.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const inputDigest = await composerInputDigest(capturedInput);
          const value = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/snapshot`, { input: capturedInput, draft_ref: draftRef(revision) });
          const captured = parseComposerSnapshot(value, draftRef(revision), capturedInput, inputDigest, capturedFiles, context.draft_policy?.files);
          if (retired || !active.current || capturedGeneration !== generation.current || epoch !== snapshotEpoch.current || saver.current?.dirty || saver.current?.blocked
            || !composerSnapshotCurrent(captured, draftRef(saver.current?.revision ?? 0), inputRef.current, filesRef.current)) return;
          snapshotRef.current = captured; setSnapshot(captured);
          setNotice('');
          expiryTimer = setTimeout(() => { if (!retired) { invalidateSnapshot(); setSnapshotCycle(value => value + 1); } }, Math.max(1, Date.parse(captured.expires_at) - Date.now()));
        } catch { if (!retired && active.current && epoch === snapshotEpoch.current) setNotice('The saved send preview could not be verified. Edit or reopen the draft to try again.'); }
      })();
    }, 400);
    return () => { retired = true; clearTimeout(timer); if (expiryTimer) clearTimeout(expiryTimer); };
    // Session/generation and the listed draft state retire every captured preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, input, files, savedRevision, busy, fileBusy, filesUnavailable, localFiles.length, blocked, dirty, saving, localSaving, uncertain, recovered, suspended, hidden, fields, snapshotCycle]);
  function change(key: string, value: string | number | boolean) {
    if (!fields.some(field=>field.key===key&&!field.readOnly)) return;
    changeValues({[key]:value});
  }
  function changeValues(values: ComposerInput) {
    if (Object.keys(values).some(key => !fields.some(field => field.key === key && (!field.readOnly || fields.some(rich => rich.format === 'safe_html' && rich.plainTextKey === key && Object.hasOwn(values,rich.key)))) ) || paused.current || localFailed.current || recovered || uncertain || sending.current || fileBusyRef.current) return;
    invalidateSnapshot();
    const next = { ...inputRef.current, ...values }; setInput(next); inputRef.current = next;
    try {
      const merged = mergeComposerDraft(draft.current, next), journal = recovery.current, capturedGeneration = generation.current;
      if (!journal) throw Error('Recovery unavailable'); latestDraft.current = merged; localPending.current++; setLocalSaving(true); setNotice('');
      recoveryTail.current = recoveryTail.current.then(async () => { if(localFailed.current)return; await journal.put(saver.current?.revision || 0, merged); if (active.current && capturedGeneration === generation.current) saver.current?.change(merged); }).catch(() => { localFailed.current=true; if(active.current && capturedGeneration === generation.current) { setBlocked(true); setNotice('Browser recovery could not be saved. Keep this draft open; no automatic overwrite or send will occur.'); } }).finally(() => { localPending.current--; if(active.current && capturedGeneration === generation.current) setLocalSaving(localPending.current>0); });
    }
    catch { setBlocked(true); setNotice('This draft exceeds its saved-data limit. Shorten it before sending.'); }
  }
  async function reconcileFiles(policy: ComposerFilesPolicy) {
    const manifest = parseComposerPrivateFiles(await call(filesPath), request.draft_id, policy);
    const saved = await call(`${base}/state/${encodeURIComponent(request.draft_state_key)}`, { operation: 'read', record_id: request.draft_id });
    if (!object(saved.output) || !object(saved.output.item) || saved.output.item.record_id !== request.draft_id || saved.output.item.revision !== manifest.draft.revision || !saver.current) throw Error('Draft changed');
    const value = scalars(saved.output.item.value), local = { baseRevision: saver.current.revision, value: latestDraft.current };
    const mode = composerRecoveryMode(value, manifest.draft.revision, local);
    draft.current = value; replaceFiles(manifest.files);
    if (mode === 'conflict') { setSavedRevision(manifest.draft.revision); setRecovered(local); throw Error('Draft conflict'); }
    if (!saver.current.resumeAfterRead(manifest.draft.revision, mode === 'none')) throw Error('Draft busy');
    setFilesUnavailable(false); return manifest;
  }
  async function uploadFile(operationId: string, file: File) {
    const policy = context?.draft_policy?.files;
    if (!policy || !context?.draft_policy?.max_payload_bytes || fileBusyRef.current || sending.current || uncertain || recovered || paused.current || document.hidden) return;
    fileBusyRef.current = true; setFileBusy(true); invalidateSnapshot();
    const current = composerCompletion(() => ({ active: active.current, generation: generation.current }));
    let digest: string | undefined;
    try {
      const error = composerFileSelectionError(file, filesRef.current, policy); if (error) throw Error(error);
      replaceLocalFiles(localFilesRef.current.map(row => row.key === operationId ? { ...row, status: 'uploading', notice: undefined } : row));
      await recoveryTail.current; if (!current()) return;
      if (!saver.current || localFailed.current) throw Error('Recovery unavailable');
      if (saver.current.blocked) await reconcileFiles(policy);
      digest = await composerFileDigest(file); if (!current()) return;
      const manifest = await saver.current.mutate(async revision => {
        const query = new URLSearchParams({ expected_revision: String(revision), upload_operation_id: operationId, filename: file.name });
        const result = parseComposerPrivateFiles(await fetchValue(`${filesPath}?${query}`, { method: 'POST', body: file,
          headers: { 'Content-Type': file.type } }), request.draft_id, policy);
        const uploaded = result.files.find(row => row.upload_operation_id === operationId);
        if (!uploaded || uploaded.digest !== digest || uploaded.filename !== file.name || uploaded.media_type !== file.type || uploaded.byte_length !== file.size) throw Error('Unconfirmed file');
        return { revision: result.draft.revision, value: result };
      });
      if (!current()) return;
      replaceFiles(manifest.files); replaceLocalFiles(localFilesRef.current.filter(row => row.key !== operationId)); setFilesUnavailable(false); setNotice('');
    } catch {
      if (!current()) return;
      let committed = false;
      if (digest && !paused.current && !document.hidden) {
        try {
          const manifest = await reconcileFiles(policy);
          const uploaded = manifest.files.find(row => row.upload_operation_id === operationId);
          committed = Boolean(uploaded && uploaded.digest === digest && uploaded.filename === file.name && uploaded.media_type === file.type && uploaded.byte_length === file.size);
        } catch { setFilesUnavailable(true); }
      }
      if (!current()) return;
      if (committed) { replaceLocalFiles(localFilesRef.current.filter(row => row.key !== operationId)); setNotice(''); }
      else { replaceLocalFiles(localFilesRef.current.map(row => row.key === operationId ? { ...row, status: 'failed', notice: 'Upload unconfirmed. Your selection is kept; retry or remove it.' } : row)); setNotice('The file is not ready. Verify the saved draft before sending.'); }
    } finally { fileBusyRef.current = false; if (current()) setFileBusy(false); }
  }
  async function selectFiles(selected: readonly File[]) {
    if (fileBusyRef.current || sending.current || blocked || filesUnavailable || uncertain || recovered || localFilesRef.current.length || !context?.draft_policy?.files) return;
    const rows = selected.map(file => ({ key: crypto.randomUUID(), file, status: 'pending' as const }));
    replaceLocalFiles(rows); invalidateSnapshot();
    for (const row of rows) {
      if (!active.current || paused.current || document.hidden) return;
      await uploadFile(row.key, row.file);
      if (localFilesRef.current.some(file => file.key === row.key)) break;
    }
  }
  async function removeFile(fileId: string) {
    if (fileBusyRef.current || sending.current || uncertain || recovered || paused.current || document.hidden) return;
    if (localFilesRef.current.some(row => row.key === fileId)) { replaceLocalFiles(localFilesRef.current.filter(row => row.key !== fileId)); invalidateSnapshot(); return; }
    const policy = context?.draft_policy?.files; if (!policy || !saver.current) return;
    fileBusyRef.current = true; setFileBusy(true); invalidateSnapshot();
    const current = composerCompletion(() => ({ active: active.current, generation: generation.current }));
    try {
      await recoveryTail.current; if (!current()) return;
      if (saver.current.blocked) await reconcileFiles(policy);
      const manifest = await saver.current.mutate(async revision => {
        const result = parseComposerPrivateFiles(await call(`${filesPath}/${encodeURIComponent(fileId)}`, { expected_revision: revision }, false, 'DELETE'), request.draft_id, policy);
        if (result.files.some(row => row.file_id === fileId)) throw Error('Unconfirmed removal');
        return { revision: result.draft.revision, value: result };
      });
      if (current()) { replaceFiles(manifest.files); setFilesUnavailable(false); setNotice(''); }
    } catch {
      if (!current()) return;
      try { const manifest = await reconcileFiles(policy); if (manifest.files.some(row => row.file_id === fileId)) throw Error('Removal unconfirmed'); setNotice(''); }
      catch { if (current()) { setFilesUnavailable(true); setNotice('File removal could not be confirmed. Reopen the saved draft before sending.'); } }
    } finally { fileBusyRef.current = false; if (current()) setFileBusy(false); }
  }
  async function send() {
    if (!context || paused.current || busy || sending.current || uncertain || blocked || recovered || document.hidden || fileBusyRef.current || filesUnavailable || localFilesRef.current.length) return;
    const capturedSnapshot = snapshotRef.current;
    if (context.draft_policy?.max_payload_bytes && !composerSnapshotCurrent(capturedSnapshot, draftRef(saver.current?.revision ?? 0), input, filesRef.current)) return;
    const invalid=composerValidationError(fields,input); if(invalid){setNotice(invalid);return;}
    sending.current=true;
    const current = composerCompletion(() => ({active:active.current,generation:generation.current}));
    setBusy(true); setNotice('');
    try {
      await recoveryTail.current; if (!current()) return;
      await saver.current?.flush(); if (!current()) return;
      if (saver.current?.dirty || saver.current?.blocked || localFailed.current) throw Error('Unconfirmed saved draft');
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65536) throw Error('Action input too large');
      if (context.draft_policy?.max_payload_bytes && (!composerSnapshotCurrent(capturedSnapshot, draftRef(saver.current?.revision ?? 0), inputRef.current, filesRef.current)
        || capturedSnapshot?.input_digest !== await composerInputDigest(inputRef.current))) throw Error('Saved preview changed');
      const refreshed = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/context`);
      if (!current()) return;
      if (refreshed.schema_version !== 'deft.experience_human_action_context.v1' || refreshed.action_key !== request.action_key
        || !['contract_digest','runtime_binding_id','app_version_id','grant_snapshot_id'].every(key => refreshed[key] === context[key as keyof Context])
        || JSON.stringify(refreshed.input_schema) !== JSON.stringify(context.input_schema)
        || JSON.stringify(parseComposerDraftPolicy(refreshed.draft_policy, request.draft_state_key)) !== JSON.stringify(context.draft_policy ?? null)
        || typeof refreshed.expires_at !== 'string' || !Number.isFinite(Date.parse(refreshed.expires_at)) || Date.parse(refreshed.expires_at) <= Date.now()) throw Error('Action changed');
      setContext({ ...refreshed, ...(context.draft_policy ? { draft_policy: parseComposerDraftPolicy(refreshed.draft_policy, request.draft_state_key) } : {}) } as unknown as Context);
      const prepared = await call(`${base}/human-actions/${encodeURIComponent(request.action_key)}/prepare`, {
        input, idempotency_key: request.draft_id,
        draft_ref: { draft_state_key: request.draft_state_key, draft_id: request.draft_id, expected_revision: saver.current?.revision },
        ...(capturedSnapshot ? { snapshot_ref: capturedSnapshot.snapshot_ref } : {}),
      });
      if (!current()) return;
      if (prepared.schema_version !== 'deft.experience_human_action_ticket.v1' || typeof prepared.ticket !== 'string' || typeof prepared.input_digest !== 'string' || typeof prepared.expires_at !== 'string' || Date.parse(prepared.expires_at) <= Date.now()) throw Error('Invalid preparation');
      if (capturedSnapshot && (prepared.input_digest !== capturedSnapshot.input_digest || !object(prepared.snapshot_ref)
        || prepared.snapshot_ref.snapshot_id !== capturedSnapshot.snapshot_ref.snapshot_id || prepared.snapshot_ref.digest !== capturedSnapshot.snapshot_ref.digest
        || Object.keys(prepared.snapshot_ref).length !== 2)) throw Error('Preparation changed');
      if (!recovery.current) throw Error('Recovery unavailable');
      await recovery.current.put(saver.current?.revision || 0, latestDraft.current, { key: request.draft_id, state: 'pending' });
      if (!current()) return; setUncertain(true);
      const confirmed = await call(`${base}/human-actions/confirm`, { ticket: prepared.ticket, expected_input_digest: prepared.input_digest,
        ...(capturedSnapshot ? { expected_snapshot_digest: capturedSnapshot.snapshot_ref.digest } : {}) });
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
      await recovery.current?.clear(); setRecovered(null); setNotice(`Recovered edits were saved as a separate draft. Close this form and open the new draft from your saved app data.${context?.draft_policy?.files ? ' Files remain with the original draft; select them again for the copy.' : ''}`);
    } catch { setNotice('The separate copy could not be confirmed. Browser recovery remains available; check saved app data before trying again.'); }
    finally { if(active.current)setBusy(false); }
  }
  async function discardRecovery() {
    if (busy || uncertain) return;
    try {
      await recovery.current?.clear();
      const value: ComposerInput = {};
      for (const field of fields) value[field.key] = draft.current[field.key] ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
      setInput(value); inputRef.current = value; latestDraft.current = draft.current; invalidateSnapshot();
      saver.current?.resumeAfterRead(savedRevision, true); setRecovered(null); setNotice('');
    } catch { setNotice('This draft changed in another tab. Reopen it before choosing a version.'); }
  }
  function close() {
    if (busy || fileBusyRef.current) return;
    if (localFilesRef.current.length) { setNotice('Remove unconfirmed file selections before closing. Your saved files remain with the draft.'); return; }
    const current = composerCompletion(() => ({active:active.current,generation:generation.current}));
    if (!saver.current) { onClose(uncertain); return; }
    void recoveryTail.current.then(() => current() ? saver.current?.flush() : undefined).then(() => {
      if (!current()) return;
      if (!saver.current?.dirty && !saver.current?.blocked && !localFailed.current) onClose(uncertain);
      else setNotice('Save is unconfirmed. Keep this draft open or reload its saved copy.');
    });
  }
  useEffect(() => {
    if (!context || hidden || suspended || writingFocused.current) return;
    const frame = requestAnimationFrame(() => {
      const controls = Array.from(writingSurface.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-compose-writing-control="true"]:not(:disabled)') ?? []);
      if (!controls.length) return;
      writingFocused.current = true;
      // The async draft load can replace the opening state. Focus the first
      // empty writing field, while respecting a user's deliberate focus move.
      if (document.activeElement === closeButton.current || document.activeElement === document.body) {
        (controls.find(control => !control.value.trim() && control.dataset.composeHasValue !== 'true') ?? controls[0]).focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [context, hidden, suspended]);
  useEffect(() => {
    if (!previewOpen) return;
    const dismiss = (event: PointerEvent) => { if (!previewDisclosure.current?.contains(event.target as Node)) setPreviewOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [previewOpen]);
  if (hidden || suspended) return null;
  const snapshotReady = composerSnapshotCurrent(snapshot, draftRef(savedRevision), input, files);
  const fileControls = [...privateFilesForControls(files, { draftId: request.draft_id, revision: savedRevision, resourceTargetKey: draftScope.resourceTargetKey ?? 'primary' }),
    ...localFiles.map(row => ({ key: row.key, filename: row.file.name, byteCount: row.file.size, status: row.status, notice: row.notice }))];
  const advancedHasValue = fields.some(field => advancedKeys.includes(field.key) && !field.readOnly && input[field.key] !== '' && input[field.key] !== undefined);
  const disabled = busy || fileBusy || blocked || uncertain || Boolean(recovered);
  const recipientFields = fields.filter(field => field.format === 'mailbox_list' && !field.readOnly);
  const optionalRecipients = recipientFields.filter(field => (field.minLength ?? 0) === 0);
  const hiddenRecipients = optionalRecipients.filter(field => collapsedRecipients.includes(field.key) || !String(input[field.key] ?? '').trim() && !revealedRecipients.includes(field.key));
  const visibleFields = fields.filter(field => !fields.some(rich => rich.format === 'safe_html' && rich.plainTextKey === field.key) && !advancedKeys.includes(field.key) && !hiddenRecipients.includes(field));
  const fieldControl = (field: ComposerField) => field.format === 'safe_html' && !field.readOnly
    ? <ExperienceComposeRichEditor key={field.key} label={field.label} value={{html:String(input[field.key]??''),plainText:String(input[field.plainTextKey!]??'')}}
      maxCharacters={field.maxLength??16384} maxPlainCharacters={fields.find(item=>item.key===field.plainTextKey)?.maxLength??16384}
      disabled={disabled} onChange={value=>changeValues({[field.key]:value.html,[field.plainTextKey!]:value.plainText})}/>
    : field.format === 'resource_record_list' && field.readOnly ? null : isPlainEditor(field)
    ? <ExperienceComposePlainEditor key={field.key} label={field.label} value={{ format: 'plain', text: String(input[field.key] ?? '') }}
      maxBytes={4 * (field.maxLength ?? 16384)} maxCharacters={field.maxLength}
      disabled={disabled} onChange={value => change(field.key, value.text)} />
    : field.format === 'mailbox_list' && !field.readOnly
      ? <div key={field.key} id={`compose-field-${field.key}`}><ExperienceComposeMailboxControl label={field.label} value={String(input[field.key] ?? '')} maxItems={field.maxItems} maxLength={field.maxLength}
        disabled={disabled} onChange={value => {
          setRevealedRecipients(keys => keys.includes(field.key) ? keys : [...keys, field.key]);
          change(field.key, value);
        }} /></div>
      : <label key={field.key} className="flex min-w-0 items-center gap-3 text-sm">
        <span className="w-14 shrink-0 py-3.5 text-xs text-[var(--on-surface-variant)]">{field.label}</span>
        {field.readOnly ? <output className="min-w-0 break-all py-3 text-sm text-[var(--on-surface-variant)]">{String(input[field.key] ?? '')}</output>
          : field.type === 'boolean' ? <input type="checkbox" checked={input[field.key] === true} disabled={disabled} onChange={event => change(field.key, event.target.checked)} />
          : <input data-compose-writing-control="true" className="min-h-11 w-full min-w-0 rounded-lg bg-transparent px-1 py-2.5 text-[0.9375rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-60"
            type={field.type === 'number' ? 'number' : field.format === 'email' ? 'email' : 'text'} minLength={field.minLength} maxLength={field.maxLength} min={field.minimum} max={field.maximum}
            value={String(input[field.key] ?? '')} disabled={disabled} onChange={event => change(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)} />}
      </label>;
  const status = notice || (!context ? 'Opening draft…' : fileBusy ? 'Saving file…' : blocked || filesUnavailable ? 'Draft needs attention' : saving || localSaving ? 'Saving…' : dirty ? 'Unsaved changes' : composerValidationError(fields, input) || (context.draft_policy?.max_payload_bytes && !snapshotReady ? 'Preparing saved preview…' : 'Saved'));
  const firstPreview = snapshotReady ? snapshot?.preview.items[0] : undefined;
  return <AppDialog title={context?.label || 'Compose'} onClose={close} width={660} presentation="editor" initialFocusRef={closeButton} headerActions={<>
    {context?.draft_policy?.max_payload_bytes && <div ref={previewDisclosure} className="static sm:relative" onKeyDownCapture={event => {
      if (event.key === 'Escape' && previewOpen) { event.preventDefault(); event.stopPropagation(); setPreviewOpen(false); }
    }}>
      <button type="button" className="flex min-h-11 items-center gap-1 rounded-full px-2 text-xs text-[var(--on-surface-variant)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50"
        disabled={!firstPreview} aria-expanded={Boolean(firstPreview && previewOpen)} aria-controls={previewId} title={firstPreview ? `Review ${firstPreview.label}` : 'Checking saved preview…'}
        onClick={() => setPreviewOpen(value => !value)}>{firstPreview?.label ?? 'Preview'}<ChevronDown size={12} aria-hidden="true" /></button>
      {firstPreview && previewOpen && <div id={previewId} className="absolute right-0 top-full z-20 w-64 max-w-[calc(100vw-2.5rem)] rounded-xl bg-[var(--surface-container-high)] p-3 shadow-lg">
        <p className="text-xs text-[var(--on-surface-variant)]">{firstPreview.label} · Saved version {snapshot?.draft_ref.expected_revision}</p>
        <p className="mt-1 break-words text-sm">{firstPreview.value || 'None'}</p>
      </div>}
    </div>}
    {optionalRecipients.map(field => {
      const expanded = !hiddenRecipients.includes(field), value = String(input[field.key] ?? '');
      let count: number | null = 0;
      try { count = parseAddressList(value, { maxItems: field.maxItems, allowEmpty: true }).length; } catch { count = null; }
      const presence = count === null ? ' · !' : count > 0 ? ` · ${count}` : '';
      return <button key={field.key} type="button" className={`min-h-11 rounded-full px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${expanded ? 'text-[var(--primary)]' : 'text-[var(--on-surface-variant)]'}`}
        disabled={busy || fileBusy} aria-expanded={expanded} aria-controls={`compose-field-${field.key}`} aria-label={`${expanded ? 'Hide' : 'Show'} ${field.label}${count === null ? ', recipient input needs review' : count > 0 ? `, ${count} ${count === 1 ? 'recipient' : 'recipients'} retained` : ''}`}
        onClick={() => {
          if (expanded) setCollapsedRecipients(keys => [...keys, field.key]);
          else {
            setCollapsedRecipients(keys => keys.filter(key => key !== field.key));
            setRevealedRecipients(keys => keys.includes(field.key) ? keys : [...keys, field.key]);
            requestAnimationFrame(() => document.getElementById(`compose-field-${field.key}`)?.querySelector<HTMLInputElement>('input')?.focus());
          }
        }}>{field.label}{presence}</button>;
    })}
  </>} footer={<div className="flex min-h-11 items-center gap-3">
      <button type="button" className="deft-pill deft-pill-active min-h-11 px-6 text-sm" disabled={!context || busy || fileBusy || blocked || filesUnavailable || Boolean(localFiles.length) || uncertain || Boolean(recovered) || Boolean(context?.draft_policy?.max_payload_bytes && (!snapshotReady || saving || dirty || localSaving))} onClick={() => { void send(); }}>{busy ? 'Sending…' : 'Send'}</button>
      <p role="status" className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${notice || blocked || filesUnavailable ? 'text-[var(--error)]' : 'text-[var(--on-surface-variant)]'}`}>{status}</p>
      <button ref={closeButton} type="button" className="min-h-11 rounded-lg px-3 text-sm text-[var(--on-surface-variant)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] hover:bg-[var(--surface-container-high)]" disabled={busy || fileBusy} onClick={close}>Close</button>
  </div>}>
    <div ref={writingSurface} className="flex min-h-full min-w-0 flex-col">
      {recovered && <div role="status" className="mb-4 space-y-3 border-l-2 border-[var(--error)] pl-3 text-sm"><p>This draft changed in another tab. Your edits are kept below.</p>
        <div className="space-y-2">{Object.entries(recovered.value).map(([key,value])=><label key={key} className="block"><span className="block text-xs text-[var(--on-surface-variant)]">{fields.find(field => field.key === key)?.label ?? key.replaceAll('_',' ')}</span><textarea readOnly className="min-h-20 w-full rounded-lg border border-[var(--outline-variant)] bg-transparent p-2" value={String(value??'')} /></label>)}</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="deft-pill min-h-11 px-3" disabled={busy || uncertain} onClick={()=>{void copyRecovered();}}>Save edits as a copy</button>
          <button type="button" className="deft-pill min-h-11 px-3" disabled={busy || uncertain} onClick={() => { void discardRecovery(); }}>Use saved version</button>
        </div>
      </div>}
      <div className="min-w-0">
        {visibleFields.filter(field => field.format === 'mailbox_list' && !field.readOnly).map(fieldControl)}
        {visibleFields.filter(field => !isPlainEditor(field) && !(field.format === 'mailbox_list' && !field.readOnly)).map(fieldControl)}
      </div>
      {visibleFields.filter(isPlainEditor).map(fieldControl)}
      {context?.draft_policy?.files && <ExperienceComposeFilesControl label="Attachments" files={fileControls}
        acceptedMediaTypes={context.draft_policy.files.allowed_media_types}
        onSelectFiles={context.draft_policy.max_payload_bytes ? selected => { void selectFiles(selected); } : undefined}
        onRemove={key => { void removeFile(key); }} onRetry={key => { const selected = localFilesRef.current.find(row => row.key === key); if (selected) void uploadFile(key, selected.file); }}
        disabled={busy || fileBusy || uncertain || Boolean(recovered)} />}
      {filesUnavailable && <p role="status" className="py-2 text-sm text-[var(--error)]">Saved files could not be verified. Reopen the draft before sending.</p>}
      {snapshotReady && snapshot && <ExperienceComposeCapturedSummary snapshot={snapshot} />}
      {advancedKeys.length > 0 && <div className="min-w-0 pt-2">
        {!advancedHasValue && <button type="button" className="min-h-11 text-xs text-[var(--on-surface-variant)]" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>{advancedOpen ? 'Hide details' : 'More details'}</button>}
        {(advancedOpen || advancedHasValue) && fields.filter(field => advancedKeys.includes(field.key)).map(fieldControl)}
      </div>}
      {blocked && <p className="py-2 text-sm text-[var(--on-surface-variant)]">The save could not be confirmed. Your edits are kept on this device; reopen the draft to check its saved version.</p>}
    </div>
  </AppDialog>;
}
