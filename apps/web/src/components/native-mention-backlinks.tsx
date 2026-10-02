'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { nativeMentionRef, type NativeMentionKind } from '@deft/shared';
import { api } from '@/lib/api';
import { nativeMentionSessionKey } from '@/lib/native-mentions';
export function NativeMentionBacklinks({ kind, id }: { kind: NativeMentionKind; id: string }) {
  const [state, setState] = useState<{ key: string; items: Array<{ href: string; label: string }>; limited: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const update = async () => {
      const key = nativeMentionSessionKey();
      try {
        const response = await api.post('/api/native-mentions/backlinks', { ref: nativeMentionRef(kind, id) });
        if (!response.ok) return;
        const data = await response.json();
        if (live && key === nativeMentionSessionKey()) setState({ key, items: data.backlinks, limited: data.limited });
      } catch { /* Keep the source document usable if references are unavailable. */ }
    };
    void update();
    const timer = setInterval(() => { void update(); }, 10_000);
    window.addEventListener('focus', update);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', update); };
  }, [kind, id]);
  if (!state || state.key !== nativeMentionSessionKey() || !state.items.length) return null;
  return <section className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
    <h3 className="mb-2 text-xs font-medium">Mentioned in · {state.items.length}{state.limited ? '+' : ''}</h3>
    {state.items.map((item, i) => <Link key={item.href + i} href={item.href}
      className="block truncate py-1 text-sm hover:underline">{item.label}</Link>)}
  </section>;
}
