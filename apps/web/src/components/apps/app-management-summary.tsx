import Link from 'next/link';
import type { AppInstallation } from '@/lib/apps';

export function AppInstallationStatus({ state }: { state: AppInstallation['state'] }) {
  const text = state === 'active' ? 'Enabled · approved for use'
    : state === 'disabled' ? 'Disabled · app access is paused'
      : state === 'failed' ? 'Needs attention · setup did not finish'
        : 'Needs review · approve access before use';
  return <p role="status" className="mt-2 text-sm font-medium" style={{ color: state === 'active' ? 'var(--status-green)' : 'var(--on-surface-variant)' }}>{text}</p>;
}

export function UpgradeTrustState({ trusted }: { trusted: boolean | null }) {
  return <p role="status" className="text-sm font-medium">{trusted === null ? 'Checking update trust…' : trusted
    ? 'On: compatible updates keep your approvals'
    : 'Off: updates need your review'}</p>;
}

type SyncStatus = {
  checkpoint: { retained_record_count: number; last_applied_at: string | null } | null;
  latest_run: { state: string; terminal_at: string | null } | null;
};
export function ConnectionSyncSummary({ status }: { status: SyncStatus }) {
  return <div className="space-y-3">
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Saved records</dt><dd>{status.checkpoint?.retained_record_count ?? 0}</dd></div>
      <div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Latest sync to Deft</dt><dd className="capitalize">{status.latest_run?.state.replaceAll('_', ' ') ?? 'Not started'}</dd></div>
      <div className="sm:col-span-2"><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Last saved update</dt><dd>{status.checkpoint?.last_applied_at ? new Date(status.checkpoint.last_applied_at).toLocaleString() : 'No update saved yet'}</dd></div>
    </dl>
    <p className="text-xs leading-5" style={{ color: 'var(--on-surface-variant)' }}>{status.latest_run?.state === 'succeeded'
      ? 'The latest sync finished successfully. Saved records reflect that sync; changes made at the source afterward may not appear here yet.'
      : 'These are saved copies in Deft. New changes at the source appear after a successful sync.'}</p>
  </div>;
}

export function SavedResourceUnavailable() {
  return <section role="alert" className="max-w-xl space-y-3 rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
    <h2 className="text-base font-semibold">This saved item isn’t available</h2>
    <p className="text-sm leading-6">Your access may have ended, or the app connection may need attention. Check your connection, then open this link again.</p>
    <Link className="deft-pill min-h-11" href="/settings/apps/private-resources">Check connection</Link>
  </section>;
}
