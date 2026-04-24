'use client';
import Link from 'next/link';
import { AtSign } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';

function MentionsWidget(_props: WidgetProps) {
  const { core } = useDashboardData();

  // Mentions feed isn't surfaced by the facade yet — when it ships, it plugs
  // in here as a list of { space, author, snippet, at } items.
  const mentions: { id: string; space: string; author: string; snippet: string }[] = [];

  if (mentions.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', textAlign: 'center', padding: 12, color: 'var(--text-tertiary)',
      }}>
        <AtSign size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
        <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          No recent mentions.{core ? ' ' : ''}
          {core && core.unread_spaces.length > 0 && (
            <>You have{' '}
              <Link href="/chat" style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}>
                unread messages
              </Link>{' '}though.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {mentions.map(m => (
        <div key={m.id} style={{
          padding: 10, borderRadius: 8,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
            fontSize: 11, color: 'var(--text-tertiary)',
          }}>
            <AtSign size={10} strokeWidth={2} />
            {m.author} in {m.space}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.45 }}>
            {m.snippet}
          </div>
        </div>
      ))}
    </div>
  );
}

export const mentionsDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.mentions',
  title: 'Mentions',
  description: 'Messages that @ you across spaces.',
  icon: AtSign,
  category: 'activity',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: MentionsWidget,
};
