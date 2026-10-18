'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Check, FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import { composeAddressLabel, composeByteLabel,
  type ComposeAddressList, type ComposeDraftReference, type ComposeFile, type ComposeIdentityOption,
  type ComposeRevisionStatus } from '@/lib/app-experience-compose-controls';
import type { ComposerSnapshot } from '@/lib/app-experience-compose-files';

const secondary = 'text-xs text-[var(--on-surface-variant)]';

export { ExperienceComposeIdentityControl, ExperienceComposeAddressControl, ExperienceComposeMailboxControl } from './experience-compose-controls-recipients';
export { ExperienceComposePlainEditor } from './experience-compose-controls-editor';

/** A visible native button owns focus; the file input must never become a
 * scroll target inside a constrained installed-app surface. */
export function ExperienceFilePicker({label,children,className,disabled=false,multiple=false,accept,onSelect}:{
  label:string;children:ReactNode;className:string;disabled?:boolean;multiple?:boolean;accept?:string;onSelect:(files:readonly File[])=>void;
}) {
  const id=useId(),input=useRef<HTMLInputElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const restoreFocus=()=>trigger.current?.focus({preventScroll:true});
  useEffect(()=>{const element=input.current;if(!element)return;element.addEventListener('cancel',restoreFocus);return()=>element.removeEventListener('cancel',restoreFocus);},[]);
  return <>
    <button ref={trigger} type="button" aria-label={label} aria-controls={id} className={className} disabled={disabled} onClick={()=>input.current?.click()}>{children}</button>
    <input ref={input} id={id} hidden tabIndex={-1} type="file" multiple={multiple} disabled={disabled} accept={accept}
      onChange={event=>{const selected=Array.from(event.target.files??[]);event.target.value='';restoreFocus();if(selected.length)onSelect(selected);}}/>
  </>;
}

/** Browser files go to the host's draft upload/finalization path. Until it returns
 * a ready row they are visible as pending and cannot enter the send snapshot. */
export function ExperienceComposeFilesControl({ label, files, onSelectFiles, onRemove, onRetry, onDownload, onInsertImage, onArchive, archiveBusy = false, onCancelArchive, disabled = false, acceptedMediaTypes, unavailableNotice, extraActions }: {
  label: string; files: readonly ComposeFile[]; onSelectFiles?: (files: readonly File[]) => void; onRemove?: (key: string) => void;
  onRetry?: (key: string) => void; onDownload?: (key: string) => void; onInsertImage?: (key: string) => void; onArchive?: () => void; archiveBusy?: boolean; onCancelArchive?: () => void;
  disabled?: boolean; acceptedMediaTypes?: readonly string[]; unavailableNotice?: string; extraActions?: ReactNode;
}) {
  return <div className="min-w-0 space-y-2 pt-3">
    <div className="flex flex-wrap items-center gap-2">
      {files.length>0&&<span className="mr-auto text-xs text-[var(--on-surface-variant)]">{label}</span>}
      {onArchive && files.length > 0 && <button type="button" className="deft-pill min-h-11 px-3 text-xs" disabled={disabled} onClick={onArchive}>Download all files (.zip)</button>}
      {archiveBusy && onCancelArchive && <button type="button" className="deft-pill min-h-11 px-3 text-xs" onClick={onCancelArchive}>Cancel ZIP</button>}
      {onSelectFiles && <ExperienceFilePicker label="Add files" multiple disabled={disabled} accept={acceptedMediaTypes?.join(',')} onSelect={onSelectFiles}
        className="flex min-h-10 items-center gap-2 rounded-full px-3 text-xs text-[var(--on-surface-variant)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] hover:bg-[var(--surface-container-high)] disabled:opacity-50">
        <Paperclip size={16} aria-hidden="true"/>Add files
      </ExperienceFilePicker>}
      {extraActions}
    </div>
    {files.length > 0 && <ul className="space-y-1.5" aria-label={label}>
      {files.map(file => <li key={file.key} className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--surface-container-low)] py-1.5 pl-3 pr-1">
        <FileText size={18} aria-hidden="true" className="shrink-0 text-[var(--on-surface-variant)]" />
        <div className="min-w-0 flex-1"><p className="truncate text-sm" title={file.filename}>{file.filename}</p>
          <p className={file.status === 'failed' ? 'text-xs text-[var(--error)]' : secondary} role={file.status === 'ready' ? undefined : 'status'}>
            {composeByteLabel(file.byteCount)} · {file.status === 'ready' ? 'Ready' : file.status === 'uploading' ? 'Uploading…' : file.status === 'pending' ? 'Waiting for upload' : file.notice || 'Upload failed. Remove and select again.'}
          </p>
        </div>
        {file.status === 'uploading' && <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin text-[var(--on-surface-variant)]" />}
        {file.status === 'ready' && <Check size={15} aria-hidden="true" className="shrink-0 text-[var(--on-surface-variant)]" />}
        {onRetry && (file.status === 'failed' || file.status === 'pending') && <button type="button" className="deft-pill min-h-11 shrink-0 px-3 text-sm"
          disabled={disabled} onClick={() => onRetry(file.key)}>{file.status === 'failed' ? 'Retry' : 'Upload'}</button>}
        {onInsertImage && file.status === 'ready' && ['image/png','image/jpeg','image/gif','image/webp'].includes(file.mediaType??'') && <button type="button" className="deft-pill min-h-11 shrink-0 px-3 text-sm" disabled={disabled} aria-label={`Insert ${file.filename} in message`} onClick={() => {if(!disabled)onInsertImage(file.key);}}>Insert in message</button>}
        {onDownload && file.status === 'ready' && <button type="button" className="deft-pill min-h-11 shrink-0 px-3 text-sm" disabled={disabled} aria-label={`Download ${file.filename}`} onClick={() => onDownload(file.key)}>Download</button>}
        {onRemove && <button type="button" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50"
          disabled={disabled} aria-label={`Remove ${file.filename}`} onClick={() => onRemove(file.key)}><X size={16} aria-hidden="true" /></button>}
      </li>)}
    </ul>}
    {!onSelectFiles && !onDownload && <p className={secondary} role="status">{unavailableNotice || 'File attachments are unavailable for this draft.'}</p>}
  </div>;
}

