'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Policy = { mode: 'deny' | 'require_approval'; revision: number };
const parse = (value: unknown): Policy => {
  if (!value || typeof value !== 'object' || !('mode' in value) || !('revision' in value)
    || !['deny', 'require_approval'].includes(String(value.mode)) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0) throw new Error('Invalid agent permission.');
  return { mode: value.mode as Policy['mode'], revision: Number(value.revision) };
};

export function ExperienceAgentPolicy({ sessionId, actions, ensureAuthority }: {
  sessionId: string; actions: readonly string[]; ensureAuthority: () => Promise<boolean>;
}) {
  const [policies, setPolicies] = useState<Record<string, Policy>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setNotice(''); setLoaded(false);
    void (async () => {
      try {
        if (document.hidden || !await ensureAuthority()) throw new Error();
        const entries = await Promise.all(actions.map(async (action) => {
          const path = `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}/agent-policies/${encodeURIComponent(action)}`;
          const response = await api.get(path);
          if (!response.ok) throw new Error();
          return [action, parse(await response.json())] as const;
        }));
        if (active && !document.hidden) { setPolicies(Object.fromEntries(entries)); setLoaded(true); }
      } catch { if (active) setNotice('Agent permissions could not be loaded.'); }
    })();
    return () => { active = false; };
  }, [sessionId, actions.join('\u0000'), ensureAuthority, reload]);

  async function save(action: string, mode: Policy['mode']) {
    const policy = policies[action];
    if (busy[action] || document.hidden) return;
    setBusy(value => ({ ...value, [action]: true })); setNotice('');
    try {
      if (!await ensureAuthority()) throw new Error();
      const path = `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}/agent-policies/${encodeURIComponent(action)}`;
      const response = await api.fetch(path, { method: 'PUT', body: JSON.stringify({ mode, expected_revision: policy?.revision ?? 0 }) });
      if (!response.ok) throw new Error();
      const value = parse(await response.json());
      setPolicies(current => ({ ...current, [action]: value }));
      setNotice('Agent permission saved.');
    } catch {
      setNotice('The change could not be confirmed. Reload permissions before trying again.');
      setPolicies(current => { const next = { ...current }; delete next[action]; return next; });
    } finally {
      setBusy(value => ({ ...value, [action]: false }));
    }
  }

  if (!actions.length) return null;
  return <section aria-label="Agent action permissions" className="space-y-4 pt-5">
    <p className="font-medium">Agent requests</p>
    <p>Choose whether agents can request each action. Every permitted request still needs your approval.</p>
    <ul className="space-y-1">
      {actions.map(action => {
        const allowed = policies[action]?.mode === 'require_approval';
        return <li key={action}>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={allowed} disabled={!loaded || busy[action]}
              onChange={event => void save(action, event.target.checked ? 'require_approval' : 'deny')} />
            <span>{action.replaceAll('_', ' ')}</span>
          </label>
        </li>;
      })}
    </ul>
    {notice && <p role="status">{notice}</p>}
    {!loaded && notice && <button className="deft-pill min-h-11" onClick={() => setReload(value => value + 1)}>Reload permissions</button>}
  </section>;
}
