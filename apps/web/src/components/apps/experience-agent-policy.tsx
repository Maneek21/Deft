'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';

type Mode = 'deny' | 'require_approval';
type Policy = { mode: Mode; revision: number };
type RowState = Policy & { state: 'loading' | 'ready' | 'saving' | 'saved' | 'error' };

const MODES: readonly Mode[] = ['deny', 'require_approval'];

const parse = (value: unknown): Policy => {
  if (!value || typeof value !== 'object' || !('mode' in value) || !('revision' in value)
    || !MODES.includes(String(value.mode) as Mode) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0) throw new Error('Invalid agent permission.');
  return { mode: value.mode as Mode, revision: Number(value.revision) };
};

/** App-neutral action label. The Host never supplies display copy for a declared action. */
export function agentActionLabel(key: string) {
  const words = key.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function agentPolicyPath(sessionId: string, action: string) {
  return `/api/app-experiences/sessions/${encodeURIComponent(sessionId)}/agent-policies/${encodeURIComponent(action)}`;
}

/** One row change saves immediately with the revision loaded for that action. */
export async function saveAgentPolicy(input: {
  sessionId: string; action: string; mode: Mode; revision: number;
  ensureAuthority: () => Promise<boolean>;
  request?: (path: string, init: RequestInit) => Promise<Response>;
}) {
  if (!await input.ensureAuthority()) throw new Error('Agent permission could not be confirmed.');
  const response = await (input.request ?? api.fetch)(agentPolicyPath(input.sessionId, input.action), {
    method: 'PUT', body: JSON.stringify({ mode: input.mode, expected_revision: input.revision }),
  });
  if (!response.ok) throw new Error('Agent permission could not be confirmed.');
  return parse(await response.json());
}

function noticeFor(row: RowState | undefined) {
  if (!row) return '';
  if (row.state === 'loading') return 'Loading…';
  if (row.state === 'saving') return 'Saving…';
  if (row.state === 'saved') return 'Saved';
  if (row.state === 'error') return 'Could not save';
  return '';
}

export function ExperienceAgentPolicy({ sessionId, actions, ensureAuthority }: {
  sessionId: string; actions: readonly string[]; ensureAuthority: () => Promise<boolean>;
}) {
  const id = useId();
  const actionKey = actions.join('\u0000');
  const initial = () => Object.fromEntries(actions.map(key => [key, { mode: 'deny', revision: 0, state: 'loading' } satisfies RowState]));
  const [rows, setRows] = useState<Record<string, RowState>>(initial);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!actionKey || typeof document !== 'undefined' && document.hidden) return;
    let active = true;
    const keys = actionKey.split('\u0000');
    void (async () => {
      try {
        if (!await ensureAuthority() || typeof document !== 'undefined' && document.hidden) throw new Error('Authority unavailable');
        const values = await Promise.all(keys.map(async key => {
          const response = await api.get(agentPolicyPath(sessionId, key));
          if (!response.ok) throw new Error('Agent permission could not be loaded.');
          return [key, parse(await response.json())] as const;
        }));
        if (active && !(typeof document !== 'undefined' && document.hidden)) {
          setRows(Object.fromEntries(values.map(([key, value]) => [key, { ...value, state: 'ready' } satisfies RowState])));
          setFailed(false);
        }
      } catch {
        if (active) {
          setFailed(true);
          setRows(previous => Object.fromEntries(keys.map(key => [key, { ...(previous[key] ?? { mode: 'deny', revision: 0 }), state: 'error' }])));
        }
      }
    })();
    return () => { active = false; };
  }, [actionKey, ensureAuthority, sessionId, reload]);

  async function change(key: string, next: Mode) {
    const row = rows[key];
    if (!row || row.state === 'loading' || row.state === 'saving') return;
    setRows(previous => ({ ...previous, [key]: { ...previous[key], mode: next, state: 'saving' } }));
    try {
      const value = await saveAgentPolicy({ sessionId, action: key, mode: next, revision: row.revision, ensureAuthority });
      setRows(previous => ({ ...previous, [key]: { ...value, state: 'saved' } }));
    } catch {
      setRows(previous => ({ ...previous, [key]: { ...previous[key], mode: next, state: 'error' } }));
    }
  }

  if (!actions.length) return null;
  const needsReload = failed || Object.values(rows).some(row => row.state === 'error');
  return <section aria-label="Agent action permissions" className="space-y-3">
    <ul className="space-y-2">
      {actions.map(key => {
        const label = agentActionLabel(key), row = rows[key];
        const notice = failed && row?.state === "error" ? "Couldn't load" : noticeFor(row), controlId = `${id}-${key}`;
        return <li key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--surface-container-low)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <label htmlFor={controlId} className="block text-sm font-medium">{label}</label>
            <p role="status" className="mt-0.5 text-xs" style={{ color: notice === "Couldn't load" || notice === 'Could not save' ? 'var(--error)' : 'var(--text-secondary)' }}>
              {notice}{row?.state === 'error' && (failed ? <button type="button" className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4" onClick={() => setReload(value => value + 1)}>Retry</button> : <button type="button" className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4" onClick={() => void change(key, row.mode)}>Retry</button>)}
            </p>
          </div>
          <select id={controlId} aria-label={`${label} permission`} className="min-h-11 w-full rounded-xl border border-transparent bg-[var(--surface-container-high)] px-3 text-sm focus-visible:ring-2 focus-visible:ring-[var(--primary)] sm:w-auto"
            value={row?.mode ?? 'deny'} disabled={!row || row.state === 'loading' || row.state === 'saving'}
            onChange={event => void change(key, event.target.value as Mode)}>
            <option value="deny">Do not allow</option>
            <option value="require_approval">Require my approval</option>
          </select>
        </li>;
      })}
    </ul>
    {needsReload && <button type="button" className="deft-pill min-h-11" onClick={() => setReload(value => value + 1)}>Reload permissions</button>}
    {failed && <p role="status" className="text-xs" style={{ color: 'var(--text-secondary)' }}>Agent permissions could not be loaded. Reload permissions before changing them.</p>}
  </section>;
}
