'use client';

import {
  TRUST_READ_ONLY_NOTE,
  isTrustLevel,
  trustLevelLabel,
  type TrustLevel,
} from '@/components/trust-level-control';

const TRUST_ORDER: readonly TrustLevel[] = ['conservative', 'standard', 'autonomous'];

/** Trust levels strictly below `current`, highest first. */
export function lowerTrustLevels(current: string): TrustLevel[] {
  if (!isTrustLevel(current)) return [];
  return TRUST_ORDER.slice(0, TRUST_ORDER.indexOf(current)).reverse();
}

export function EmployeeTrustActions({
  trustLevel,
  canEdit,
  busy,
  onUpgrade,
  onLower,
}: {
  trustLevel: string;
  canEdit: boolean;
  busy: boolean;
  onUpgrade: () => void;
  onLower: (level: TrustLevel) => void;
}) {
  const label = isTrustLevel(trustLevel) ? trustLevelLabel(trustLevel) : trustLevel;
  const lower = canEdit ? lowerTrustLevels(trustLevel) : [];
  return (
    <div className="flex-1 min-w-0" data-testid="employee-trust-actions">
      {canEdit && trustLevel !== 'autonomous' ? (
        <button
          type="button"
          onClick={onUpgrade}
          disabled={busy}
          className="w-full text-[12px] px-3 py-2 rounded font-medium disabled:opacity-60"
          style={{ background: 'var(--warning, #f59e0b)', color: 'white' }}
          data-testid="upgrade-autonomous-btn"
        >
          Upgrade to autonomous
        </button>
      ) : (
        <div
          className="text-[11px] px-3 py-2 rounded text-center"
          style={{ background: 'var(--surface-container)', color: 'var(--muted)', border: '1px solid var(--border)' }}
        >
          Trust: {label}
        </div>
      )}
      {!canEdit && (
        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>{TRUST_READ_ONLY_NOTE}</p>
      )}
      {lower.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span>Lower trust to</span>
          {lower.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => onLower(level)}
              disabled={busy}
              className="px-2 py-1 rounded font-medium disabled:opacity-60"
              style={{ border: '1px solid var(--border)', color: 'var(--foreground)', background: 'transparent' }}
              data-testid={`lower-trust-${level}`}
            >
              {trustLevelLabel(level)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
