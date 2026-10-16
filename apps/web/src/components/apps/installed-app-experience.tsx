'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Paperclip, ShieldCheck, Settings2, CheckCheck } from 'lucide-react';
import { api, isSameWebSession, refreshAccessToken, SessionRefreshUnavailableError } from '@/lib/api';
import { settleDispatchedExperienceWrites } from '@/lib/app-experience-renewal';
import { createExperienceLease, normalizeExperienceLeaseRefresh } from '@/lib/app-experience-lease';
import { createExperienceConnection, experienceAuthorityResponse, ExperienceAuthorityUnavailable } from '@/lib/app-experience-connection';
import { readExperienceAuthority } from '@/lib/app-experience-revalidation';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { createExperienceSuspension, experienceOperationAllowedWhileHidden } from '@/lib/app-experience-suspension';
import type { ExperienceView } from '@/lib/app-experience-bridge';
import { createExperienceBridge } from '@/lib/app-experience-bridge';
import { renderExperienceView, clearExperienceView, suspendExperienceView, flushExperienceInputs, EXPERIENCE_RENDERER_CSS } from '@/lib/app-experience-renderer';
import { normalizeInstalledExperienceSession, experienceLifetimeIsCurrent,
  normalizeExperienceExposureStatus, normalizeExperienceExposureReview, normalizeExperienceAccess, type ExperienceExposureStatus,
  type ExperienceExposureReview, type InstalledExperienceSession } from '@/lib/app-experience-session';
