import type { ExistingAccountReview } from '../../lib/app-connection-reattachment';

/** Display only a host-validated current review; custody transition stays in the flow. */
export function ExperienceExistingAccountReview({ review, uncertain, now, disabled, onAllow, onCheck, onClose, canCloseUnstarted, onCloseUnstarted }: {
  review: ExistingAccountReview | null; uncertain: boolean; now: number; disabled: boolean;
  canCloseUnstarted?:boolean;onCloseUnstarted?:()=>void;
  onAllow: () => void; onCheck: () => void; onClose: () => void;
}) {
  if (uncertain) return <section aria-label="Account reuse status" className="space-y-3 text-sm">
    <p>Account reuse status is unconfirmed. Check its status before continuing. No new setup will start automatically.</p>
    <button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={onCheck}>Check status</button>
    {canCloseUnstarted&&onCloseUnstarted&&<><p>Close this review only if account setup has not started. An existing account request will be left unchanged.</p><button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={onCloseUnstarted}>Close unstarted review</button></>}
  </section>;
  if (!review) return null;
  const expired = Date.parse(review.expires_at) <= now;
  return <section aria-label="Review existing account" className="space-y-3 rounded-xl border p-4 text-sm leading-6"
    style={{ borderColor: 'var(--outline-variant)', background: 'var(--surface-container-low)' }}>
    <h4 className="text-base font-semibold">Use existing account</h4>
    <p className="break-words font-medium">{review.account.label}</p>
    <p>Connect this account to the current app and its reviewed account access {review.scope.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(review.scope.consent_expires_at!).toLocaleString()}`}.</p>
    <p>Your saved account records stay with the same account. Draft access and actions are reviewed separately.</p>
    {review.schema_version==='deft.app_connection_reattach_review.v2'&&<dl className="space-y-2">{review.action_consents.map(consent=><div key={consent.action_key}><dt className="font-medium capitalize">{consent.action_key.replaceAll('_',' ')}</dt><dd>{consent.consent_lifetime==='until_revoked'?'Separately reviewed until revoked':`Separately reviewed until ${new Date(consent.expires_at!).toLocaleString()}`}</dd></div>)}</dl>}
    {expired && <p role="status">This review expired. Check status to finish it before reviewing again.</p>}
    <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
      {expired ? <button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={onCheck}>Check status</button>
        : <button type="button" className="deft-pill min-h-11" style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }} disabled={disabled} onClick={onAllow}>Allow and continue</button>}
      <button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={onClose}>Close</button>
    </div>
    <p className="text-xs text-[var(--on-surface-variant)]">Closing leaves this review pending.</p>
  </section>;
}
