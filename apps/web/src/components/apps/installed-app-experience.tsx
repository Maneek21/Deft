'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { createExperienceBridge } from '@/lib/app-experience-bridge';
import { renderExperienceView, EXPERIENCE_RENDERER_CSS } from '@/lib/app-experience-renderer';
import { normalizeInstalledExperienceSession,
  type InstalledExperienceSession } from '@/lib/app-experience-session';
import { getSocket } from '@/lib/socket';

const root = '/api/app-experiences';
const livePath = (id: string) => `${root}/sessions/${encodeURIComponent(id)}/live`;

export function InstalledAppExperience({ installationId, experienceKey }: {
  installationId: string; experienceKey: string;
}) {
  const { user, org, sessionCacheScope } = useAuth();
  const [session, setSession] = useState<InstalledExperienceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const iframeHost = useRef<HTMLDivElement>(null);
  const viewHost = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);

  useLayoutEffect(() => {
    setSession(null);
    setError(null);
    setReady(false);
    viewHost.current?.replaceChildren();
    rendered.current = false;
    if (!user || !org || !sessionCacheScope) return;
    let cancelled = false;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/sessions`, {
          method: 'POST', signal: abort.signal,
        });
        if (!response.ok) throw new Error(await appApiError(response, 'This Experience is unavailable.'));
        const created = normalizeInstalledExperienceSession(await response.json());
        if (created.pin.org_id !== org.id || created.pin.user_id !== user.id
          || created.pin.app_installation_id !== installationId
          || created.experience.key !== experienceKey) throw new Error('Experience session identity changed.');
        if (!cancelled) { setSession(created); setReady(true); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'This Experience is unavailable.');
      }
    })();
    return () => { cancelled = true; abort.abort(); };
  }, [installationId, experienceKey, user?.id, org?.id, sessionCacheScope]);

  useEffect(() => {
    if (!session || !iframeHost.current || !viewHost.current || !sessionCacheScope) return;
    let stopped = false;
    const knownRunIds = new Set<string>();
    const port = new MessageChannel();
    const frame = document.createElement('iframe');
    frame.title = 'Isolated App Experience Worker';
    frame.sandbox.add('allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    const live = async () => {
      if (stopped || !api.getAccessToken()) return false;
      try {
        const response = await api.get(livePath(session.pin.session_id));
        return !stopped && response.ok;
      } catch { return false; }
    };
    let bridge: ReturnType<typeof createExperienceBridge>;
    bridge = createExperienceBridge({
      port: port.port1, pin: session.pin,
      resourceKeys: session.bundle.resource_keys,
      actionKeys: session.bundle.action_keys,
      broker: {
        isLive: live,
        async action(_pin, key, input, signal, requestId) {
          const response = await api.fetch(
            `${root}/sessions/${encodeURIComponent(session.pin.session_id)}/actions/${encodeURIComponent(key)}`,
            { method: 'POST', signal, body: JSON.stringify({ request_id: requestId, input }) },
          );
          if (!response.ok) throw new Error(await appApiError(response, 'Experience action unavailable.'));
          const body = await response.json() as { run?: { id?: unknown } };
          if (typeof body.run?.id === 'string') knownRunIds.add(body.run.id);
          return body.run;
        },
        async runStatus(_pin, input, signal) {
          const runId = input && typeof input === 'object' && !Array.isArray(input)
            ? (input as { run_id?: unknown }).run_id : null;
          if (typeof runId !== 'string' || !knownRunIds.has(runId)) return undefined;
          const response = await api.fetch(`/api/app-runs/${encodeURIComponent(runId)}`, { signal });
          if (!response.ok) return undefined;
          const body = await response.json() as { run?: unknown };
          return body.run;
        },
      },
      onView(view) {
        if (stopped || !viewHost.current) return;
        renderExperienceView(viewHost.current, view, (event) => { void bridge.sendUiEvent(event); });
        rendered.current = true;
      },
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      bridge.revoke();
      frame.remove();
      if (rendered.current && viewHost.current) viewHost.current.replaceChildren();
      rendered.current = false;
      setError('This Experience session ended. Reopen it to continue.');
    };
    let started = false;
    const onBootstrapReady = (event: MessageEvent) => {
      if (stopped || started || event.source !== frame.contentWindow || event.origin !== 'null'
        || !event.data || event.data.kind !== 'deft_experience_bootstrap_ready.v1'
        || !frame.contentWindow) return;
      started = true;
      frame.contentWindow.postMessage({ kind: 'start', session_id: session.pin.session_id,
        worker_source: session.bundle.worker_source }, '*', [port.port2]);
    };
    addEventListener('message', onBootstrapReady);
    frame.src = '/app-experience-bootstrap';
    iframeHost.current.append(frame);
    const poll = setInterval(() => { void live().then((current) => { if (!current) stop(); }); }, 5000);
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'deft-access-token' || event.key === 'deft-refresh-token') {
        void live().then((current) => { if (!current) stop(); });
      }
    };
    addEventListener('storage', onStorage);
    const token = api.getAccessToken();
    const socket = token ? getSocket(token) : null;
    const onAppChange = () => { void live().then((current) => { if (!current) stop(); }); };
    socket?.on('app:changed', onAppChange);
    return () => {
      clearInterval(poll);
      removeEventListener('message', onBootstrapReady);
      removeEventListener('storage', onStorage);
      socket?.off('app:changed', onAppChange);
      stopped = true;
      bridge.revoke();
      frame.remove();
      if (viewHost.current) viewHost.current.replaceChildren();
      rendered.current = false;
      void api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}`, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [session, sessionCacheScope]);

  return <div className="mx-auto w-full max-w-6xl px-3 py-5 sm:px-6">
    <style>{EXPERIENCE_RENDERER_CSS}</style>
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Installed App Experience</p>
        <h1 className="text-xl font-semibold">{session?.experience.label ?? 'Loading Experience'}</h1></div>
      <Link className="deft-pill min-h-11" href="/settings/apps">App settings</Link>
    </header>
    {error ? <p role="alert" className="rounded-xl p-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>{error}</p>
      : !ready ? <p role="status" className="rounded-xl p-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>Opening reviewed App Experience…</p>
      : null}
    <div ref={viewHost} className="min-h-[420px] overflow-hidden rounded-xl" aria-label="App Experience" />
    <div ref={iframeHost} aria-hidden="true" />
  </div>;
}
