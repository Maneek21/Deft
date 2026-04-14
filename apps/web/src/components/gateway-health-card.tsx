'use client';

/**
 * Phase 11 — per-Gateway health card for Settings → Agent.
 *
 * Each card represents one OpenClaw Gateway (a unique connection_url).
 * Since a Gateway can host multiple employees in its `agents.list[]`, the
 * card aggregates status across every member employee and surfaces a
 * single Gateway-level pill + the most recent ping time, then lists each
 * member row with its own status dot and any per-row connection_error.
 */

type MemberStatus = 'pending' | 'connected' | 'error' | 'revoked';

export interface GatewayHealthMember {
  id: string;
  name: string;
  slug: string;
  role: string;
  connection_status: MemberStatus;
  connection_error: string | null;
  last_gateway_ping_at: string | null;
  gateway_ping_fail_count: number;
}

export interface GatewayHealthCardProps {
  gatewayUrl: string;
  employees: GatewayHealthMember[];
}

type Aggregate = 'connected' | 'degraded' | 'error' | 'pending';

const AGGREGATE_STYLES: Record<Aggregate, { label: string; color: string }> = {
  connected: { label: 'Connected', color: '#10b981' },
  degraded: { label: 'Degraded', color: '#eab308' },
  error: { label: 'Error', color: '#ef4444' },
  pending: { label: 'Pending', color: '#94a3b8' },
};

const MEMBER_DOT_COLORS: Record<MemberStatus, string> = {
  connected: '#10b981',
  pending: '#eab308',
  error: '#ef4444',
  revoked: '#94a3b8',
};

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function aggregateStatus(members: GatewayHealthMember[]): Aggregate {
  if (members.length === 0) return 'pending';
  const hasError = members.some((m) => m.connection_status === 'error');
  if (hasError) return 'error';
  const allPending = members.every((m) => m.connection_status === 'pending');
  if (allPending) return 'pending';
  const allConnected = members.every(
    (m) => m.connection_status === 'connected' && (m.gateway_ping_fail_count ?? 0) === 0,
  );
  if (allConnected) return 'connected';
  return 'degraded';
}

function maxPingedAt(members: GatewayHealthMember[]): string | null {
  let max: number | null = null;
  for (const m of members) {
    if (!m.last_gateway_ping_at) continue;
    const t = new Date(m.last_gateway_ping_at).getTime();
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max != null ? new Date(max).toISOString() : null;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function GatewayHealthCard({ gatewayUrl, employees }: GatewayHealthCardProps) {
  const host = parseHost(gatewayUrl);
  const status = aggregateStatus(employees);
  const style = AGGREGATE_STYLES[status];
  const lastPingedAt = maxPingedAt(employees);
  const mostRecentError =
    [...employees]
      .filter((e) => !!e.connection_error)
      .sort((a, b) => {
        const aT = a.last_gateway_ping_at ? new Date(a.last_gateway_ping_at).getTime() : 0;
        const bT = b.last_gateway_ping_at ? new Date(b.last_gateway_ping_at).getTime() : 0;
        return bT - aT;
      })[0]?.connection_error ?? null;

  return (
    <div
      data-testid={`gateway-health-card-${host}`}
      className="px-4 py-3 rounded-lg"
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p
            className="text-[13px] font-semibold truncate"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            title={gatewayUrl}
          >
            {host}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
            {employees.length} employee{employees.length === 1 ? '' : 's'} · Last ping:{' '}
            {formatRelative(lastPingedAt)}
          </p>
        </div>
        <span
          data-testid={`gateway-health-status-${host}`}
          className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full font-medium flex-shrink-0"
          style={{
            background: `${style.color}26`,
            color: style.color,
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: style.color }}
          />
          {style.label}
        </span>
      </div>

      {mostRecentError && (
        <p
          className="text-[11px] mt-2 px-2 py-1 rounded"
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            color: '#ef4444',
            fontFamily: 'var(--font-mono, monospace)',
            wordBreak: 'break-word',
          }}
        >
          {mostRecentError}
        </p>
      )}

      <ul className="mt-3 space-y-1.5">
        {employees.map((m) => {
          const dot = MEMBER_DOT_COLORS[m.connection_status] ?? '#9ca3af';
          return (
            <li
              key={m.id}
              data-testid={`gateway-health-member-${m.slug}`}
              className="flex items-center gap-2 text-[12px]"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: dot }}
              />
              <span
                className="font-medium truncate"
                style={{ color: 'var(--foreground)' }}
              >
                {m.name}
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: 'var(--surface-container)',
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {m.slug}
              </span>
              {m.connection_error && (
                <span
                  className="text-[10px] truncate"
                  style={{ color: '#ef4444' }}
                  title={m.connection_error}
                >
                  {m.connection_error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
