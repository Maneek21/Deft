'use client';
import { useState } from 'react';
import { Link as LinkIcon, Plus, X as XIcon, ExternalLink } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

type LinkItem = { label: string; url: string };
type LinksConfig = { items: LinkItem[] };

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function faviconUrl(url: string): string | null {
  const h = hostname(url);
  if (!h || h === url) return null;
  return `https://www.google.com/s2/favicons?domain=${h}&sz=32`;
}

function LinksWidget({ config, onConfigChange }: WidgetProps<LinksConfig>) {
  const items = config?.items ?? [];
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');

  const add = () => {
    if (!label.trim() || !url.trim()) return;
    const u = url.startsWith('http') ? url : `https://${url}`;
    onConfigChange?.({ items: [...items, { label: label.trim(), url: u }] });
    setLabel(''); setUrl(''); setAdding(false);
  };

  const remove = (i: number) => {
    onConfigChange?.({ items: items.filter((_, idx) => idx !== i) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.length === 0 && !adding && (
        <div style={{
          padding: '20px 4px', textAlign: 'center',
          fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55,
        }}>
          No links yet.<br/>Add URLs you open often.
        </div>
      )}
      {items.map((l, i) => {
        const fav = faviconUrl(l.url);
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 8px', marginLeft: -8, marginRight: -8,
            borderRadius: 7,
            transition: 'background 120ms',
          }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <a href={l.url} target="_blank" rel="noopener noreferrer" onMouseDown={e => e.stopPropagation()}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                textDecoration: 'none', color: 'inherit',
              }}>
              {fav ? (
                <img src={fav} alt="" width={16} height={16} style={{ borderRadius: 3, flexShrink: 0 }} />
              ) : (
                <span style={{
                  display: 'grid', placeItems: 'center', width: 16, height: 16,
                  borderRadius: 3, background: 'var(--bg-primary)',
                  border: '1px solid var(--border-default)', flexShrink: 0,
                }}>
                  <LinkIcon size={9} strokeWidth={2} style={{ color: 'var(--text-tertiary)' }} />
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{l.label}</div>
                <div style={{
                  fontSize: 10.5, color: 'var(--text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{hostname(l.url)}</div>
              </div>
              <ExternalLink size={11} strokeWidth={1.8} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            </a>
            <button onClick={() => remove(i)} onMouseDown={e => e.stopPropagation()} style={{
              display: 'grid', placeItems: 'center', width: 18, height: 18,
              borderRadius: 4, background: 'transparent', border: 'none',
              color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
            }}><XIcon size={11} /></button>
          </div>
        );
      })}

      {adding ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: 8, marginTop: 4, borderRadius: 7,
          background: 'var(--bg-primary)', border: '1px solid var(--border-default)',
        }}>
          <input value={label} onChange={e => setLabel(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            placeholder="Label (e.g. Docs)"
            style={{
              fontSize: 12, padding: '6px 8px', borderRadius: 5,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', outline: 'none',
            }} />
          <input value={url} onChange={e => setUrl(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            placeholder="https://…"
            style={{
              fontSize: 12, padding: '6px 8px', borderRadius: 5,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', outline: 'none',
            }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setAdding(false); setLabel(''); setUrl(''); }}
              onMouseDown={e => e.stopPropagation()} style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 5,
                background: 'transparent', color: 'var(--text-secondary)',
                border: '1px solid var(--border-default)', cursor: 'pointer',
              }}>Cancel</button>
            <button onClick={add} onMouseDown={e => e.stopPropagation()} style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 5,
              background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer',
            }}>Add</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} onMouseDown={e => e.stopPropagation()} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '8px 10px', marginTop: 4, borderRadius: 7,
          background: 'transparent', color: 'var(--text-tertiary)',
          border: '1px dashed var(--border-default)', cursor: 'pointer',
          fontSize: 11, fontWeight: 500,
        }}>
          <Plus size={12} strokeWidth={1.8} /> Add link
        </button>
      )}
    </div>
  );
}

export const linksDefinition: WidgetDefinition<LinksConfig> = {
  apiVersion: 1,
  id: 'deft.links',
  title: 'Links',
  description: 'Quick launcher for URLs you open often.',
  icon: LinkIcon,
  category: 'external',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 3 },
  defaultConfig: { items: [] },
  Component: LinksWidget,
};
