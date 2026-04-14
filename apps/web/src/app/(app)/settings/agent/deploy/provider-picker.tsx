'use client';

/**
 * Phase 8 — Wizard step 3: Deployment target picker.
 *
 * Three cards: Deft Cloud (primary/disabled), Railway (managed, requires
 * OAuth), BYO URL (self-hosted OpenClaw instance).
 */
export type ProviderCard = {
  id: 'railway' | 'byo' | 'deft_cloud' | 'fly' | 'digitalocean';
  displayName: string;
  isManaged: boolean;
  isAvailable: boolean;
  comingSoon: boolean;
  estimatedCostUsdCents: number | null;
  unavailableReason?: string;
};

export type Integration = {
  id: string;
  provider: string;
  account_label: string | null;
  external_workspace_name: string | null;
  status: string;
};

export function ProviderPicker({
  providers,
  integrations,
  selected,
  selectedIntegrationId,
  byoConnectionUrl,
  byoGatewayToken,
  onSelect,
  onSelectIntegration,
  onByoUrlChange,
  onByoTokenChange,
  apiBaseUrl,
}: {
  providers: ProviderCard[];
  integrations: Integration[];
  selected: string | null;
  selectedIntegrationId: string | null;
  byoConnectionUrl: string;
  byoGatewayToken: string;
  onSelect: (id: string) => void;
  onSelectIntegration: (id: string | null) => void;
  onByoUrlChange: (v: string) => void;
  onByoTokenChange: (v: string) => void;
  apiBaseUrl: string;
}) {
  const railwayIntegration = integrations.find((i) => i.provider === 'railway' && i.status === 'connected');

  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        3. Deployment target
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Where will the OpenClaw container run? Deft orchestrates managed
        providers end-to-end; BYO is for power users with their own infra.
      </p>
      <div className="space-y-3">
        {providers.map((p) => {
          const isSelected = selected === p.id;
          const disabled = p.comingSoon || !p.isAvailable;
          return (
            <div
              key={p.id}
              data-testid={`provider-card-${p.id}`}
              onClick={() => !disabled && onSelect(p.id)}
              className="p-4 rounded-lg transition-all"
              style={{
                background: isSelected ? 'rgba(59,130,246,0.08)' : 'var(--card-bg)',
                border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                opacity: disabled ? 0.6 : 1,
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <p
                  className="text-[14px] font-semibold"
                  style={{ color: 'var(--foreground)' }}
                >
                  {p.displayName}
                  {p.comingSoon && (
                    <span
                      className="ml-2 text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'rgba(148,163,184,0.15)',
                        color: '#94a3b8',
                      }}
                    >
                      Coming v1.1 — join waitlist
                    </span>
                  )}
                </p>
                {p.id === 'deft_cloud' && (
                  <span className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                    $15/mo per employee
                  </span>
                )}
                {p.id === 'railway' && (
                  <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                    ~$5-8/mo (Railway) + Deft orchestration fee (coming soon)
                  </span>
                )}
              </div>
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {p.id === 'deft_cloud' && 'We host OpenClaw for you. Fastest setup — nothing to manage.'}
                {p.id === 'railway' && 'Deploy to your Railway account. Deft handles provisioning and monitoring.'}
                {p.id === 'byo' && "I already run OpenClaw somewhere. I'll paste the URL."}
              </p>
              {p.unavailableReason && (
                <p className="text-[11px] mt-2" style={{ color: '#eab308' }}>
                  {p.unavailableReason}
                </p>
              )}
              {p.id === 'railway' && isSelected && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                  {railwayIntegration ? (
                    <div>
                      <p className="text-[12px]" style={{ color: 'var(--foreground)' }}>
                        Connected:{' '}
                        <span style={{ fontWeight: 600 }}>
                          {railwayIntegration.external_workspace_name ?? railwayIntegration.account_label ?? 'Railway account'}
                        </span>
                      </p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectIntegration(railwayIntegration.id);
                        }}
                        className="mt-2 px-3 py-1 rounded text-[11px]"
                        style={{
                          background:
                            selectedIntegrationId === railwayIntegration.id
                              ? 'var(--accent)'
                              : 'var(--surface-container)',
                          color:
                            selectedIntegrationId === railwayIntegration.id
                              ? 'white'
                              : 'var(--foreground)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        {selectedIntegrationId === railwayIntegration.id
                          ? 'Selected'
                          : 'Use this workspace'}
                      </button>
                    </div>
                  ) : (
                    <a
                      href={`${apiBaseUrl}/api/integrations/railway/start?return_to=/settings/agent/deploy`}
                      className="inline-block px-3 py-2 rounded text-[12px] font-medium"
                      style={{ background: 'var(--accent)', color: 'white' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Connect Railway
                    </a>
                  )}
                </div>
              )}
              {p.id === 'byo' && isSelected && (
                <div
                  className="mt-3 pt-3 space-y-2"
                  style={{ borderTop: '1px solid var(--border)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div>
                    <label
                      className="text-[11px] font-medium"
                      style={{ color: 'var(--foreground-secondary)' }}
                    >
                      OpenClaw Gateway URL
                    </label>
                    <input
                      type="text"
                      value={byoConnectionUrl}
                      onChange={(e) => onByoUrlChange(e.target.value)}
                      placeholder="http://host.docker.internal:18789"
                      data-testid="byo-url-input"
                      className="w-full mt-1 px-3 py-2 rounded-lg text-[12px] font-mono"
                      style={{
                        background: 'var(--surface-container)',
                        color: 'var(--foreground)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                  <div>
                    <label
                      className="text-[11px] font-medium"
                      style={{ color: 'var(--foreground-secondary)' }}
                    >
                      Gateway bearer token
                    </label>
                    <input
                      type="password"
                      value={byoGatewayToken}
                      onChange={(e) => onByoTokenChange(e.target.value)}
                      placeholder="openclaw-gateway-token"
                      data-testid="byo-token-input"
                      className="w-full mt-1 px-3 py-2 rounded-lg text-[12px] font-mono"
                      style={{
                        background: 'var(--surface-container)',
                        color: 'var(--foreground)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
