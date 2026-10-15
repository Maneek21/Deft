import {observationIntervalLabel} from '../../lib/app-experience-settings-display';
import type {ResourceObservationReview} from '../../lib/app-resource-observation';
export function ExperienceBackgroundRefreshReview({review,now,busy,onAllow,onCheck,onClose}:{review:ResourceObservationReview;now:number;busy:boolean;onAllow:()=>void;onCheck:()=>void;onClose:()=>void}){
 const expired=Date.parse(review.review_expires_at??review.expires_at!)<=now;
 return <section aria-label="Review background refresh" className="space-y-3 rounded-xl border p-4 text-sm" style={{borderColor:'var(--outline-variant)',background:'var(--surface-container-low)'}}>
  <h4 className="font-semibold">Allow background refresh</h4><p className="break-words">{review.account.label}</p>
  <p>Observe mailbox metadata at most once every {observationIntervalLabel(review.interval_seconds)}, {review.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(review.expires_at!).toLocaleString()}`}.</p>
  <p>Files and attachments are not downloaded in the background. This does not permit draft changes, sending or other actions. No personal sign-in token is stored for unattended work.</p>
  {expired&&<p role="status">This review expired. Check status before requesting another review.</p>}
  <div className="flex flex-wrap gap-2">{expired?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onCheck}>Check status</button>:<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onAllow}>Allow background refresh</button>}
   <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onClose}>Close review</button></div><p className="text-xs text-[var(--on-surface-variant)]">Closing leaves the review pending; it does not enable background refresh.</p>
 </section>;
}
