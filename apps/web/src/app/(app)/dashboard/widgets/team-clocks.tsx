'use client';
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import type { WidgetDefinition, WidgetProps, WidgetContext } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { initials } from '../lib/shared';

// Demo timezone assignment — rotates through common zones for visual variety
// until a `timezone` field is added to member profiles server-side.
const DEMO_TZS = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Tokyo',
];

function fmtTime(tz: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: false, timeZone: tz,
    }).format(now);
  } catch { return '—'; }
}

function fmtZoneShort(tz: string): string {
  // "America/New_York" -> "New York"
  const tail = tz.split('/').pop() ?? tz;
  return tail.replace(/_/g, ' ');
}

function TeamClocksWidget(_props: WidgetProps) {
  const { teamHealth } = useDashboardData();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const members = (teamHealth?.healthCards ?? []).slice(0, 8);

  if (members.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <Clock size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          No team data yet. Clocks will appear once team members are loaded.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {members.map((m, i) => {
        const tz = DEMO_TZS[i % DEMO_TZS.length];
        return (
          <div key={m.userId} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 8px', marginLeft: -8, marginRight: -8,
            borderRadius: 7,
          }}>
            <span style={{
              display: 'grid', placeItems: 'center', width: 22, height: 22,
              borderRadius: 6, flexShrink: 0,
              background: 'var(--accent-muted)', color: 'var(--accent)',
              fontSize: 9, fontWeight: 700,
            }}>{initials(m.name)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{m.name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                {fmtZoneShort(tz)}
              </div>
            </div>
            <span style={{
              fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600,
              color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
            }}>{fmtTime(tz, now)}</span>
          </div>
        );
      })}
    </div>
  );
}

const isManager = (ctx: WidgetContext) =>
  ctx.user.role === 'owner' || ctx.user.role === 'admin';

export const teamClocksDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.team-clocks',
  title: 'Team clocks',
  description: 'Current local time for each teammate.',
  icon: Clock,
  category: 'team',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 3, h: 3 },
  visibleWhen: isManager,
  Component: TeamClocksWidget,
};
