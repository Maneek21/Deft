'use client';

/**
 * Phase 8 — Wizard step 2: Capability pack picker.
 *
 * Renders the pack catalog from the backend as a grouped checklist. Packs
 * with `user_provides_secret=true` reveal a password input to collect the
 * credential (which gets baked into the container env vars at deploy time).
 *
 * Always-on packs are rendered disabled + checked. "Coming Soon" packs are
 * rendered disabled + unchecked with a greyed-out label.
 */
export type Pack = {
  slug: string;
  display_name: string;
  description: string;
  is_always_on: boolean;
  layer: 1 | 2 | 3;
  provider_env_var?: string;
  user_provides_secret: boolean;
  coming_soon?: boolean;
};

export function CapabilityPicker({
  packs,
  selected,
  secrets,
  onToggle,
  onSecretChange,
}: {
  packs: Pack[];
  selected: string[];
  secrets: Record<string, string>;
  onToggle: (slug: string) => void;
  onSecretChange: (envVar: string, value: string) => void;
}) {
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        2. Capability packs
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Tool bundles the employee can call. Each pack maps to one of three layers:
        Deft workspace MCP (Layer 1), OpenClaw native plugins (Layer 2), or external
        MCP servers (Layer 3). Packs marked with a key icon need your API token.
      </p>
      <div className="space-y-2">
        {packs.map((p) => {
          const isSelected = selected.includes(p.slug) || p.is_always_on;
          const disabled = p.is_always_on || p.coming_soon === true;
          return (
            <div
              key={p.slug}
              data-testid={`capability-pack-${p.slug}`}
              className="p-3 rounded-lg"
              style={{
                background: isSelected ? 'rgba(59,130,246,0.05)' : 'var(--card-bg)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                opacity: p.coming_soon ? 0.55 : 1,
              }}
            >
              <label
                className="flex items-start gap-3"
                style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => !disabled && onToggle(p.slug)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p
                      className="text-[13px] font-medium"
                      style={{ color: 'var(--foreground)' }}
                    >
                      {p.display_name}
                    </p>
                    <span
                      className="text-[9px] px-1 py-0.5 rounded"
                      style={{
                        background: 'var(--surface-container)',
                        color: 'var(--foreground-secondary)',
                      }}
                    >
                      L{p.layer}
                    </span>
                    {p.user_provides_secret && (
                      <span
                        className="text-[9px] px-1 py-0.5 rounded"
                        style={{
                          background: 'rgba(234,179,8,0.15)',
                          color: '#eab308',
                        }}
                      >
                        Credential required
                      </span>
                    )}
                    {p.is_always_on && (
                      <span
                        className="text-[9px] px-1 py-0.5 rounded"
                        style={{
                          background: 'rgba(16,185,129,0.15)',
                          color: '#10b981',
                        }}
                      >
                        Always on
                      </span>
                    )}
                    {p.coming_soon && (
                      <span
                        className="text-[9px] px-1 py-0.5 rounded"
                        style={{
                          background: 'rgba(148,163,184,0.15)',
                          color: '#94a3b8',
                        }}
                      >
                        Coming soon
                      </span>
                    )}
                  </div>
                  <p
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--muted)' }}
                  >
                    {p.description}
                  </p>
                </div>
              </label>
              {isSelected && p.user_provides_secret && p.provider_env_var && !p.coming_soon && (
                <div className="mt-3 ml-6">
                  <label
                    className="text-[11px] font-medium"
                    style={{ color: 'var(--foreground-secondary)' }}
                  >
                    {p.provider_env_var}
                  </label>
                  <input
                    type="password"
                    placeholder={`Paste your ${p.display_name} token`}
                    value={secrets[p.provider_env_var] ?? ''}
                    onChange={(e) => onSecretChange(p.provider_env_var!, e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-lg text-[12px] font-mono"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground)',
                      border: '1px solid var(--border)',
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
