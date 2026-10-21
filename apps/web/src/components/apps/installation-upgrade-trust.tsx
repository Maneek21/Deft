'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { UpgradeTrustState } from './app-management-summary';

type Trust = { trusted: boolean; revision: number };
export function InstallationUpgradeTrust({ installationId }: { installationId: string }) {
  const [policy, setPolicy] = useState<Trust | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await api.get(`/api/apps/${encodeURIComponent(installationId)}/upgrade-trust`);
        if (!response.ok) throw new Error(await appApiError(response, 'Unable to load upgrade trust.'));
        const value = await response.json() as Trust;
        if (current) setPolicy(value);
      } catch (reason) { if (current) setError(reason instanceof Error ? reason.message : 'Unable to load upgrade trust.'); }
    })();
    return () => { current = false; };
  }, [installationId]);
  const change = async () => {
    if (!policy) return;
    setBusy(true); setError(null);
    try {
      const response = await api.put(`/api/apps/${encodeURIComponent(installationId)}/upgrade-trust`,
        { trusted: !policy.trusted, expected_revision: policy.revision });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to change upgrade trust. Reload to check the current setting.'));
      setPolicy(await response.json() as Trust);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change upgrade trust.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Compatible update trust" className="rounded-xl border p-4 space-y-3">
    <h2 className="text-sm font-semibold">Compatible update trust</h2>
    {error && !policy ? <p role="status" className="text-sm">Update trust could not be checked</p> : <UpgradeTrustState trusted={policy?.trusted ?? null} />}
    <p className="text-sm">Compatible updates can keep your existing approvals when this is on. Changes to permissions, providers,
      destinations, actions, schemas, or connection settings require review. Expiry dates and revocations still apply.</p>
    <button type="button" className="deft-pill min-h-11" disabled={!policy || busy} onClick={() => void change()}>
      {busy ? 'Saving...' : policy?.trusted ? 'Turn off upgrade trust' : 'Trust compatible upgrades'}
    </button>
    {error && <p role="alert" className="text-sm">{error}</p>}
  </section>;
}
