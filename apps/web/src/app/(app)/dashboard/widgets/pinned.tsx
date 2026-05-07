'use client';
import Link from 'next/link';
import { Pin, Star, Bookmark } from 'lucide-react';
import { useState } from 'react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type Tab = 'tasks' | 'messages';

function PinnedWidget(_props: WidgetProps) {
  const [tab, setTab] = useState<Tab>('tasks');

  // Pinning data isn't surfaced by the facade yet — this widget renders an
  // empty state that matches what the feature will look like when it ships.
  const empty = true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', gap: 2, padding: 2, marginBottom: 10,
        borderRadius: 7, background: 'var(--bg-primary)',
        border: '1px solid var(--border-default)',
      }}>
        {(['tasks', 'messages'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} onMouseDown={e => e.stopPropagation()}
            style={{
              flex: 1, padding: '5px 8px', borderRadius: 5,
              fontSize: 11, fontWeight: 500,
              color: tab === t ? 'var(--text-primary)' : 'var(--text-tertiary)',
              background: tab === t ? 'var(--bg-surface)' : 'transparent',
              border: 'none', cursor: 'pointer',
              textTransform: 'capitalize',
            }}>{t}</button>
        ))}
      </div>

      {empty && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', color: 'var(--text-tertiary)', padding: 12,
        }}>
          {tab === 'tasks' ? (
            <>
              <Star size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
              <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Star a task from{' '}
                <Link href="/tasks" style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}>Tasks</Link>
                {' '}to pin it here.
              </p>
            </>
          ) : (
            <>
              <Bookmark size={18} strokeWidth={1.6} style={{ marginBottom: 8 }} />
              <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Save a message from{' '}
                <Link href="/chat" style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}>Chat</Link>
                {' '}to pin it here.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const pinnedDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.pinned',
  title: 'Pinned',
  description: 'Starred tasks and saved messages.',
  icon: Pin,
  category: 'work',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 3 },
  Component: PinnedWidget,
};
