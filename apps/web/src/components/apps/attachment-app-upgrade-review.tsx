import {attachmentUpgradeBlocked,type AttachmentUpgradeReview} from '../../lib/app-attachment-upgrade';
export function AttachmentAppUpgradeReviewPanel({review,busy,accepted,onAccept,onActivate,onClose}:{review:AttachmentUpgradeReview;busy:boolean;accepted:boolean;onAccept:(value:boolean)=>void;onActivate:()=>void;onClose:()=>void}){
 const blocked=attachmentUpgradeBlocked(review);
 return <section aria-label="App upgrade review" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3 text-sm">
  <h3 className="font-semibold">Review this App upgrade</h3><p>Existing data stays in place. This version receives no account, Runtime or resource authority automatically. Review those bindings separately after upgrading.</p>
  <details><summary className="cursor-pointer py-2">Current and requested access</summary><div className="grid min-w-0 gap-3 md:grid-cols-2"><div><h4>Current access</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(review.prior_authority,null,2)}</pre></div><div><h4>Requested access</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(review.target_authority,null,2)}</pre></div></div></details>
  <p>Included Modules: {review.modules.map(item=>`${item.module_id} (${item.mode.replaceAll('_',' ')})`).join(', ')||'None'}.</p>
  <p>Old pending work: {Object.entries(review.blockers.old_work).filter(([,count])=>count>0).map(([state,count])=>`${state.replaceAll('_',' ')}: ${count}`).join(', ')||'None'}. Active dependents: {review.blockers.active_dependents}. Pending public follow-ups: {review.blockers.pending_public_followups}.</p>
  {blocked&&<p role="alert">Pending work or dependent Apps block this upgrade. Resolve it through its normal controls, then request a fresh review. Do not repeat uncertain actions.</p>}
  <label className="flex min-h-11 items-start gap-2"><input type="checkbox" checked={accepted} disabled={busy||blocked} onChange={event=>onAccept(event.target.checked)}/><span>I reviewed this exact access change and accept the host policy. Existing effects retain their original review; account and Runtime access must be reviewed again.</span></label>
  <div className="flex flex-wrap gap-2"><button type="button" className="deft-pill min-h-11" disabled={busy||blocked||!accepted} onClick={onActivate}>Accept review and upgrade</button><button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onClose}>Close review</button></div>
 </section>;
}
