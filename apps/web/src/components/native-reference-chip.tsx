'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { nativeMentionRef, type NativeMentionKind } from '@deft/shared';
import { resolveNativeReference, nativeMentionSessionKey, type NativeProjection } from '@/lib/native-mentions';
import { UserProfileCard } from './user-profile-card';
import { useChatContext } from '@/lib/chat-context';

export function NativeReferenceChip({ kind, id }: { kind: NativeMentionKind; id: string }) {
  const ref = useMemo(() => nativeMentionRef(kind, id), [kind, id]);
  const [resolved, setResolved] = useState<{ key: string; item: NativeProjection } | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const { openDmWith } = useChatContext();
  const key = nativeMentionSessionKey();
  useEffect(() => {
    let live = true;
    const update = () => { const session = nativeMentionSessionKey();
      void resolveNativeReference(ref).then(item => { if (live) setResolved({ key: session, item }); }); };
    update();
    window.addEventListener('focus', update);
    const timer = setInterval(update, 30_000);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', update); };
  }, [ref]);
  const item = resolved?.key === key ? resolved.item : null;
  const css = 'inline-flex items-center rounded px-1 text-[0.95em] font-medium';
  const style = { background: 'var(--surface-container-high)', color: 'var(--text-primary)' };
  if (!item) return <span className={css} style={style}>@…</span>;
  if (item.state !== 'available') return <span className={css} style={style}>Unavailable reference</span>;
  if (item.href) return <Link className={css} style={style} href={item.href}>@{item.label}</Link>;
  return <span className={css} style={style}>
    <button type="button" onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}>@{item.label}</button>
    {item.group === 'Agents' && <button type="button" className="ml-1 text-xs opacity-70"
      title="Open a conversation to request work" onClick={() => { void openDmWith(id); }}>Request</button>}
    {anchor && createPortal(<UserProfileCard userId={id} anchorRect={anchor} onClose={() => setAnchor(null)} />, document.body)}
  </span>;
}