import { getSocket } from '@/lib/socket';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { AttachmentParentView } from '@/components/apps/attachment-parent-view';
import { PrivateStateRecoveryGate } from '@/components/apps/private-state-recovery-gate';
import { ExperienceRunReview } from '@/components/apps/experience-run-review';
import { experienceRunReviewTarget, type ExperienceRunReviewTarget } from '@/lib/app-experience-run-review';
import { useExperienceNavigation } from './experience-navigation-context';
import { ExperienceActionComposer } from './experience-action-composer';
import { ExperienceAgentPolicy } from './experience-agent-policy';
import type { ExperienceComposeRequest } from '@/lib/app-experience-action-composer';

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
  const { publishNavigation, clearNavigation } = useExperienceNavigation();
  const [session, setSession] = useState<InstalledExperienceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [opening, setOpening] = useState(0);
  const [visibleEpoch, setVisibleEpoch] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [review, setReview] = useState<ExperienceExposureReview | null>(null);
  const [exposure, setExposure] = useState<ExperienceExposureStatus | null>(null);
  const [exposureBusy, setExposureBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryStates, setRecoveryStates] = useState<{ key: string; label: string }[]>([]);
  const continueRecovery = useCallback(() => setRecoveryReady(true), []);
  const [source, setSource] = useState<{ bindingId: string; recordId: string } | null>(null);
  const [runReview, setRunReview] = useState<ExperienceRunReviewTarget | null>(null);
  const [composer, setComposer] = useState<ExperienceComposeRequest | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const composerReply = useRef<((result: unknown) => void) | null>(null);
  const closeComposer = useCallback((unknown = false) => {
    composerReply.current?.(unknown ? { unknown: true } : { cancelled: true }); composerReply.current = null; setComposer(null);
  }, []);
  const composerAuthority = useCallback(async () => await ensureAuthority.current?.() ?? false, []);
  const sourceReturn = useRef<HTMLElement | null>(null);
  const sourceBack = useRef<HTMLButtonElement>(null);
  const closeSource = () => { const target = sourceReturn.current; setSource(null); sourceReturn.current = null;
    requestAnimationFrame(() => { if (target?.isConnected) target.focus(); }); };
  useEffect(() => { if (source) sourceBack.current?.focus(); }, [source]);
  const reviewGeneration = useRef(0);
  const stopWorker = useRef<((retireSession?: boolean) => void) | null>(null);
  const iframeHost = useRef<HTMLDivElement>(null);
  const viewHost = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);
  const [renewalBusy, setRenewalBusy] = useState(false);
  const [renewalNotice, setRenewalNotice] = useState<string | null>(null);
  const renewalGeneration = useRef(0);
  const leaseCurrent = useRef<ReturnType<typeof createExperienceLease> | null>(null);
  const ensureAuthority = useRef<(() => Promise<boolean>) | null>(null);
  const dispatchedWrites = useRef(new Set<Promise<unknown>>());
  useEffect(() => () => {
    renewalGeneration.current += 1;
  }, [installationId, experienceKey, sessionCacheScope]);

  const renewPrivateAccess = async () => {
    if (renewalBusy || document.hidden) return;
    const ticket = ++renewalGeneration.current;
    const token = api.getAccessToken();
    if (!token) { setRenewalNotice('Sign in again before renewing private access.'); return; }
    setRenewalBusy(true); setRenewalNotice(null);
    const current = () => ticket === renewalGeneration.current && !document.hidden
      && isSameWebSession(token, api.getAccessToken());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (viewHost.current) flushExperienceInputs(viewHost.current);
      if (!await settleDispatchedExperienceWrites(dispatchedWrites.current)) throw new Error('A saved-data request is not confirmed. Check your app’s save status before renewing.');
      if (!current()) return;
      const refreshed = await Promise.race([refreshAccessToken(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 15_000); })]);
      if (!current()) return;
      if (!refreshed || !isSameWebSession(token, refreshed)) throw new Error('Private access could not be renewed. Your current app remains available until its original expiry.');
      setOpening(value => value + 1);
    } catch (cause) {
      if (current()) setRenewalNotice(cause instanceof Error ? cause.message : 'Unable to renew private access.');
    } finally {
      if (timer) clearTimeout(timer);
      if (ticket === renewalGeneration.current) setRenewalBusy(false);
    }
  };

  useLayoutEffect(() => {
    stopWorker.current?.();
    setSession(null); setSource(null); setRunReview(null); closeComposer(true); setRecoveryReady(false); setRecoveryStates([]);
    setError(null); setSuspended(false); setConnectionUnavailable(false);
    setReady(false);
    setReview(null); setExposure(null); setExposureBusy(false); reviewGeneration.current += 1;
    if (viewHost.current) clearExperienceView(viewHost.current);
    rendered.current = false;
    if (!user || !org || !sessionCacheScope) return;
    let cancelled = false;
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let openingRequest = false, openingComplete = false;
    const openingToken = api.getAccessToken();
    const openingCurrent = () => !cancelled && !!openingToken && isSameWebSession(openingToken, api.getAccessToken());
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
    const open = async () => {
      if (!openingCurrent() || openingRequest) return;
      if (document.hidden) { setSuspended(true); return; }
      openingRequest = true; deadline = setTimeout(() => abort.abort(), 15_000);
      try {
        // Effect replay can deactivate this owner before any request is needed.
        await Promise.resolve();
        if (cancelled) return;
        if (document.hidden) {
          setError('Opening paused while this tab was hidden. Reopen the app to continue.');
          return;
        }
        const response = await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/sessions`, {
          method: 'POST', signal: abort.signal,
        });
        if (experienceAuthorityResponse(response) === 'unavailable') throw new ExperienceAuthorityUnavailable();
        if (!response.ok) throw new Error(await appApiError(response, 'This Experience is unavailable.'));
        const created = normalizeInstalledExperienceSession(await response.json());
        ownedSessionId = created.pin.session_id;
        if (created.pin.org_id !== org.id || created.pin.user_id !== user.id
          || created.pin.app_installation_id !== installationId
          || created.experience.key !== experienceKey) throw new Error('Experience session identity changed.');
        if (!cancelled && !document.hidden) {
          if (created.bundle.resource_keys.length || created.bundle.state_keys?.length) {
            setExposureBusy(true);
            const acquired = await api.fetch(`${root}/sessions/${encodeURIComponent(created.pin.session_id)}/access/acquire`, { method: 'POST', signal: abort.signal, body: '{}' });
            if (experienceAuthorityResponse(acquired) === 'unavailable') throw new ExperienceAuthorityUnavailable();
            if (!acquired.ok) throw new Error(await appApiError(acquired, 'Private access is unavailable.'));
            const access = normalizeExperienceAccess(await acquired.json());
            if (cancelled) { retireOwnedSession(); return; }
            setRecoveryStates(access.states); setExposure(access.exposure); setExposureBusy(false);
          }
          openingComplete = true; setConnectionUnavailable(false); setSuspended(false); setSession(created); setReady(true);
        }
        else {
          retireOwnedSession();
          if (openingCurrent()) { setSuspended(true); retry = setTimeout(() => { if (!document.hidden) setOpening(value => value + 1); }, 5000); }
        }
      } catch (cause) {
        retireOwnedSession();
        if (openingCurrent()) {
          if (cause instanceof ExperienceAuthorityUnavailable || cause instanceof SessionRefreshUnavailableError || cause instanceof TypeError || cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name)) {
            setConnectionUnavailable(true); retry = setTimeout(() => { if (!document.hidden && openingCurrent()) setOpening(value => value + 1); }, 5000);
          } else setError(cause instanceof Error ? cause.message : 'This Experience is unavailable.');
        }
      } finally { openingRequest = false; clearTimeout(deadline); }
    };
    const resumeOpening = () => { if (!document.hidden && !openingComplete && openingCurrent()) setOpening(value => value + 1); };
    document.addEventListener('visibilitychange', resumeOpening);
    addEventListener('online', resumeOpening);
    void open();
    return () => {
      // Consume an already dispatched response while this document remains alive
      // so its exact session can be retired rather than abandoned.
      cancelled = true; clearTimeout(deadline); clearTimeout(retry);
      document.removeEventListener('visibilitychange', resumeOpening); removeEventListener('online', resumeOpening); removeEventListener('pagehide', pageHide);
      stopWorker.current?.(); retireOwnedSession();
      reviewGeneration.current += 1; setReview(null); setExposure(null);
    };
  }, [installationId, experienceKey, user?.id, org?.id, sessionCacheScope, opening, closeComposer]);

  // Only the pre-Worker recovery phase owns this lease; the Worker effect takes over afterwards.
  useEffect(() => {
    if (!session || !exposure || recoveryReady || !session.bundle.state_keys?.length) return;
    let active = true, pending = false;
    const token = api.getAccessToken();
    const current = () => active && !!token && isSameWebSession(token, api.getAccessToken());
    const lease = createExperienceLease({ initial: { session_expires_at: session.expires_at, exposure }, current,
      refresh: async () => {
        try { if (!await refreshAccessToken() || !current()) throw new Error('Private access ended.'); }
        catch (cause) { if (cause instanceof SessionRefreshUnavailableError) throw new ExperienceAuthorityUnavailable(); throw cause; }
        const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/refresh`,
          { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) });
        if (experienceAuthorityResponse(response) === 'unavailable') throw new ExperienceAuthorityUnavailable();
        if (!response.ok) throw new Error('Private access ended.');
        return normalizeExperienceLeaseRefresh(await response.json());
      } });
    const check = async () => {
      if (pending || document.hidden || !current()) return;
      pending = true;
      try {
        if (!await lease.ensure()) { if (current()) setError('Private access ended. Reopen the app to continue.'); return; }
        if (!current()) return;
        setConnectionUnavailable(false);
        if (lease.value.session_expires_at !== session.expires_at) {
          setSession({ ...session, expires_at: lease.value.session_expires_at }); setExposure({ ...lease.value.exposure, active: true });
        }
      } catch { if (current()) setConnectionUnavailable(true); }
      finally { pending = false; }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    const resume = () => { void check(); };
    document.addEventListener('visibilitychange', resume); addEventListener('online', resume);
    return () => { active = false; lease.dispose(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); removeEventListener('online', resume); };
  }, [session, exposure, recoveryReady]);

  const prepareExposure = async () => {
    if (!session || document.hidden) return;
    const generation = ++reviewGeneration.current;
    setExposureBusy(true); setReview(null); setError(null);
    try {
      const response = await api.post(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access/review`, {});
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
        const response = await api.post(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access/accept`, {
          review_token: review.review_token, review_digest: expectedDigest, accept_exposure: true });
        if (!response.ok) throw new Error(await appApiError(response, 'Unable to accept private access.'));
        const access = normalizeExperienceAccess(await response.json());
        if (!access.exposure) throw new Error('Private access was not granted.');
        accepted = access.exposure;
      } catch (reason) {
        // A committed acceptance may lose its response. Read safe status only;
        // never retry the authority-changing request automatically.
        const recovered = await api.post(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access/acquire`, {});
        if (!recovered.ok) throw reason;
        const access = normalizeExperienceAccess(await recovered.json());
        if (!access.exposure) throw reason;
        accepted = access.exposure;
      }
      if (accepted.review_digest !== expectedDigest || new Date(accepted.expires_at).getTime() <= Date.now()) throw new Error('Private access review expired; reopen the Experience.');
      if (generation === reviewGeneration.current && !document.hidden) {
        setRecoveryReady(false); setRecoveryStates((review.snapshot.private_state ?? []).map(({ key, label }) => ({ key, label })));
        setExposure(accepted); setReview(null);
      }
      else {
        // Acceptance can commit after this page has retired. Keep its authority
        // out of a later Worker lifetime and retire the exact old session.
        await retireSession(session.pin.session_id);
      }
    } catch (reason) { if (generation === reviewGeneration.current) { setReview(null); setError(reason instanceof Error ? reason.message : 'Unable to accept private access.'); } }
    finally { if (generation === reviewGeneration.current) setExposureBusy(false); }
  };
  const withdrawExposure = async () => {
    if (!session) return;
    const generation = ++reviewGeneration.current; setExposureBusy(true); setReview(null);
    stopWorker.current?.(false);
    setError('Private access revoked. Review permissions to grant access again.');
    try {
      const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access`, { method: 'DELETE', keepalive: true });
      if (!response.ok) throw new Error('Revoke failed');
    } catch {
      if (generation === reviewGeneration.current) setError('This view is closed, but revocation could not be confirmed. Reconnect and revoke access again.');
    }
    if (generation === reviewGeneration.current) { setExposure(null); setExposureBusy(false); }
  };

  const readRunReview = useCallback(async (runId: string, signal?: AbortSignal) => {
    const generation = reviewGeneration.current, token = api.getAccessToken();
    const live = () => !!session && !!token && !document.hidden && !signal?.aborted
      && generation === reviewGeneration.current && isSameWebSession(token, api.getAccessToken())
      && (leaseCurrent.current?.valid() ?? experienceLifetimeIsCurrent(session.expires_at, exposure?.expires_at));
    if (!live() || session?.protocol_version !== '7') throw new Error('Request unavailable');
    const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/runs/${encodeURIComponent(runId)}/review-target`, { signal });
    if (!response.ok) throw new Error('Request unavailable');
    const target = experienceRunReviewTarget(await response.json(), runId);
    if (!live()) throw new Error('Request unavailable');
    return target;
  }, [session, exposure]);

  useEffect(() => {
    if (!session || !iframeHost.current || !viewHost.current || !sessionCacheScope
      || document.hidden || !experienceLifetimeIsCurrent(session.expires_at, exposure?.expires_at)
      || (!!session.bundle.state_keys?.length && !recoveryReady)
      || ((session.bundle.resource_keys.length > 0 || !!session.bundle.state_keys?.length) && !exposure)) return;
    let stopped = false;
    const generation = reviewGeneration.current, sessionToken = api.getAccessToken();
    const identityCurrent = () => !stopped && generation === reviewGeneration.current
      && isSameWebSession(sessionToken, api.getAccessToken());
    const lease = exposure ? createExperienceLease({ initial: { session_expires_at: session.expires_at, exposure },
      current: identityCurrent,
      refresh: async () => {
        let refreshed: string | null;
        try { refreshed = await refreshAccessToken(); }
        catch (error) { if (error instanceof SessionRefreshUnavailableError) throw new ExperienceAuthorityUnavailable(); throw error; }
        if (!refreshed || !identityCurrent()) throw new Error('Sign in again to continue.');
        const response = await readExperienceAuthority(identityCurrent, () => api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/refresh`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) }));
        if (experienceAuthorityResponse(response) === 'unavailable') throw new ExperienceAuthorityUnavailable();
        if (!response?.ok) throw new Error('App access is no longer available.');
        return normalizeExperienceLeaseRefresh(await response.json());
      } }) : null;
    leaseCurrent.current = lease;
    const authorityCurrent = () => identityCurrent() && (lease?.valid() ?? experienceLifetimeIsCurrent(session.expires_at));
    let unavailable = false;
    const locallyCurrent = () => authorityCurrent() && !unavailable && !document.hidden;
    let latestView: ExperienceView | null = null;
    const navigationOwner = Symbol('experience-navigation');
    const publishViewNavigation = (view: ExperienceView) => {
      if (!locallyCurrent() || !view.navigation?.length) { clearNavigation(navigationOwner); return; }
      publishNavigation({ owner: navigationOwner, installationId,
        pathname: `/apps/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}`,
        scope: sessionCacheScope, items: view.navigation,
        select: (id) => {
          if (!locallyCurrent()) return;
          const item = latestView?.navigation?.find(item => item.id === id);
          if (!item || item.disabled) return;
          if (viewHost.current) flushExperienceInputs(viewHost.current);
          setSource(null); sourceReturn.current = null;
          void bridge.sendUiEvent({ kind: 'click', node_id: id });
        },
      });
    };
    const knownRunIds = new Set<string>();
    const port = new MessageChannel();
    const frame = document.createElement('iframe');
    frame.title = 'Isolated App Experience Worker';
    frame.sandbox.add('allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    const connection = createExperienceConnection({ current: identityCurrent, valid: authorityCurrent,
      read: async () => {
        if (!identityCurrent()) return 'denied';
        if (lease && !await lease.ensure()) return 'denied';
        if (!authorityCurrent()) return 'denied';
        const response = await readExperienceAuthority(authorityCurrent, () => api.fetch(livePath(session.pin.session_id), { signal: AbortSignal.timeout(10_000) }));
        if (!identityCurrent()) return 'denied';
        const responseState = experienceAuthorityResponse(response);
        if (responseState !== 'available') return responseState;
        if (exposure) {
          const status = await readExperienceAuthority(authorityCurrent, () => api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`, { signal: AbortSignal.timeout(10_000) }));
          if (!identityCurrent()) return 'denied';
          const statusState = experienceAuthorityResponse(status);
          if (statusState !== 'available') return statusState;
          let current: ExperienceExposureStatus;
          try { current = normalizeExperienceExposureStatus(await status!.json()); } catch { return 'denied'; }
          return authorityCurrent() && current.exposure_id === exposure.exposure_id && current.exposure_epoch === exposure.exposure_epoch
            && current.review_digest === exposure.review_digest && current.expires_at === lease?.value.exposure.expires_at
            ? 'available' : 'denied';
        }
        return authorityCurrent() ? 'available' : 'denied';
      },
      change(state) {
        if (state === 'denied') { stop(); return; }
        if (state === 'unavailable') {
          if (!unavailable) {
            unavailable = true; setConnectionUnavailable(true); clearNavigation(navigationOwner);
            setSource(null); setRunReview(null);
            if (viewHost.current) suspendExperienceView(viewHost.current);
            rendered.current = false;
          }
          return;
        }
        const recovering = unavailable; unavailable = false; setConnectionUnavailable(false);
        if (recovering && !document.hidden) startWorker();
        if (recovering && !document.hidden && latestView && viewHost.current) {
          publishViewNavigation(latestView);
          renderExperienceView(viewHost.current, latestView, event => { void bridge.sendUiEvent(event); });
          rendered.current = true; setSuspended(false);
        }
      },
    });
    const live = connection.ensure;
    ensureAuthority.current = live;
    const bridge = createExperienceBridge({
      port: port.port1, pin: session.pin,
      resourceKeys: session.bundle.resource_keys,
      stateKeys: session.bundle.state_keys,
      actionKeys: session.bundle.action_keys,
      dialogKeys: session.protocol_version === '7' ? ['review_run', 'compose_action'] : [],
      broker: {
        isLive: live,
        async dialog(_pin, key, input, signal) {
          if (key === 'compose_action') {
            if (!locallyCurrent() || composerReply.current || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
            const value = input as Record<string, unknown>;
            if (Object.keys(value).some(key => !['action_key', 'input', 'draft_state_key', 'draft_id'].includes(key))
              || typeof value.action_key !== 'string' || !session.bundle.action_keys.includes(value.action_key)
              || typeof value.draft_state_key !== 'string' || !session.bundle.state_keys?.includes(value.draft_state_key)
              || typeof value.draft_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.draft_id)
              || value.input !== undefined && (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)
                || Object.values(value.input).some(field => field !== null && !['string', 'number', 'boolean'].includes(typeof field)))) return undefined;
            if (!await live() || signal.aborted || !locallyCurrent() || composerReply.current) return undefined;
            return new Promise(resolve => {
              const finish = (result: unknown) => { signal.removeEventListener('abort', aborted); resolve(result); };
              const aborted = () => { finish(undefined); composerReply.current = null; setComposer(null); };
              signal.addEventListener('abort', aborted, { once: true });
              composerReply.current = finish;
              setComposer(value as ExperienceComposeRequest);
            });
          }
          if (key !== 'review_run' || !locallyCurrent() || !input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).length !== 1 || !('run_id' in input) || typeof input.run_id !== 'string'
            || !/^[a-f0-9-]{36}$/i.test(input.run_id)) return undefined;
          const target = await readRunReview(input.run_id, signal);
          if (!await live() || !locallyCurrent() || signal.aborted) return undefined;
          setRunReview(target); return { opened: true };
        },
        async openResource(_pin, key, input, signal) {
          if (!APP_ATTACHMENT_BROKER_ENABLED || session.protocol_version !== '7' || !exposure || !locallyCurrent()
            || !input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).length !== 1 || !('record_id' in input)
            || typeof input.record_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.record_id)) return undefined;
          const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/resources/${encodeURIComponent(key)}/target`,
            { method: 'POST', signal, body: JSON.stringify(input) });
          if (!response.ok) return undefined;
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
          const target = body as Record<string, unknown>;
          if (Object.keys(target).sort().join(',') !== 'binding_id,exposure_epoch,exposure_id,record_id,schema_version'
            || target.schema_version !== 'deft.experience_resource_target.v1'
            || target.exposure_id !== exposure.exposure_id || target.exposure_epoch !== exposure.exposure_epoch
            || target.record_id !== input.record_id || typeof target.binding_id !== 'string'
            || !/^[0-9a-f-]{36}$/i.test(target.binding_id) || signal.aborted || !locallyCurrent() || !await live()) return undefined;
          if (signal.aborted || !locallyCurrent()) return undefined;
          sourceReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setSource({ bindingId: target.binding_id, recordId: input.record_id });
          return { opened: true };
        },
        async privateState(_pin, key, input, signal) {
          const allowed = () => authorityCurrent() && (!document.hidden || experienceOperationAllowedWhileHidden('private_state', input));
          if (!exposure || !allowed()) return undefined;
          const operation = (async () => {
          const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/state/${encodeURIComponent(key)}`,
            { method: 'POST', signal, body: JSON.stringify(input) });
          if (!response.ok) throw new Error(await appApiError(response, 'Private state unavailable.'));
          const body = await response.json() as { exposure_id?: string; exposure_epoch?: number; output?: unknown };
          if (!allowed() || signal.aborted || body.exposure_id !== exposure.exposure_id || body.exposure_epoch !== exposure.exposure_epoch) return undefined;
          return body.output;
          })();
          if (experienceOperationAllowedWhileHidden('private_state', input)) {
            const confirmation = operation.then(output => { if (output === undefined) throw new Error('Saved-data response not confirmed.'); return output; });
            dispatchedWrites.current.add(confirmation);
            void confirmation.then(() => dispatchedWrites.current.delete(confirmation), () => dispatchedWrites.current.delete(confirmation));
          }
          return operation;
        },
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
          if (!locallyCurrent()) return undefined;
          const response = await api.fetch(
            `${root}/sessions/${encodeURIComponent(session.pin.session_id)}/actions/${encodeURIComponent(key)}`,
            { method: 'POST', signal, body: JSON.stringify({ request_id: requestId, input }) },
          );
          if (!response.ok) throw new Error(await appApiError(response, 'Experience action unavailable.'));
          const body = await response.json() as { run?: { id?: unknown } };
          if (typeof body.run?.id === 'string') knownRunIds.add(body.run.id);
          if (!locallyCurrent() || signal.aborted) return undefined;
          return body.run;
        },
        async runStatus(_pin, input, signal) {
          if (!locallyCurrent()) return undefined;
          const runId = input && typeof input === 'object' && !Array.isArray(input)
            ? (input as { run_id?: unknown }).run_id : null;
          if (typeof runId !== 'string' || (session.protocol_version === '7'
            ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
            : !knownRunIds.has(runId))) return undefined;
          const response = await api.fetch(session.protocol_version === '7'
            ? `${root}/sessions/${encodeURIComponent(session.pin.session_id)}/runs/${encodeURIComponent(runId)}`
            : `/api/app-runs/${encodeURIComponent(runId)}`, { signal });
          if (!response.ok) return undefined;
          const body = await response.json() as { run?: unknown };
          if (!locallyCurrent() || signal.aborted) return undefined;
          return body.run;
        },
      },
      onView(view) {
        if (!authorityCurrent()) return;
        latestView = view;
        if (!locallyCurrent() || !viewHost.current) return;
        publishViewNavigation(view);
        renderExperienceView(viewHost.current, view, (event) => { void bridge.sendUiEvent(event); });
        rendered.current = true;
      },
    });
    const stop = (retireSession = true) => {
      if (stopped) return;
      stopped = true; latestView = null; setSuspended(false); setSource(null); setRunReview(null);
      connection.dispose(); lease?.dispose(); ensureAuthority.current = null; setConnectionUnavailable(false);
      clearNavigation(navigationOwner);
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (viewHost.current) clearExperienceView(viewHost.current);
      rendered.current = false;
      closeComposer(true); setError('This Experience session ended. Reopen it to continue.');
      if (retireSession) void api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
    stopWorker.current = stop;
    let started = false, bootstrapReady = false;
    const startWorker = () => {
      if (!bootstrapReady || !locallyCurrent() || started || !frame.contentWindow) return;
      started = true;
      frame.contentWindow.postMessage({ kind: 'start', session_id: session.pin.session_id, worker_source: session.bundle.worker_source }, '*', [port.port2]);
    };
    const onBootstrapReady = (event: MessageEvent) => {
      if (!authorityCurrent() || started || event.source !== frame.contentWindow || event.origin !== 'null'
        || !event.data || event.data.kind !== 'deft_experience_bootstrap_ready.v1'
        || !frame.contentWindow) return;
      bootstrapReady = true; startWorker();
    };
    addEventListener('message', onBootstrapReady);
    frame.src = '/app-experience-bootstrap';
    iframeHost.current.append(frame);
    const checkConnection = () => { void connection.check(); };
    const poll = setInterval(checkConnection, 5000);
    addEventListener('online', checkConnection);
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'deft-access-token' || event.key === 'deft-refresh-token') {
        checkConnection();
      }
    };
    addEventListener('storage', onStorage);
    const token = api.getAccessToken();
    const socket = token ? getSocket(token) : null;
    const onAppChange = checkConnection;
    socket?.on('app:changed', onAppChange);
    const suspension = createExperienceSuspension({
      current: authorityCurrent, live, hidden: () => document.hidden,
      flush: () => { if (viewHost.current) flushExperienceInputs(viewHost.current); },
      clear: () => { clearNavigation(navigationOwner); setSuspended(true); setSource(null); setRunReview(null); if (viewHost.current) suspendExperienceView(viewHost.current); rendered.current = false; },
      restore: () => { setSuspended(false); startWorker(); if (latestView && viewHost.current) { publishViewNavigation(latestView); renderExperienceView(viewHost.current, latestView, event => { void bridge.sendUiEvent(event); }); rendered.current = true; } },
      end: stop,
    });
    const hidden = () => { if (document.hidden) suspension.hide(); else void suspension.show(); };
    document.addEventListener('visibilitychange', hidden);
    const pageHide = () => stop();
    addEventListener('pagehide', pageHide);
    // Grant-backed leases renew through live(); a fixed timer would retire a
    // healthy Worker at the original deadline after successful renewal.
    const expiry = exposure ? undefined : setTimeout(() => stop(), Math.max(0, Date.parse(session.expires_at) - Date.now()));
    return () => {
      clearInterval(poll); removeEventListener('online', checkConnection); suspension.dispose();
      removeEventListener('message', onBootstrapReady);
      removeEventListener('storage', onStorage);
      socket?.off('app:changed', onAppChange);
      document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', pageHide); clearTimeout(expiry);
      stopped = true;
      connection.dispose(); lease?.dispose(); ensureAuthority.current = null;
      if (leaseCurrent.current === lease) leaseCurrent.current = null;
      clearNavigation(navigationOwner);
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (viewHost.current) clearExperienceView(viewHost.current);
      rendered.current = false;
      stopWorker.current = null;
      void retireSession(session.pin.session_id);
    };
  }, [session, sessionCacheScope, exposure, recoveryReady, readRunReview, visibleEpoch, installationId, experienceKey, publishNavigation, clearNavigation, closeComposer]);

  useEffect(() => {
    const clear = () => { renewalGeneration.current += 1; reviewGeneration.current += 1; setReview(null); setExposureBusy(false); stopWorker.current?.(); };
    const hidden = () => {
      if (document.hidden) { renewalGeneration.current += 1; setRenewalBusy(false); if (!stopWorker.current) reviewGeneration.current += 1; setReview(null); setExposureBusy(false); }
      else if (!stopWorker.current) setVisibleEpoch(value => value + 1);
    };
    document.addEventListener('visibilitychange', hidden); addEventListener('pagehide', clear);
    return () => { clear(); document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', clear); };
  }, []);

  return <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
    <style>{EXPERIENCE_RENDERER_CSS}</style>
    <h1 className="sr-only">{session?.experience.label ?? 'Opening app…'}</h1>
    {renewalNotice && <p role="alert" className="shrink-0 px-5 py-3 text-sm">{renewalNotice}</p>}
    {connectionUnavailable && !error && <p role="status" className="shrink-0 px-6 py-4 text-sm">Connection interrupted. Reconnecting... Your saved work is kept.</p>}
    {suspended && !connectionUnavailable && !error && <p role="status" className="shrink-0 px-6 py-4 text-sm">Resuming app…</p>}
    {error ? <p role="alert" className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>{error}</p>
      : !ready ? <p role="status" className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>Opening app…</p>
      : null}
    {session && !error && (session.bundle.resource_keys.length > 0 || !!session.bundle.state_keys?.length) && !exposure && <section aria-label="Experience private access" className="mx-auto w-full max-w-3xl shrink-0 space-y-4 overflow-y-auto px-5 py-6 text-sm" style={{ maxHeight: 'calc(100% - 100px)' }}>
      {review ? <><h2 className="text-lg font-semibold">Allow private access?</h2>
          <p><span className="font-medium">{review.snapshot.app_name}</span> can use the access listed below until you revoke it or its permissions change. Technical sessions refresh automatically while you are signed in.</p>
          <p>This permission does not authorize autonomous actions. Actions requested by agents follow their separate approval policy.</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2"><div><dt className="text-xs text-muted-foreground">App</dt><dd>{review.snapshot.app_name} {review.snapshot.app_version}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Owner</dt><dd>{review.snapshot.owner_label}</dd></div></dl>
          {review.snapshot.resources.map(resource => <div key={resource.resource_key} className="min-w-0 space-y-2 border-t py-3" style={{ borderColor: 'var(--ghost-border)' }}>
            <p className="break-words font-medium">Read saved {resource.label}</p>
            <p>Read summaries and individual records{resource.allowed_operations.includes('search') ? ', and search the approved fields' : ''}.</p>
            <details><summary className="min-h-11 cursor-pointer py-3 text-xs">Review {resource.allowed_fields.length} fields and read limits</summary>
              <div className="space-y-2 pb-2 text-xs" style={{ color: 'var(--on-surface-variant)' }}>
                <p>Record type: {resource.resource_type}</p><p className="break-words">Permitted fields: {resource.allowed_fields.join(', ')}.</p>
                {resource.allowed_operations.includes('search') && <p>Literal search examines the complete saved approved fields within the app’s reviewed limits, with at most 240 characters per matching excerpt.</p>}
                <p>At most 10 {resource.allowed_operations.includes('search') ? 'summaries or search matches' : 'summaries'} per page; 32 scalar fields; 4096 characters per string; 60 KiB per response.</p>
              </div></details></div>)}
          {review.snapshot.private_state?.map(state => <div key={state.key} className="space-y-2 border-t py-3" style={{ borderColor: 'var(--ghost-border)' }}><p className="font-medium">Manage {state.label.toLowerCase()}</p>
            <p>List, read, save and delete up to {state.max_records} encrypted records, retained for {state.retention_days} days from creation. Only you and this reviewed app can access them; workspace search and AI context are excluded.</p>
            <details><summary className="min-h-11 cursor-pointer py-3 text-xs">Storage limits</summary><p className="pb-2 text-xs">{state.max_record_bytes} bytes per record; {state.max_total_bytes} bytes total.</p></details></div>)}
          <details className="border-t pt-3" style={{ borderColor: 'var(--ghost-border)' }}><summary className="min-h-11 cursor-pointer py-3 text-xs">Verified app and access details</summary>
            <div className="space-y-2 pb-3 text-xs"><p>Screen: {review.snapshot.experience_label}</p><p className="break-all font-mono">{review.snapshot.artifact_digest}</p>
              <p>Access is limited to this verified app version and the listed fields. Provider credentials and internal provider metadata are excluded. Changed permissions require a new review.</p></div></details>
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => void acceptExposure()}>Allow listed private access</button>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => { reviewGeneration.current += 1; setReview(null); }}>Cancel private access review</button></div></>
          : <><p>Grant this app access to the exact private fields and saved data you choose. You can revoke access at any time.</p>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy || !!error} onClick={() => void prepareExposure()}>Review private access</button></>}
      {exposureBusy && <p role="status">Checking private access…</p>}
    </section>}
    {error && <section className="shrink-0 space-y-2 px-5 py-3 text-sm"><p>Your saved drafts remain private. Reconnect to recover them; sign in again if your login has ended.</p>
      <button className="deft-pill min-h-11" disabled={renewalBusy} onClick={() => void renewPrivateAccess()}>{renewalBusy ? 'Reconnecting…' : 'Reconnect app'}</button></section>}
    {session && exposure && !error && !!session.bundle.state_keys?.length && !recoveryReady && <PrivateStateRecoveryGate suspended={connectionUnavailable}
      key={`${session.pin.session_id}/${exposure.exposure_id}/${exposure.exposure_epoch}`} sessionId={session.pin.session_id} exposure={exposure}
      states={recoveryStates} onContinue={continueRecovery} />}
    <div ref={viewHost} className="min-h-0 flex-1 overflow-auto" style={source ? { display: 'none' } : undefined} aria-label="App Experience" />
    {source && exposure && !error && <section className="flex min-h-0 flex-1 flex-col" aria-label="Selected App resource">
      <div className="shrink-0 border-b px-4 py-2" style={{ borderColor: 'var(--ghost-border)' }}><button ref={sourceBack} className="deft-pill min-h-11" onClick={closeSource}>Back to {session?.experience.label ?? 'app'}</button></div>
      <AttachmentParentView bindingId={source.bindingId} projectionId={source.recordId} compact />
    </section>}
    <footer className={source ? 'hidden' : 'relative flex min-h-11 shrink-0 items-center justify-between gap-2 border-t px-3 text-[11px] sm:px-6'} style={{ borderColor: 'var(--ghost-border)', color: 'var(--on-surface-variant)', background: 'var(--surface)' }}>
      {exposure && !error ? <details className="group" onToggle={event => setAccessOpen(event.currentTarget.open)}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden"><ShieldCheck size={14} aria-hidden="true" /><span>Access</span></summary>
        <div className="absolute bottom-full left-3 z-20 mb-2 max-h-[70dvh] w-[min(340px,calc(100vw-40px))] space-y-3 overflow-y-auto rounded-lg border p-4 text-xs shadow-xl" style={{ background: 'var(--surface-container)', borderColor: 'var(--outline-variant)' }}>
          <p className="font-medium">Private access · until revoked</p>
          <p>This app can use the fields and saved data you approved. Technical sessions refresh automatically.</p>
          <p>Agents do not gain permission to send or perform external actions from this grant.</p>
          <button className="deft-pill min-h-11" onClick={() => void withdrawExposure()}>Revoke private access</button>
          {accessOpen && session && <ExperienceAgentPolicy sessionId={session.pin.session_id}
            actions={session.bundle.action_keys} ensureAuthority={composerAuthority} />}
        </div>
      </details> : <span>Deft app</span>}
      <nav aria-label="App tools" className="flex items-center gap-3 sm:gap-5">
        {APP_ATTACHMENT_BROKER_ENABLED && <Link className="inline-flex min-h-11 items-center gap-1.5 hover:underline" href="/settings/apps/private-resources"><Paperclip size={14} aria-hidden="true" />Files</Link>}
        <Link className="inline-flex min-h-11 items-center gap-1.5 hover:underline" href="/inbox"><CheckCheck size={14} aria-hidden="true" />Approvals</Link>
        <Link aria-label="App settings" title="App settings" className="inline-flex min-h-11 min-w-8 items-center justify-center" href="/settings/apps"><Settings2 size={15} aria-hidden="true" /></Link>
      </nav>
    </footer>
    <div ref={iframeHost} aria-hidden="true" />
    {runReview && !error && <ExperienceRunReview key={runReview.runId} initial={runReview}
      refresh={() => readRunReview(runReview.runId)} onClose={() => setRunReview(null)} />}
    {composer && session && <ExperienceActionComposer request={composer} sessionId={session.pin.session_id}
      draftScope={{ orgId: session.pin.org_id, userId: session.pin.user_id, installationId }}
      suspended={connectionUnavailable || suspended} ensureAuthority={composerAuthority} onClose={closeComposer} onResult={run => {
        composerReply.current?.({ run }); composerReply.current = null; setComposer(null);
      }} />}
  </div>;
}
