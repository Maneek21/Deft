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
  const [action, setAction] = useState(actions[0] ?? '');
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [mode, setMode] = useState<Policy['mode']>('deny');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const path = `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}/agent-policies/${encodeURIComponent(action)}`;
  useEffect(() => {
    let active = true;
    void (async () => {
      setPolicy(null); setNotice('');
      try {
        if (!action || document.hidden || !await ensureAuthority()) throw new Error();
        const response = await api.get(path);
        if (!response.ok) throw new Error();
        const value = parse(await response.json());
        if (active && !document.hidden) { setPolicy(value); setMode(value.mode); }
      } catch { if (active) setNotice('Agent permissions could not be loaded.'); }
    })();
    return () => { active = false; };
  }, [path, action, ensureAuthority, reload]);
  async function save() {
    if (!policy || busy || document.hidden) return;
    setBusy(true); setNotice('');
    try {
      if (!await ensureAuthority()) throw new Error();
      const response = await api.fetch(path, { method: 'PUT', body: JSON.stringify({ mode, expected_revision: policy.revision }) });
      if (!response.ok) throw new Error();
      const value = parse(await response.json()); setPolicy(value); setMode(value.mode); setNotice('Agent permission saved.');
    } catch { setNotice('The change could not be confirmed. Reload permissions before trying again.'); setPolicy(null); }
    finally { setBusy(false); }
  }
  if (!actions.length) return null;
  return <section aria-label="Agent action permissions" className="space-y-3 border-t pt-3">
    <p className="font-medium">Agent requests</p>
    <p>Choose whether agents can request an action. Every permitted request still needs your approval.</p>
    <label className="block">Action<select className="mt-1 min-h-11 w-full rounded border bg-transparent px-2" value={action} disabled={busy}
      onChange={event => { setAction(event.target.value); setPolicy(null); }}>
      {actions.map(key => <option key={key} value={key}>{key.replaceAll('_', ' ')}</option>)}
    </select></label>
    <label className="block">Permission<select className="mt-1 min-h-11 w-full rounded border bg-transparent px-2" value={mode} disabled={!policy || busy}
      onChange={event => setMode(event.target.value as Policy['mode'])}>
      <option value="deny">Do not allow agent requests</option><option value="require_approval">Require my approval for every request</option>
    </select></label>
    <button className="deft-pill min-h-11" disabled={!policy || busy || mode === policy.mode} onClick={() => void save()}>{busy ? 'Saving…' : 'Save agent permission'}</button>
    {notice && <p role="status">{notice}</p>}
    {!policy && notice && <button className="deft-pill min-h-11" onClick={() => setReload(value => value + 1)}>Reload permissions</button>}
  </section>;
}
