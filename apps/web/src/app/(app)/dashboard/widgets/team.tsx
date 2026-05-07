'use client';
import { useState } from 'react';
import { Users, X } from 'lucide-react';
import type { WidgetDefinition, WidgetProps, WidgetContext } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import type { OneOnePrep } from '../lib/facade';
import { initials } from '../lib/shared';

function TeamWidget(_props: WidgetProps) {
  const { teamHealth, oneonePreps } = useDashboardData();
  const [prepModal, setPrepModal] = useState<OneOnePrep | null>(null);

  if (!teamHealth || teamHealth.healthCards.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>No team data.</p>;
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {teamHealth.healthCards.map(c => {
          const dot = c.status === 'green' ? 'var(--status-green)' :
            c.status === 'yellow' ? 'var(--status-amber)' : 'var(--status-red)';
          return (
            <div key={c.userId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                display: 'grid', placeItems: 'center', width: 22, height: 22,
                borderRadius: 5, flexShrink: 0,
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-secondary)', fontSize: 9, fontWeight: 700,
              }}>{initials(c.name)}</span>
              <span style={{
                fontSize: 12.5, color: 'var(--text-primary)', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{c.name}</span>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: dot }} />
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {c.activeTasks}t
              </span>
            </div>
          );
        })}
        {oneonePreps.length > 0 && (
          <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {oneonePreps.map(prep => (
              <button key={prep.id} onClick={() => setPrepModal(prep)}
                style={{
                  fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', textAlign: 'left',
                  color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                }}>
                <Users size={11} /> 1:1 prep · {prep.report_name}
              </button>
            ))}
          </div>
        )}
      </div>

      {prepModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget) setPrepModal(null); }}>
          <div style={{
            width: 'calc(100vw - 2rem)', maxWidth: 520, maxHeight: '90vh',
            padding: 20, borderRadius: 14, overflowY: 'auto',
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                1:1 Prep — {prepModal.report_name}
              </h3>
              <button onClick={() => setPrepModal(null)} style={{ padding: 4, color: 'var(--text-tertiary)' }}><X size={16} /></button>
            </div>
            {prepModal.prep_content && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {prepModal.prep_content.summary && (
                  <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Summary</span>
                    <p style={{ marginTop: 4 }}>{prepModal.prep_content.summary}</p></div>
                )}
                {prepModal.prep_content.wins?.length > 0 && (
                  <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Wins</span>
                    <ul style={{ marginTop: 4, paddingLeft: 16, listStyle: 'disc' }}>{prepModal.prep_content.wins.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.currentFocus?.length > 0 && (
                  <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Current focus</span>
                    <ul style={{ marginTop: 4, paddingLeft: 16, listStyle: 'disc' }}>{prepModal.prep_content.currentFocus.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.concerns?.length > 0 && (
                  <div><span style={{ fontWeight: 600, color: 'var(--status-amber)' }}>Concerns</span>
                    <ul style={{ marginTop: 4, paddingLeft: 16, listStyle: 'disc' }}>{prepModal.prep_content.concerns.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
                  </div>
                )}
                {prepModal.prep_content.talkingPoints?.length > 0 && (
                  <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Talking points</span>
                    <ul style={{ marginTop: 4, paddingLeft: 16, listStyle: 'disc' }}>{prepModal.prep_content.talkingPoints.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export const teamDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.team',
  title: 'Team',
  description: 'Team health signals, visible to managers.',
  category: 'team',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  visibleWhen: (ctx: WidgetContext) => ctx.user.role === 'owner' || ctx.user.role === 'admin',
  Component: TeamWidget,
};
