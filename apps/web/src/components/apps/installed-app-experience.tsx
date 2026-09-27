'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Paperclip, ShieldCheck, Settings2, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { createExperienceBridge } from '@/lib/app-experience-bridge';
import { renderExperienceView, EXPERIENCE_RENDERER_CSS } from '@/lib/app-experience-renderer';
import { normalizeInstalledExperienceSession, experienceLifetimeIsCurrent,
  normalizeExperienceExposureStatus, normalizeExperienceExposureReview, type ExperienceExposureStatus,
  type ExperienceExposureReview, type InstalledExperienceSession } from '@/lib/app-experience-session';
import { getSocket } from '@/lib/socket';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';

const root = '/api/app-experiences';
const livePath = (id: string) => `${root}/sessions/${encodeURIComponent(id)}/live`;
// A known session belongs to this page even before its Worker starts. Keep the
// bounded, bodyless retirement request alive when the document is unloading.
const retireSession = (id: string) => api.fetch(`${root}/sessions/${encodeURIComponent(id)}`, {
  method: 'DELETE', keepalive: true,
}).catch(() => undefined);

export function InstalledAppExperience({ installationId, experienceKey }: {
  installationId: string; experienceKey: string;
}) {
  const { user, org, sessionCacheScope } = useAuth();
  const [session, setSession] = useState<InstalledExperienceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [opening, setOpening] = useState(0);
  const [review, setReview] = useState<ExperienceExposureReview | null>(null);
  const [exposure, setExposure] = useState<ExperienceExposureStatus | null>(null);
  const [exposureBusy, setExposureBusy] = useState(false);
  const reviewGeneration = useRef(0);
  const stopWorker = useRef<((retireSession?: boolean) => void) | null>(null);
  const iframeHost = useRef<HTMLDivElement>(null);
  const viewHost = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);

  useLayoutEffect(() => {
    stopWorker.current?.();
    setSession(null);
    setError(null);
    setReady(false);
    setReview(null); setExposure(null); setExposureBusy(false); reviewGeneration.current += 1;
    viewHost.current?.replaceChildren();
    rendered.current = false;
    if (!user || !org || !sessionCacheScope) return;
    let cancelled = false;
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 15_000);
    let ownedSessionId: string | null = null;
    const retireOwnedSession = () => {
      if (!ownedSessionId) return;
      const id = ownedSessionId;
      ownedSessionId = null;
      void retireSession(id);
    };
    const pageHide = () => {
      cancelled = true;
      abort.abort();
      stopWorker.current?.();
      retireOwnedSession();
    };
    addEventListener('pagehide', pageHide);
    void (async () => {
      try {
        // Effect replay can deactivate this owner before any request is needed.
        await Promise.resolve();
        if (cancelled || document.hidden) return;
        const response = await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/sessions`, {
          method: 'POST', signal: abort.signal,
        });
        if (!response.ok) throw new Error(await appApiError(response, 'This Experience is unavailable.'));
        const created = normalizeInstalledExperienceSession(await response.json());
        ownedSessionId = created.pin.session_id;
        if (created.pin.org_id !== org.id || created.pin.user_id !== user.id
          || created.pin.app_installation_id !== installationId
          || created.experience.key !== experienceKey) throw new Error('Experience session identity changed.');
        if (!cancelled && !document.hidden) { setSession(created); setReady(true); }
        else {
          retireOwnedSession();
          if (!cancelled) setError('This Experience session ended. Reopen it to continue.');
        }
      } catch (cause) {
        retireOwnedSession();
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'This Experience is unavailable.');
      } finally { clearTimeout(deadline); }
    })();
    return () => {
      // Consume an already dispatched response while this document remains alive
      // so its exact session can be retired rather than abandoned.
      cancelled = true; removeEventListener('pagehide', pageHide);
      stopWorker.current?.(); retireOwnedSession();
      reviewGeneration.current += 1; setReview(null); setExposure(null);
    };
  }, [installationId, experienceKey, user?.id, org?.id, sessionCacheScope, opening]);

  const prepareExposure = async () => {
    if (!session || document.hidden) return;
    const generation = ++reviewGeneration.current;
    setExposureBusy(true); setReview(null); setError(null);
    try {
      const response = await api.post(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure/review`, {});
      if (!response.ok) throw new Error(await appApiError(response, 'Private access review is unavailable.'));
      const prepared = normalizeExperienceExposureReview(await response.json());
      if (generation === reviewGeneration.current && !document.hidden) setReview(prepared);
    } catch (reason) { if (generation === reviewGeneration.current) setError(reason instanceof Error ? reason.message : 'Private access review is unavailable.'); }
    finally { if (generation === reviewGeneration.current) setExposureBusy(false); }
  };
  const acceptExposure = async () => {
    if (!session || !review || document.hidden) return;
    const generation = ++reviewGeneration.current;
    setExposureBusy(true); setError(null);
    const expectedDigest = review.review_digest;
    try {
      let accepted: ExperienceExposureStatus;
      try {
        const response = await api.post(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure/accept`, {
          review_token: review.review_token, review_digest: expectedDigest, accept_exposure: true });
        if (!response.ok) throw new Error(await appApiError(response, 'Unable to accept private access.'));
        accepted = normalizeExperienceExposureStatus(await response.json());
      } catch (reason) {
        // A committed acceptance may lose its response. Read safe status only;
        // never retry the authority-changing request automatically.
        const recovered = await api.get(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`);
        if (!recovered.ok) throw reason;
        accepted = normalizeExperienceExposureStatus(await recovered.json());
      }
      if (accepted.review_digest !== expectedDigest || new Date(accepted.expires_at).getTime() <= Date.now()) throw new Error('Private access review expired; reopen the Experience.');
      if (generation === reviewGeneration.current && !document.hidden) { setExposure(accepted); setReview(null); }
      else {
        // Acceptance can commit after this page has retired. Keep its authority
        // out of a later Worker lifetime and retire the exact old session.
        await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
        await retireSession(session.pin.session_id);
      }
    } catch (reason) { if (generation === reviewGeneration.current) { setReview(null); setError(reason instanceof Error ? reason.message : 'Unable to accept private access.'); } }
    finally { if (generation === reviewGeneration.current) setExposureBusy(false); }
  };
  const withdrawExposure = async () => {
    if (!session) return;
    const generation = ++reviewGeneration.current; setExposureBusy(true); setReview(null);
    stopWorker.current?.(false);
    setError('Private access ended. Reopen this Experience to review a new session.');
    await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    if (generation === reviewGeneration.current) { setExposure(null); setExposureBusy(false); }
  };

  useEffect(() => {
    if (!session || !iframeHost.current || !viewHost.current || !sessionCacheScope
      || document.hidden || !experienceLifetimeIsCurrent(session.expires_at, exposure?.expires_at)
      || (session.bundle.resource_keys.length > 0 && !exposure)) return;
    let stopped = false;
    const generation = reviewGeneration.current;
    const locallyCurrent = () => !stopped && generation === reviewGeneration.current && !document.hidden
      && !!api.getAccessToken() && experienceLifetimeIsCurrent(session.expires_at, exposure?.expires_at);
    const knownRunIds = new Set<string>();
    const port = new MessageChannel();
    const frame = document.createElement('iframe');
    frame.title = 'Isolated App Experience Worker';
    frame.sandbox.add('allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    const live = async () => {
      if (!locallyCurrent()) return false;
      try {
        if (document.hidden || new Date(session.expires_at).getTime() <= Date.now()
          || (exposure && new Date(exposure.expires_at).getTime() <= Date.now())) return false;
        const response = await api.get(livePath(session.pin.session_id));
        if (stopped || !response.ok) return false;
        if (exposure) {
          const status = await api.get(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`);
          if (!status.ok || stopped) return false;
          const current = normalizeExperienceExposureStatus(await status.json());
          return locallyCurrent() && current.exposure_id === exposure.exposure_id && current.exposure_epoch === exposure.exposure_epoch
            && current.review_digest === exposure.review_digest && current.expires_at === exposure.expires_at;
        }
        return locallyCurrent();
      } catch { return false; }
    };
    let bridge: ReturnType<typeof createExperienceBridge>;
    bridge = createExperienceBridge({
      port: port.port1, pin: session.pin,
      resourceKeys: session.bundle.resource_keys,
      actionKeys: session.bundle.action_keys,
      broker: {
        isLive: live,
        async resource(_pin, key, input, signal) {
          if (!exposure || !locallyCurrent()) return undefined;
          const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/resources/${encodeURIComponent(key)}`,
            { method: 'POST', signal, body: JSON.stringify(input) });
          const body = await response.json() as { exposure_id?: string; exposure_epoch?: number; output?: unknown; code?: string };
          if (!response.ok) {
            if (body.code === 'RESOURCE_PAYLOAD_TOO_LARGE' || body.code === 'RESOURCE_CURSOR_STALE') throw new Error(body.code);
            return undefined;
          }
          if (!locallyCurrent() || signal.aborted || body.exposure_id !== exposure.exposure_id || body.exposure_epoch !== exposure.exposure_epoch) return undefined;
          return body.output;
        },
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
        if (!locallyCurrent() || !viewHost.current) return;
        renderExperienceView(viewHost.current, view, (event) => { void bridge.sendUiEvent(event); });
        rendered.current = true;
      },
    });
    const stop = (retireSession = true) => {
      if (stopped) return;
      stopped = true;
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (rendered.current && viewHost.current) viewHost.current.replaceChildren();
      rendered.current = false;
      setError('This Experience session ended. Reopen it to continue.');
      if (retireSession) void api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
    stopWorker.current = stop;
    let started = false;
    const onBootstrapReady = (event: MessageEvent) => {
      if (!locallyCurrent() || started || event.source !== frame.contentWindow || event.origin !== 'null'
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
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden);
    const pageHide = () => stop();
    addEventListener('pagehide', pageHide);
    const expiry = setTimeout(() => stop(), Math.max(0, Math.min(new Date(session.expires_at).getTime(),
      exposure ? new Date(exposure.expires_at).getTime() : Infinity) - Date.now()));
    return () => {
      clearInterval(poll);
      removeEventListener('message', onBootstrapReady);
      removeEventListener('storage', onStorage);
      socket?.off('app:changed', onAppChange);
      document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', pageHide); clearTimeout(expiry);
      stopped = true;
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (viewHost.current) viewHost.current.replaceChildren();
      rendered.current = false;
      stopWorker.current = null;
      void retireSession(session.pin.session_id);
    };
  }, [session, sessionCacheScope, exposure]);

  useEffect(() => {
    const clear = () => { reviewGeneration.current += 1; setReview(null); setExposureBusy(false); stopWorker.current?.(); };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hidden); addEventListener('pagehide', clear);
    return () => { clear(); document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', clear); };
  }, []);

  return <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
    <style>{EXPERIENCE_RENDERER_CSS}</style>
    <h1 className="sr-only">{session?.experience.label ?? 'Opening app…'}</h1>
    {error ? <p role="alert" className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>{error}</p>
      : !ready ? <p role="status" className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>Opening app…</p>
      : null}
    {session && session.bundle.resource_keys.length > 0 && !(exposure && !error) && <section aria-label="Experience private access" className="mx-auto w-full max-w-3xl shrink-0 space-y-4 overflow-y-auto px-5 py-6 text-sm" style={{ maxHeight: 'calc(100% - 100px)' }}>
      {review ? <><h2 className="text-lg font-semibold">Allow private fields for this Experience?</h2>
          <p>Allow this Experience’s App code to read the listed saved private fields for this session, until {new Date(review.snapshot.expires_at).toLocaleString()}? It can process and display these records. Ending access stops future reads; previously delivered content cannot be recalled.</p>
          <dl className="space-y-2"><div><dt>App</dt><dd>{review.snapshot.app_name} {review.snapshot.app_version}</dd></div>
            <div><dt>Experience</dt><dd>{review.snapshot.experience_label}</dd></div><div><dt>Owner</dt><dd>{review.snapshot.owner_label}</dd></div>
            <div><dt>Verified artifact</dt><dd className="break-all font-mono text-xs">{review.snapshot.artifact_digest}</dd></div></dl>
          {review.snapshot.resources.map(resource => <div key={resource.resource_key} className="min-w-0 space-y-2 border-t py-3" style={{ borderColor: 'var(--ghost-border)' }}>
            <p className="break-words font-medium">{resource.label} ({resource.resource_type})</p>
            <p>Allowed reads: list saved record summaries; read one saved record{resource.allowed_operations.includes('search') ? '; search approved fields using literal queries with snippets' : ''}.</p><p className="break-words">Permitted fields: {resource.allowed_fields.join(', ')}.</p>
            {resource.allowed_operations.includes('search') && <p>Literal search examines the complete saved approved fields within the App’s reviewed limits. It delivers at most 240 characters per matching excerpt. Continue until the search is complete.</p>}
            <p>At most 10 {resource.allowed_operations.includes('search') ? 'summaries or search matches' : 'summaries'} per page; 32 scalar fields; 4096 characters per string; 60 KiB per response.</p></div>)}
          <p>The recipient is the verified App author Worker for this exact session. Provider credentials and internal provider metadata are excluded. Approved fields may include identifiers declared by the App.</p>
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => void acceptExposure()}>Allow listed private fields</button>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => { reviewGeneration.current += 1; setReview(null); }}>Cancel private access review</button></div></>
          : <><p>This App’s code cannot read your saved private resources until you approve the exact fields for this session.</p>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy || !!error} onClick={() => void prepareExposure()}>Review private access</button></>}
      {exposureBusy && <p role="status">Checking private access…</p>}
    </section>}
    {error && <button className="deft-pill m-4 min-h-11 shrink-0 self-start" style={{ minHeight: 44 }} onClick={() => { setExposure(null); setReview(null); setOpening(value => value + 1); }}>Reopen Experience</button>}
    <div ref={viewHost} className="min-h-0 flex-1 overflow-auto" aria-label="App Experience" />
    <footer className="relative flex min-h-11 shrink-0 items-center justify-between gap-2 border-t px-3 text-[11px] sm:px-6" style={{ borderColor: 'var(--ghost-border)', color: 'var(--on-surface-variant)', background: 'var(--surface)' }}>
      {exposure && !error ? <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden"><ShieldCheck size={14} aria-hidden="true" /><span>Access</span></summary>
        <div className="absolute bottom-full left-3 z-20 mb-2 w-[min(340px,calc(100vw-40px))] space-y-3 rounded-lg border p-4 text-xs shadow-xl" style={{ background: 'var(--surface-container)', borderColor: 'var(--outline-variant)' }}>
          <p className="font-medium">Private access · this session only</p>
          <p>This app can read the fields you approved until {new Date(exposure.expires_at).toLocaleString()}.</p>
          <button className="deft-pill min-h-11" onClick={() => void withdrawExposure()}>End private access</button>
        </div>
      </details> : <span>Deft app</span>}
      <nav aria-label="App tools" className="flex items-center gap-3 sm:gap-5">
        {APP_ATTACHMENT_BROKER_ENABLED && <Link className="inline-flex min-h-11 items-center gap-1.5 hover:underline" href="/settings/apps/private-resources"><Paperclip size={14} aria-hidden="true" />Files</Link>}
        <Link className="inline-flex min-h-11 items-center gap-1.5 hover:underline" href="/inbox"><CheckCheck size={14} aria-hidden="true" />Approvals</Link>
        <Link aria-label="App settings" title="App settings" className="inline-flex min-h-11 min-w-8 items-center justify-center" href="/settings/apps"><Settings2 size={15} aria-hidden="true" /></Link>
      </nav>
    </footer>
    <div ref={iframeHost} aria-hidden="true" />
  </div>;
}