export function ExperienceComposeRevisionNotice({ status, onUseSavedVersion, onSaveAsCopy }: {
  status: ComposeRevisionStatus; onUseSavedVersion?: () => void; onSaveAsCopy?: () => void;
}) {
  if (status === 'current') return null;
  return <div role="status" className="space-y-2 rounded-xl bg-[var(--surface-container-high)] p-3 text-sm">
    <p>{status === 'conflict' ? 'This draft changed in another tab. Your edits are kept; review the saved version before sending.'
      : status === 'saving' ? 'Saving your latest changes…' : 'The current draft could not be verified. Reopen it to check the saved version.'}</p>
    {status === 'conflict' && (onUseSavedVersion || onSaveAsCopy) && <div className="flex flex-wrap gap-2">
      {onSaveAsCopy && <button type="button" className="deft-pill min-h-11 px-3" onClick={onSaveAsCopy}>Save edits as a copy</button>}
      {onUseSavedVersion && <button type="button" className="deft-pill min-h-11 px-3" onClick={onUseSavedVersion}>Use saved version</button>}
    </div>}
  </div>;
}

/** Module-supplied plain display data from the exact retained host snapshot. */
export function ExperienceComposeCapturedSummary({ snapshot }: { snapshot: ComposerSnapshot }) {
  return <section aria-label="Saved send preview" className="min-w-0 space-y-2 pt-4">
    <details className="rounded-xl open:bg-[var(--surface-container-low)] open:px-3 open:pb-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-[var(--on-surface-variant)]">Review saved message</summary>
    <p className={`${secondary} pb-2`}>Saved version {snapshot.draft_ref.expected_revision}</p>
    <dl className="space-y-2 text-sm">
      {snapshot.preview.items.map(item => <div key={item.key} className="min-w-0">
        <dt className="text-xs text-[var(--on-surface-variant)]">{item.label}</dt>
        <dd className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{item.value || 'None'}</dd>
      </div>)}
      <div><dt className="text-xs text-[var(--on-surface-variant)]">Files</dt>
        <dd>{snapshot.preview.files.length ? <ul>{snapshot.preview.files.map(file => <li key={file.file_id} className="break-all">{file.filename} · {composeByteLabel(file.byte_length)}</li>)}</ul> : 'None'}</dd>
      </div>
    </dl>
    </details>
  </section>;
}

/** Render the exact host-resolved snapshot next to the existing one-click Send.
 * Caller must retire this snapshot on any edit, revision or authority change. */
export function ExperienceComposeSnapshotSummary({ title, identityLabel, identity, recipientLists, files, draft, status }: {
  title: string; identityLabel: string; identity: ComposeIdentityOption | null; recipientLists: readonly ComposeAddressList[];
  files: readonly ComposeFile[]; draft: ComposeDraftReference; status: ComposeRevisionStatus;
}) {
  return <section aria-label={title} className="min-w-0 space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-1"><h3 className="text-sm font-medium">{title}</h3>
      <span className={secondary}>{status === 'current' ? `Saved version ${draft.revision}` : status === 'conflict' ? 'Draft conflict' : status === 'saving' ? 'Changes pending' : 'Unavailable'}</span>
    </div>
    <dl className="space-y-1.5 text-sm">
      <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2"><dt className="text-[var(--on-surface-variant)]">{identityLabel}</dt><dd className="break-all">{identity ? composeAddressLabel(identity.address) : 'Identity unavailable'}</dd></div>
      {recipientLists.map(list => <div key={list.key} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2"><dt className="text-[var(--on-surface-variant)]">{list.label}</dt><dd className="break-all">{list.values.length ? list.values.map(composeAddressLabel).join('; ') : 'None'}</dd></div>)}
      <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2"><dt className="text-[var(--on-surface-variant)]">Files</dt>
        <dd>{files.length ? <ul className="space-y-1">{files.map(file => <li key={file.key} className="break-all">{file.filename} · {composeByteLabel(file.byteCount)}{file.status !== 'ready' ? ' · Not ready' : ''}</li>)}</ul> : 'None'}</dd>
      </div>
    </dl>
  </section>;
}
