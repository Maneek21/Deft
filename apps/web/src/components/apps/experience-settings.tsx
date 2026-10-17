'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, ChevronRight, ShieldCheck } from 'lucide-react';
import { SettingsSectionNav } from '@/components/settings-section-nav';
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
  const [section, setSection] = useState<ExperienceSettingsSection>(initialSection);
  const id = useId();
  const hasPreferences = Boolean(preferences);
  const sections: { id: ExperienceSettingsSection; label: string }[] = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'access', label: 'Access' },
    { id: 'approvals', label: 'Approvals' },
    ...(hasPreferences ? [{ id: 'preferences' as const, label: 'Preferences' }] : []),
  ];
  const visibleSection = section === 'preferences' && !hasPreferences ? 'accounts' : section;

  return <section aria-label={`${experienceLabel} settings`} className="deft-experience-settings h-full min-h-0 overflow-y-auto"
    style={{ background: 'var(--surface)', color: 'var(--foreground)' }}>
    <style>{`
      .deft-experience-settings-policy .deft-pill { min-height: 44px; }
      .deft-experience-settings-policy > section { font-size: 14px; line-height: 1.5; }
      .deft-experience-settings-policy select { border-color: var(--outline-variant); border-radius: 12px; background: var(--surface-container-low); color: var(--foreground); }
    `}</style>
    <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-7">
      <button type="button" onClick={onBack} className="deft-pill mb-5 max-w-full" style={{ minHeight: 44, whiteSpace: 'normal' }}>
        <ArrowLeft size={14} aria-hidden="true" /> <span className="min-w-0 break-words text-left">Back to {experienceLabel}</span>
      </button>
      <header className="mb-6">
        <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl" style={{ fontFamily: 'var(--font-heading)' }}>{title}</h1>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Accounts, private access, and approvals for {experienceLabel}.</p>
      </header>
      <SettingsSectionNav label={`${experienceLabel} settings sections`} sections={sections} value={visibleSection} onChange={setSection} />

      <section hidden={visibleSection !== 'accounts'} aria-labelledby={`${id}-accounts`}>
        <div className="mb-4">
          <h2 id={`${id}-accounts`} className="text-base font-semibold">Accounts</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Choose the account you use in {experienceLabel}.</p>
        </div>
        <div className="overflow-hidden rounded-xl">
          {accounts.length ? <ul className="space-y-1" style={{ borderColor: 'var(--border-default)' }}>
            {accounts.map(account => {
              const selected = account.key === selectedAccountKey;
              return <li key={account.key} className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-4 sm:px-5" style={{ background: selected ? 'color-mix(in srgb, var(--accent) 5%, var(--surface))' : undefined, boxShadow: selected ? 'inset 2px 0 var(--accent)' : undefined }}>
                <div className="min-w-0 flex-1 basis-36">
                  <p className="break-words text-sm font-medium">{account.label}</p>
                  <p className="mt-1 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{account.statusLabel ?? 'Reviewed source'}</p>
                  {account.detail && <details className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <summary className="flex min-h-11 cursor-pointer items-center">Source details</summary>
                    <p className="break-words pb-2 leading-5 [overflow-wrap:anywhere]">{account.detail}</p>
                  </details>}
                </div>
                {selected ? <span className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--accent)' }}>
                  <Check size={14} aria-hidden="true" /> Current account
                </span> : onSelectAccount && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={accountsBusy}
                  aria-label={`Use account ${account.label}`} onClick={() => onSelectAccount(account.key)}>Use account</button>}
              </li>;
            })}
          </ul> : <p className="px-4 py-5 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Set up an account to get started.</p>}
        </div>
        <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Switching accounts uses the access already reviewed for that account.</p>
        {connectAccount && <div className="mt-8 rounded-2xl bg-[var(--surface-container-low)] p-4 sm:p-5">{connectAccount}</div>}
      </section>

      <section hidden={visibleSection !== 'access'} aria-labelledby={`${id}-access`}>
        <div className="mb-4">
          <h2 id={`${id}-access`} className="text-base font-semibold">Private access</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Control the private data {experienceLabel} can use.</p>
        </div>
        <div className="space-y-5 py-2">
          <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={17} aria-hidden="true" style={{ color: 'var(--accent)' }} />
            {access.state === 'active' ? 'Access granted · until revoked' : access.state === 'review_required' ? 'Access requires your review' : 'Private access unavailable'}
          </div>
          <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>{access.summary ?? (
            access.state === 'active' ? 'This app can use the private fields and saved data you approved. Access stays active until you revoke it or its permissions change.'
              : access.state === 'review_required' ? 'Review the exact fields and saved data before allowing this app to use them.'
                : 'Reopen the app to check its current private access.'
          )}</p>
          {access.state === 'active' && !!access.grants?.length && <ul className="space-y-4 pt-3" style={{ borderColor: 'var(--border-default)' }}>
            {access.grants.map(grant => <li key={grant.key} className="min-w-0">
              <p className="break-words text-sm font-medium">{grant.label}</p>
              {grant.detail && <p className="mt-1 break-words text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{grant.detail}</p>}
            </li>)}
          </ul>}
          <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Agent requests are managed separately in Approvals.</p>
          {access.state === 'active' && onRevokeAccess && <button type="button" className="deft-pill" style={{ minHeight: 44, color: 'var(--error)' }} disabled={accessBusy}
            onClick={onRevokeAccess}>{accessBusy ? 'Updating access…' : 'Revoke private access'}</button>}
          {access.state === 'review_required' && onReviewAccess && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={accessBusy}
            onClick={onReviewAccess}>{accessBusy ? 'Checking access…' : 'Review private access'}</button>}
          {accessBusy && <p role="status" className="text-xs" style={{ color: 'var(--text-secondary)' }}>Checking private access…</p>}
        </div>
        {accessReview && <div className="mt-5">{accessReview}</div>}
      </section>

      <section hidden={visibleSection !== 'approvals'} aria-labelledby={`${id}-approvals`}>
        <div className="mb-4">
          <h2 id={`${id}-approvals`} className="text-base font-semibold">Approvals</h2>
          <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Manage agent requests and review pending actions.</p>
        </div>
        <div className="space-y-5 py-2">
          <div className="space-y-4 pb-3" style={{ borderColor: 'var(--border-default)' }}>
            <div><p className="text-sm font-medium">Actions you choose</p><p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Review the details and confirm an action when you use it.</p></div>
            <div><p className="text-sm font-medium">Agent requests</p><p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Agents need separate permission to request an action. Every permitted request still needs your approval.</p></div>
          </div>
          <div>
            <p className="text-sm font-medium">Deft approval queue</p>
            <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Review pending agent requests and their action details in your shared queue.</p>
          </div>
          <Link href={approvalQueueHref} className="deft-pill" style={{ minHeight: 44 }}>Open approvals <ChevronRight size={14} aria-hidden="true" /></Link>
          {agentPolicy && <div className="deft-experience-settings-policy">{agentPolicy}</div>}
        </div>
      </section>

      {hasPreferences && <section hidden={visibleSection !== 'preferences'} aria-labelledby={`${id}-preferences`}>
        <h2 id={`${id}-preferences`} className="mb-4 text-base font-semibold">Preferences</h2>
        <div className="min-w-0">{preferences}</div>
      </section>}
    </div>
  </section>;
}
