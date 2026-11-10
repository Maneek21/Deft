// Org-wide trust level control for Settings > Agent governance.
//
// The trust level governs background and automation runs only (heartbeats,
// triggers, agent employee writes). Interactive chat turns with Defty are
// always approval-only, whatever the level. Changing the level is an
// owner/admin action on the server (PATCH /api/agent/settings), so this
// control is read-only for everyone else and never shows a value the server
// has not confirmed.

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';

export const TRUST_LEVELS: ReadonlyArray<{ value: TrustLevel; label: string; desc: string }> = [
  {
    value: 'conservative',
    label: 'Conservative',
    desc: "Only low-risk updates, like changing a task's status, run on their own. Everything else waits for approval.",
  },
  {
    value: 'standard',
    label: 'Standard',
    desc: 'Low-risk updates and routine creation, like new tasks, run on their own. Messages and external writes wait for approval.',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    desc: 'Most actions run on their own, including posting messages. Deletions and other destructive actions still wait for approval.',
  },
];

export const TRUST_SCOPE_NOTE =
  'Applies to background and automation runs only: heartbeats, triggers, and agent employee writes. When you ask Defty for something in chat, every change it proposes waits for your approval.';

export const TRUST_READ_ONLY_NOTE = 'Only workspace owners and admins can change the trust level.';

export function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 'conservative' || value === 'standard' || value === 'autonomous';
}

export function canEditTrustLevel(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

type Patch = (path: string, body: unknown) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export type TrustSaveResult = { ok: true; value: TrustLevel } | { ok: false; error: string };

/**
 * Persist a trust level. Resolves with the server-confirmed value on 2xx and
 * with a readable error otherwise (403, other non-2xx, or a network failure).
 * Never throws, so the caller can commit the displayed value only on success.
 */
export async function saveTrustLevel(patch: Patch, value: TrustLevel): Promise<TrustSaveResult> {
  let res: Awaited<ReturnType<Patch>>;
  try {
    res = await patch('/api/agent/settings', { trust_level: value });
  } catch {
    return { ok: false, error: 'Could not reach the server. The trust level was not changed.' };
  }
  const body = (await res.json().catch(() => null)) as { trust_level?: unknown; error?: unknown } | null;
  if (res.ok) {
    return { ok: true, value: isTrustLevel(body?.trust_level) ? body.trust_level : value };
  }
  if (res.status === 403) {
    return { ok: false, error: `${TRUST_READ_ONLY_NOTE} The trust level was not changed.` };
  }
  const detail = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
  return { ok: false, error: `Could not save the trust level (${detail}). It was not changed.` };
}

export function TrustLevelControl({
  value,
  loadError,
  canEdit,
  saving,
  error,
  onSelect,
}: {
  /** Server-confirmed level, or null while unknown (loading or failed load). */
  value: TrustLevel | null;
  loadError?: string | null;
  canEdit: boolean;
  saving: boolean;
  error?: string | null;
  onSelect: (value: TrustLevel) => void;
}) {
  const disabled = !canEdit || saving || value === null;
  return (
    <div data-testid="trust-level-control">
      <p className="text-[12px] mb-3 max-w-[640px]" style={{ color: 'var(--muted)' }} data-testid="trust-scope-note">
        {TRUST_SCOPE_NOTE}
      </p>
      {!canEdit && (
        <p className="text-[12px] mb-3" style={{ color: 'var(--foreground-secondary)' }} data-testid="trust-read-only-note">
          {TRUST_READ_ONLY_NOTE}
        </p>
      )}
      {value === null && (
        <p className="text-[12px] mb-3" style={{ color: loadError ? 'var(--danger)' : 'var(--muted)' }} role={loadError ? 'alert' : 'status'}>
          {loadError ?? 'Loading current trust level…'}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Trust level">
        {TRUST_LEVELS.map((t) => {
          const selected = value === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              data-testid={`trust-level-${t.value}`}
              onClick={() => {
                if (!disabled && !selected) onSelect(t.value);
              }}
              className="p-4 rounded-lg text-left disabled:cursor-not-allowed"
              style={{
                background: selected ? 'var(--bg-active)' : 'var(--surface-container)',
                border: selected ? '1px solid var(--primary-container)' : '1px solid transparent',
                opacity: disabled && !selected ? 0.6 : 1,
              }}
            >
              <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>
                {t.label}
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>
                {t.desc}
              </p>
            </button>
          );
        })}
      </div>
      {saving && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--outline)' }} role="status">
          Saving...
        </p>
      )}
      {error && (
        <p className="text-[12px] mt-2" style={{ color: 'var(--danger)' }} role="alert" data-testid="trust-level-error">
          {error}
        </p>
      )}
    </div>
  );
}
