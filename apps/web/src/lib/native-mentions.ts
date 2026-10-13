'use client';
import { api } from './api';
import { useEffect, useState } from 'react';
import { type NativeMentionRef, type NativeMentionSource, nativeMentionKey } from '@deft/shared';

export type NativeProjection = {
  ref: NativeMentionRef; state: 'available' | 'unavailable'; label?: string; href?: string;
  group?: 'People' | 'Agents' | 'Tasks' | 'Wikis' | 'Channel'; avatar_url?: string | null; description?: string | null;
  broadcast?: 'here' | 'all';
};
export function nativeMentionSessionKey() {
  if (typeof window === 'undefined') return '';
  const token = localStorage.getItem('deft-access-token') ?? '';
  try {
    const segment = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
    return [data.id, data.org_id, data.sid].join(':');
  } catch { return token; }
}
let capabilities = { key: '', enabled: false, pending: null as Promise<boolean> | null };
export function nativeMentionsAvailable() {
  const key = nativeMentionSessionKey();
  if (!key) return false;
  if (capabilities.key !== key) {
    const entry = { key, enabled: false, pending: null as Promise<boolean> | null };
    capabilities = entry;
    entry.pending = api.get('/api/native-mentions/capabilities').then(async r => {
      entry.enabled = r.ok && (await r.json()).enabled === true;
      window.dispatchEvent(new Event('deft-native-mention-capability'));
      return entry.enabled;
    }).catch(() => false);
  }
  return capabilities.enabled;
}
export function useNativeMentionsCapability() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const update = () => setEnabled(nativeMentionsAvailable());
    update();
    window.addEventListener('deft-native-mention-capability', update);
    window.addEventListener('focus', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('deft-native-mention-capability', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return enabled;
}
export async function searchNativeReferences(query: string): Promise<NativeProjection[]> {
  const key = nativeMentionSessionKey();
  const r = await api.get('/api/native-mentions/search?q=' + encodeURIComponent(query));
  if (!r.ok) throw new Error('Could not load references. Try typing again.');
  const result = await r.json();
  return nativeMentionSessionKey() === key ? result.items : [];
}
type Pending = { ref: NativeMentionRef; key: string; done: (value: NativeProjection) => void };
let pending: Pending[] = [];
export function resolveNativeReference(ref: NativeMentionRef): Promise<NativeProjection> {
  return new Promise(done => {
    pending.push({ ref, key: nativeMentionSessionKey(), done });
    if (pending.length !== 1) return;
    queueMicrotask(async () => {
      const batch = pending; pending = [];
      const key = nativeMentionSessionKey();
      const unique = [...new Map(batch.filter(x => x.key === key).map(x => [nativeMentionKey(x.ref), x.ref])).values()];
      const results = new Map<string, NativeProjection>();
      try {
        for (let i = 0; i < unique.length; i += 100) {
          const r = await api.post('/api/native-mentions/resolve', { refs: unique.slice(i, i + 100) });
          if (r.ok) for (const item of (await r.json()).items as NativeProjection[]) results.set(nativeMentionKey(item.ref), item);
        }
      } catch { /* Unavailable chips never reuse an old authorized label. */ }
      for (const item of batch) item.done(key === item.key && nativeMentionSessionKey() === key
        ? results.get(nativeMentionKey(item.ref)) ?? { ref: item.ref, state: 'unavailable' }
        : { ref: item.ref, state: 'unavailable' });
    });
  });
}
export async function publishSavedNativeMentions(source: NativeMentionSource, content: string) {
  const key = nativeMentionSessionKey();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const r = await api.post('/api/native-mentions/publish', { source, content_hash: hash });
  const data = await r.json();
  if (nativeMentionSessionKey() !== key) throw new Error('Workspace changed. Reopen this document.');
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? 'Could not publish mentions. Save and retry.');
  return data as { queued_count: number; blocked_count: number };
}
