'use client';

/**
 * Phase 8 — Wizard step 1: Role template picker.
 *
 * Card grid of available first-party role templates. Only `alex-pm` is
 * fully wired in Phase 8; the rest are rendered with "Available in Phase 9"
 * badges and disabled click handlers.
 */
export type TemplateCard = {
  slug: string;
  name: string;
  description: string;
  version: string;
  role: string;
  default_trust_level: string;
  default_trigger_subscriptions: string[] | null;
  ready_in_phase_8: boolean;
  default_capability_packs: string[];
};

export function RolePicker({
  templates,
  selected,
  onSelect,
  name,
  slug,
  onNameChange,
  onSlugChange,
}: {
  templates: TemplateCard[];
  selected: string | null;
  onSelect: (slug: string) => void;
  name: string;
  slug: string;
  onNameChange: (v: string) => void;
  onSlugChange: (v: string) => void;
}) {
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        1. Pick a role template
      </h3>
      <p
        className="text-[12px] mb-4"
        style={{ color: 'var(--muted)' }}
      >
        Each template ships with a SOUL.md / AGENTS.md / USER.md / TOOLS.md bootstrap, a
        recommended model, and a default capability pack. You can customize in later steps.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {templates.map((t) => {
          const enabled = t.ready_in_phase_8;
          const isSelected = selected === t.slug;
          return (
            <button
              type="button"
              key={t.slug}
              disabled={!enabled}
              onClick={() => enabled && onSelect(t.slug)}
              data-testid={`role-card-${t.slug}`}
              className="text-left p-4 rounded-lg transition-all"
              style={{
                background: isSelected ? 'var(--accent-muted, rgba(59,130,246,0.1))' : 'var(--card-bg)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                opacity: enabled ? 1 : 0.55,
                cursor: enabled ? 'pointer' : 'not-allowed',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <p
                  className="text-[14px] font-semibold"
                  style={{ color: 'var(--foreground)' }}
                >
                  {t.name}
                </p>
                {!enabled && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'rgba(234, 179, 8, 0.15)',
                      color: '#eab308',
                    }}
                  >
                    Available in Phase 9
                  </span>
                )}
              </div>
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {t.description}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--surface-container)',
                    color: 'var(--foreground-secondary)',
                  }}
                >
                  {t.role}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--surface-container)',
                    color: 'var(--foreground-secondary)',
                  }}
                >
                  v{t.version}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label
              className="text-[11px] font-medium"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Display name
            </label>
            <input
              type="text"
              value={name}
              data-testid="wizard-name-input"
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg text-[13px]"
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
              Slug (lowercase letters / numbers / dash)
            </label>
            <input
              type="text"
              value={slug}
              data-testid="wizard-slug-input"
              onChange={(e) =>
                onSlugChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
              }
              className="w-full mt-1 px-3 py-2 rounded-lg text-[13px] font-mono"
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
}
