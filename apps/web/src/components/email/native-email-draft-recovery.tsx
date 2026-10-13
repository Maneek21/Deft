'use client';
import type {NativeDraftRecoveryState} from '@/lib/email-native-draft-recovery';
import type {NativeDraftSaveState} from '@/lib/email-native-drafts';
const pill='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailDraftRecovery({value,editor,locked,copyAllowed=true,onRestore,onCopy,onKeep}:{value:NativeDraftRecoveryState|null;editor:NativeDraftSaveState;locked:boolean;copyAllowed?:boolean;onRestore:()=>void;onCopy:()=>void;onKeep:()=>void}){
 if(!value||locked)return null;const candidate=value.candidate;
 if(!candidate)return <p role="status" className="text-xs text-[var(--muted)]">{value.notice}</p>;
 const canRestore=candidate.sendOutcome==='none'&&candidate.baseServerRevision===editor.revision&&!editor.dirty&&!editor.fileMutation;
 return <section aria-label="Browser draft recovery" className="space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3">
  <p className="text-sm font-medium">A browser draft is available</p>
  <p className="text-xs text-[var(--muted)]">{candidate.sendOutcome==='unknown'?'An earlier sending outcome needs checking. Use Send status; this copy cannot be restored.':canRestore?'Restore your browser edits to this saved draft.':!copyAllowed?'This copy belongs to an agent draft. Review the saved draft before using these edits.':editor.dirty?'Your current edits are kept. Save them before opening the recovery as a new draft.':'The saved draft changed elsewhere. You can open the browser copy as a new draft.'}</p>
  <details><summary className="cursor-pointer text-xs">Preview browser text</summary><p className="mt-2 text-sm font-medium">{candidate.content.subject||'No subject'}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{candidate.content.body}</pre></details>
  <div className="flex flex-wrap gap-1">{canRestore?<button type="button" className={pill} onClick={onRestore}>Restore browser draft</button>:candidate.sendOutcome==='none'&&copyAllowed&&<button type="button" className={pill} disabled={editor.dirty||!!editor.fileMutation} onClick={onCopy}>Open as new draft</button>}
   <button type="button" className={pill} onClick={onKeep}>Keep current draft</button></div>
  <p className="text-xs text-[var(--muted)]">Attachment bytes are not stored in browser recovery. New copies keep text only.</p>
 </section>;
}
