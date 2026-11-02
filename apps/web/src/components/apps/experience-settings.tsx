'use client';

import { useCallback, useEffect, useId, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, ChevronRight, ShieldCheck } from 'lucide-react';
import type {
  ExperienceSettingsAccess,
  ExperienceSettingsAccount,
  ExperienceSettingsSection,
} from '@/lib/app-experience-settings';

export type ExperienceSettingsProps = {
  experienceLabel: string;
  title?: string;
  onBack: () => void;
  accounts: readonly ExperienceSettingsAccount[];
  selectedAccountKey: string;
  onSelectAccount?: (key: string) => void;
  accountsBusy?: boolean;
  connectAccount?: ReactNode;
  access: ExperienceSettingsAccess;
  accessBusy?: boolean;
  onRevokeAccess?: () => void;
  onReviewAccess?: () => void;
  accessReview?: ReactNode;
  agentPolicy?: ReactNode;
  approvalQueueHref?: string;
  preferences?: ReactNode;
  initialSection?: ExperienceSettingsSection;
};

/** The host retains ownership of session, source, consent and revoke fences. */
export function ExperienceSettings({
  experienceLabel,
  title = `${experienceLabel} settings`,
  onBack,
  accounts,
  selectedAccountKey,
  onSelectAccount,
  accountsBusy = false,
  connectAccount,
  access,
  accessBusy = false,
  onRevokeAccess,
  onReviewAccess,
  accessReview,
  agentPolicy,
  approvalQueueHref = '/inbox',
  preferences,
  initialSection = 'accounts',
}: ExperienceSettingsProps) {
  const id = useId();
  const selectedAccount = accounts.find(account => account.key === selectedAccountKey);
  const hasPreferences = Boolean(preferences);
  const suppliedStatus = selectedAccount?.statusLabel?.trim();
  const healthyAccount = Boolean(selectedAccount) && (!suppliedStatus || /^(?:connected|active|healthy)\b/iu.test(suppliedStatus));
  const healthy = access.state === 'active' && accounts.length > 0 && healthyAccount;
  const status = suppliedStatus ?? (accounts.length === 0 ? 'Disconnected' : access.state === 'active' ? 'Connected' : access.state === 'review_required' ? 'Review needed' : 'Disconnected');
  const statusNeedsAttention = /(?:reconnect|review|attention|disconnected|error|expired)/iu.test(status);
  const accessCopy = access.state === 'active' ? 'Access granted · until revoked'
    : access.state === 'review_required' ? 'Access requires your review' : 'Private access unavailable';
  const focusSection = useCallback((section: string) => {
    if (typeof document === 'undefined') return;
    const target = document.getElementById(`${id}-${section}`);
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus?.();
  }, [id]);
  useEffect(() => {
    if (initialSection === 'accounts' || initialSection === 'preferences' && !hasPreferences) return;
    focusSection(initialSection);
  }, [focusSection, hasPreferences, initialSection]);

  return <section aria-label={`${experienceLabel} settings`} className="deft-experience-settings h-full min-h-0 overflow-y-auto"
    style={{ background: 'var(--surface)', color: 'var(--foreground)' }}>
    <style>{`
      .deft-experience-settings-policy .deft-pill { min-height: 44px; }
      .deft-experience-settings-policy > section { font-size: 14px; line-height: 1.5; }
      .deft-experience-settings-policy select { border-color: var(--outline-variant); border-radius: 12px; background: var(--surface-container-low); color: var(--foreground); }
    `}</style>
    <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6 sm:py-5">
      <button type="button" onClick={onBack} className="deft-pill mb-3 max-w-full" style={{ minHeight: 44, whiteSpace: 'normal' }}>
        <ArrowLeft size={14} aria-hidden="true" /> <span className="min-w-0 break-words text-left">Back to {experienceLabel}</span>
      </button>
      <header className="mb-4">
        <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl" style={{ fontFamily: 'var(--font-heading)' }}>{title}</h1>
      </header>

      <div className="deft-soft-card space-y-6 p-4 sm:p-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Account</p>
              <h2 className="mt-1 min-w-0 break-all text-lg font-semibold sm:truncate" title={selectedAccount?.label}>
                {selectedAccount?.label ?? 'No account connected'}
              </h2>
              {selectedAccount?.detail && <details className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <summary className="flex min-h-11 cursor-pointer items-center">Source details</summary>
                <p className="break-words pb-2 leading-5 [overflow-wrap:anywhere]">{selectedAccount.detail}</p>
              </details>}
            </div>
            <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium" style={{
              background: statusNeedsAttention ? 'color-mix(in srgb, var(--error) 12%, var(--surface))' : 'color-mix(in srgb, var(--accent) 12%, var(--surface))',
              color: statusNeedsAttention ? 'var(--error)' : 'var(--accent)',
            }}>{status}</span>
          </div>
          <p role="status" className="text-sm leading-6" style={{ color: healthy ? 'var(--accent)' : 'var(--text-secondary)' }}>
            {healthy ? 'Everything is healthy · Private access and background sync are active.' : 'Attention needed · Review connection or permissions below.'}
          </p>
          {!healthy && <div className="flex flex-wrap gap-2">
            {access.state === 'review_required' && onReviewAccess
              ? <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={accessBusy} onClick={onReviewAccess}>
                {accessBusy ? 'Checking access…' : 'Restore access'}
              </button>
              : <button type="button" className="deft-pill" style={{ minHeight: 44 }} onClick={() => focusSection('connection')}>
                Reconnect account
              </button>}
          </div>}
          {accounts.length > 1 && <div className="space-y-2">
            <p className="text-sm font-medium">Accounts</p>
            <ul className="space-y-1">
              {accounts.map(account => {
                const selected = account.key === selectedAccountKey;
                return <li key={account.key} className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-3"
                  style={{ background: selected ? 'color-mix(in srgb, var(--accent) 5%, var(--surface))' : 'var(--surface-container-low)', boxShadow: selected ? 'inset 2px 0 var(--accent)' : undefined }}>
                  <div className="min-w-0 w-full sm:flex-1 sm:basis-36">
                    <p className="min-w-0 break-all text-sm font-medium sm:truncate" title={account.label}>{account.label}</p>
                    <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{account.statusLabel ?? 'Reviewed source'}</p>
                  </div>
                  {selected ? <span className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--accent)' }}>
                    <Check size={14} aria-hidden="true" /> Current account
                  </span> : onSelectAccount && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={accountsBusy}
                    aria-label={`Use account ${account.label}`} onClick={() => onSelectAccount(account.key)}>Use account</button>}
                </li>;
              })}
            </ul>
            <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Switching accounts uses the access already reviewed for that account.</p>
          </div>}
        </header>

        <section id={`${id}-connection`} tabIndex={-1} aria-labelledby={`${id}-connection-label`} className="scroll-mt-4 space-y-3">
          <h3 id={`${id}-connection-label`} className="text-base font-semibold">Connection &amp; background jobs</h3>
          {connectAccount ? <div className="min-w-0">{connectAccount}</div>
            : <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>No account connection settings are available.</p>}
        </section>

        <section id={`${id}-access`} tabIndex={-1} aria-labelledby={`${id}-access-label`} className="scroll-mt-4 space-y-3">
          <h3 id={`${id}-access-label`} className="text-base font-semibold">Private access</h3>
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck size={17} aria-hidden="true" style={{ color: 'var(--accent)' }} /> {accessCopy}
          </div>
          <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>{access.summary ?? (
            access.state === 'active' ? 'This app can use the private fields and saved data you approved. Access stays active until you revoke it or its permissions change.'
              : access.state === 'review_required' ? 'Review the exact fields and saved data before allowing this app to use them.'
                : 'Reopen the app to check its current private access.'
          )}</p>
          {access.state === 'active' && !!access.grants?.length && <ul className="space-y-4 pt-1" style={{ borderColor: 'var(--border-default)' }}>
            {access.grants.map(grant => <li key={grant.key} className="min-w-0">
              <p className="break-words text-sm font-medium">{grant.label}</p>
              {grant.detail && <p className="mt-1 break-words text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{grant.detail}</p>}
            </li>)}
          </ul>}
          {access.state === 'review_required' && onReviewAccess && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={accessBusy}
            onClick={onReviewAccess}>{accessBusy ? 'Checking access…' : 'Review private access'}</button>}
          {accessBusy && <p role="status" className="text-xs" style={{ color: 'var(--text-secondary)' }}>Checking private access…</p>}
          {accessReview && <div className="min-w-0">{accessReview}</div>}
          {access.state === 'active' && onRevokeAccess && <button type="button" className="deft-pill" style={{ minHeight: 44, color: 'var(--error)' }} disabled={accessBusy}
            onClick={onRevokeAccess}>{accessBusy ? 'Updating access…' : 'Revoke private access'}</button>}
        </section>

        <section id={`${id}-approvals`} tabIndex={-1} aria-labelledby={`${id}-approvals-label`} className="scroll-mt-4 space-y-3">
          <h3 id={`${id}-approvals-label`} className="text-base font-semibold">Agent requests</h3>
          <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Every permitted request still needs your approval.</p>
          {agentPolicy ? <div className="deft-experience-settings-policy min-w-0">{agentPolicy}</div>
            : <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>No agent actions are declared for this app.</p>}
          <Link href={approvalQueueHref} className="deft-pill" style={{ minHeight: 44 }}>Open approvals <ChevronRight size={14} aria-hidden="true" /></Link>
        </section>
      </div>

      {hasPreferences && <section id={`${id}-preferences`} tabIndex={-1} aria-labelledby={`${id}-preferences-label`} className="mt-4 min-w-0 scroll-mt-4">
        <h2 id={`${id}-preferences-label`} className="mb-3 text-base font-semibold">Preferences</h2>
        <div className="deft-soft-card min-w-0 p-4 sm:p-6">{preferences}</div>
      </section>}
    </div>
  </section>;
}
