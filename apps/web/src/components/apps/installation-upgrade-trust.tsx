'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';

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
  return <section aria-label="Automatic upgrade continuity" className="rounded-xl border p-4 space-y-3">
    <h2 className="text-sm font-semibold">Automatic upgrade continuity</h2>
    <p className="text-sm">Trust compatible updates to keep existing owner approvals. Changes to permissions, providers,
      destinations, actions, schemas, or connection settings require review. Expiry dates and revocations still apply.</p>
    <p role="status" className="text-sm">{policy ? policy.trusted ? 'Trusted for automatic upgrade continuity' : 'Automatic upgrade continuity is off' : error ? 'Upgrade trust unavailable' : 'Loading upgrade trust...'}</p>
    <button type="button" className="deft-pill" disabled={!policy || busy} onClick={() => void change()}>
      {busy ? 'Saving...' : policy?.trusted ? 'Turn off upgrade trust' : 'Trust compatible upgrades'}
    </button>
    {error && <p role="alert" className="text-sm">{error}</p>}
  </section>;
}
