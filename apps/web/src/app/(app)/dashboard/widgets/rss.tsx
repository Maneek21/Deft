'use client';
import { useState } from 'react';
import { Rss, ExternalLink, Settings2 } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type RssConfig = { url: string; name: string };

type FeedItem = { id: string; title: string; source: string; at: string };

// Deterministic demo items so the widget always has something to show while
// the sandboxed fetch bridge is being designed. Third-party widgets will
// replace this with a real `ctx.api.fetch(url)` call.
const DEMO_FEED: FeedItem[] = [
  { id: 'a', title: 'Vercel ships fluid compute for Node', source: 'vercel.com', at: '2h' },
  { id: 'b', title: 'Anthropic releases Claude Opus 4.7 with 1M context', source: 'anthropic.com', at: '5h' },
  { id: 'c', title: 'The state of React 19 in production', source: 'react.dev', at: '1d' },
  { id: 'd', title: 'Why small teams move faster than ever', source: 'every.to', at: '1d' },
];

function RssWidget({ config, onConfigChange }: WidgetProps<RssConfig>) {
  const [configuring, setConfiguring] = useState(false);
  const [url, setUrl] = useState(config?.url ?? '');
  const [name, setName] = useState(config?.name ?? '');

  const configured = !!(config?.url && config?.name);
  const displayName = config?.name || 'Demo feed';

  const save = () => {
    onConfigChange?.({ url: url.trim(), name: name.trim() || 'Feed' });
    setConfiguring(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
        fontSize: 11, color: 'var(--text-tertiary)',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>{displayName}</span>
        <button onClick={() => setConfiguring(v => !v)} onMouseDown={e => e.stopPropagation()} style={{
          display: 'grid', placeItems: 'center', width: 18, height: 18,
          borderRadius: 4, background: 'transparent', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer',
        }}>
          <Settings2 size={11} />
        </button>
      </div>

      {configuring && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: 8, marginBottom: 8, borderRadius: 7,
          background: 'var(--bg-primary)', border: '1px solid var(--border-default)',
        }}>
          <input value={name} onChange={e => setName(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            placeholder="Feed name"
            style={{
              fontSize: 11, padding: '5px 8px', borderRadius: 5,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', outline: 'none',
            }} />
          <input value={url} onChange={e => setUrl(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            placeholder="https://example.com/feed.xml"
            style={{
              fontSize: 11, padding: '5px 8px', borderRadius: 5,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', outline: 'none',
            }} />
          <button onClick={save} onMouseDown={e => e.stopPropagation()} style={{
            fontSize: 11, padding: '5px 10px', borderRadius: 5,
            background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer',
            alignSelf: 'flex-end',
          }}>Save</button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {DEMO_FEED.map(item => (
          <a key={item.id} href="#" onMouseDown={e => e.stopPropagation()}
            onClick={e => e.preventDefault()}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '7px 8px', marginLeft: -8, marginRight: -8,
              borderRadius: 6, textDecoration: 'none', color: 'inherit',
              transition: 'background 120ms',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.35,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>{item.title}</div>
              <div style={{
                fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {item.source} · {item.at}
              </div>
            </div>
            <ExternalLink size={10} strokeWidth={1.8}
              style={{ color: 'var(--text-tertiary)', marginTop: 3, flexShrink: 0 }} />
          </a>
        ))}
      </div>

      {!configured && (
        <div style={{
          marginTop: 6, padding: 6, borderRadius: 5,
          fontSize: 10, color: 'var(--text-tertiary)',
          background: 'var(--bg-primary)',
          border: '1px dashed var(--border-default)',
          lineHeight: 1.4, textAlign: 'center',
        }}>
          Third-party example · configure a feed to personalize
        </div>
      )}
    </div>
  );
}

export const rssDefinition: WidgetDefinition<RssConfig> = {
  apiVersion: 1,
  id: 'cairn.rss',
  title: 'Feed',
  description: 'External RSS / Atom feed — sample third-party widget.',
  icon: Rss,
  category: 'external',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 3 },
  defaultConfig: { url: '', name: '' },
  Component: RssWidget,
};
