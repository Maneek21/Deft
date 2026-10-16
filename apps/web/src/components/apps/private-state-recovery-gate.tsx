'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { experienceAuthorityResponse, ExperienceAuthorityUnavailable } from '@/lib/app-experience-connection';
import { api, isSameWebSession, SessionRefreshUnavailableError } from '@/lib/api';
import { PrivateStateAdoption, PrivateStateAdoptionContext } from './private-state-adoption';
import type { ExperienceExposureStatus } from '@/lib/app-experience-session';

type Recovery = { key: string; label: string; context: ReturnType<typeof PrivateStateAdoptionContext.parse> };

/** Runs before App code can mistake prior-artifact state for an empty collection. */
export function PrivateStateRecoveryGate({ sessionId, exposure, states, onContinue, suspended = false }: {
  sessionId: string; exposure: ExperienceExposureStatus; states: readonly { key: string; label: string }[];
  onContinue: () => void; suspended?: boolean;
}) {
  const [recovery, setRecovery] = useState<Recovery[]>([]), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const retryable = useRef(false);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const request = useCallback(async (key: string, operation: 'context' | 'review' | 'activate', body: unknown) => {
    const signal = controller.current?.signal, token = api.getAccessToken(), stamp = generation.current;
    const live = () => !!token && isSameWebSession(token, api.getAccessToken()) && !document.hidden
      && !signal?.aborted && stamp === generation.current && Date.parse(exposure.expires_at) > Date.now();
    if (!live()) throw new Error('Recovery unavailable');
    const response = await api.fetch(`/api/app-experiences/sessions/${encodeURIComponent(sessionId)}/state/${encodeURIComponent(key)}/adoption/${operation}`,
      { method: 'POST', signal, body: JSON.stringify(body) });
    if (experienceAuthorityResponse(response) === 'unavailable') throw new ExperienceAuthorityUnavailable();
    if (!response.ok) throw new Error('Recovery unavailable');
    const value: unknown = await response.json();
    if (!live() || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery unavailable');
    const result = value as Record<string, unknown>;
    if (Object.keys(result).sort().join(',') !== 'exposure_epoch,exposure_id,output'
      || result.exposure_id !== exposure.exposure_id || result.exposure_epoch !== exposure.exposure_epoch) throw new Error('Recovery unavailable');
    return result;
  }, [sessionId, exposure]);
  const load = useCallback(async () => {
    controller.current?.abort(); controller.current = new AbortController(); const stamp = ++generation.current;
    if (document.hidden || suspended) return;
    retryable.current = false; setBusy(true); setError(''); setRecovery([]);
    try {
      const found: Recovery[] = [];
      for (const state of states) {
        const result = await request(state.key, 'context', {});
        const context = PrivateStateAdoptionContext.parse(result.output);
        if (context.groups.length) found.push({ ...state, context });
      }
      if (stamp !== generation.current) return;
      setRecovery(found); if (!found.length) onContinue();
    } catch (cause) { if (stamp === generation.current) {
      retryable.current = cause instanceof ExperienceAuthorityUnavailable || cause instanceof SessionRefreshUnavailableError || cause instanceof TypeError;
      setError(retryable.current ? 'Connection interrupted. Reconnecting...' : 'Saved-state recovery could not be checked. Retry before opening this app.');
    } }
    finally { if (stamp === generation.current) setBusy(false); }
  }, [request, states, onContinue, suspended]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void load(); });
    const clear = () => { generation.current++; controller.current?.abort(); setRecovery([]); setBusy(false); setError('Private access ended. Reopen the app to continue.'); };
    const hidden = () => { if (document.hidden) { generation.current++; controller.current?.abort(); setRecovery([]); setBusy(false); } else void load(); };
    const timer = setInterval(() => { if (retryable.current && !document.hidden && !suspended) void load(); }, 5000);
    const online = () => { if (retryable.current) void load(); }; addEventListener('online', online);
    const expiry = setTimeout(clear, Math.max(0, Math.min(Date.parse(exposure.expires_at) - Date.now(), 2147483647)));
    document.addEventListener('visibilitychange', hidden);
    return () => { active = false; generation.current++; controller.current?.abort(); clearTimeout(expiry); clearInterval(timer); removeEventListener('online', online); document.removeEventListener('visibilitychange', hidden); };
  }, [load, exposure.expires_at, suspended]);
  if (suspended) return null;
  return <div className="min-h-0 overflow-y-auto" aria-label="Private App state recovery">
    {busy && <p role="status" className="px-5 py-4 text-sm">Checking your saved app state…</p>}
    {error && <div className="px-5 py-4"><p role="alert" className="text-sm">{error}</p><button className="deft-pill mt-3 min-h-11" onClick={() => void load()}>Retry recovery check</button></div>}
    {!busy && !error && recovery.map(state => <PrivateStateAdoption key={state.key} label={state.label} groups={state.context.groups}
      request={(operation, body) => request(state.key, operation, body)} onAdopted={() => void load()} />)}
    {!busy && !error && recovery.length > 0 && <div className="px-5 py-4"><p className="text-sm">You can continue without recovery. Previous records stay private to their old version until they expire.</p>
      <button className="deft-pill mt-3 min-h-11" onClick={onContinue}>Continue without recovery</button></div>}
  </div>;
}
