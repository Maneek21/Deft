'use client';
import Link from 'next/link';
import { Hash } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { initials } from '../lib/shared';
import { stripHtml } from '@/lib/strip-html';

function UnreadWidget(_props: WidgetProps) {
  const { core } = useDashboardData();
  if (!core) return null;
  if (core.unread_spaces.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>All caught up.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {core.unread_spaces.slice(0, 6).map(s => (
        <Link key={s.space_id} href="/chat" style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '7px 8px', marginLeft: -8, marginRight: -8,
          borderRadius: 7, textDecoration: 'none', color: 'inherit',
          transition: 'background 120ms',
        }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {s.space_type === 'dm' ? (
            <span style={{
              display: 'grid', placeItems: 'center', width: 22, height: 22,
              borderRadius: 6, flexShrink: 0,
              background: 'var(--accent-muted)', color: 'var(--accent)',
              fontSize: 9, fontWeight: 700,
            }}>{initials(s.space_name)}</span>
          ) : (
            <span style={{
              display: 'grid', placeItems: 'center', width: 22, height: 22,
              borderRadius: 6, flexShrink: 0,
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
            }}><Hash size={11} /></span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 12.5, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontWeight: 500,
            }}>{s.space_name}</div>
            {s.last_message && (
              <div style={{
                fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {s.last_message_by ? `${s.last_message_by.split(' ')[0]}: ` : ''}{stripHtml(s.last_message)}
              </div>
            )}
          </div>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
            minWidth: 18, height: 18, padding: '0 5px',
            display: 'grid', placeItems: 'center', borderRadius: 4,
            background: 'var(--accent-muted)', color: 'var(--accent)',
          }}>{s.unread_count}</span>
        </Link>
      ))}
    </div>
  );
}

export const unreadDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.unread',
  title: 'Unread',
  description: 'Channels and DMs with unread messages.',
  category: 'activity',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: UnreadWidget,
};
