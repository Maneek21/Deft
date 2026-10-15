'use client';

import {createExperienceAccountRouting,resolveExperienceActionAccount,type AccountReference,type AccountChild} from '../../lib/app-experience-account-routing';
import {createExperienceRecordMirrorHost} from '../../lib/app-experience-record-mirror';
import {createExperienceLocalJobHost} from '../../lib/app-experience-local-jobs';
import {parseSourceNomination,openSourceNomination,resolveSourceNominationAccount} from './integrations/source-nomination';
import {SourceNominationPanel,type NominatedSourceSurface} from './integrations/source-nomination-panel';
import {mountRecordTaskEntry} from './integrations/record-task-entry';
import {CurrentIntegrationAccessSettings} from './integrations/integration-access-settings';
import {appDataInputDigest} from '@/lib/app-experience-data-client';
import {boundedConfirmationJson} from '@/lib/app-experience-action-confirmation';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession, refreshAccessToken, SessionRefreshUnavailableError } from '@/lib/api';
import { settleDispatchedExperienceWrites } from '@/lib/app-experience-renewal';
import { createExperienceLease, normalizeExperienceLeaseRefresh } from '@/lib/app-experience-lease';
import { createExperienceConnection, experienceAuthorityResponse, ExperienceAuthorityUnavailable, isExperienceAuthorityUnavailable } from '@/lib/app-experience-connection';
import { readExperienceAuthority, readExperienceAuthorityPair } from '@/lib/app-experience-revalidation';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { createExperienceSuspension, experienceOperationAllowedWhileHidden } from '@/lib/app-experience-suspension';
import { ExperiencePreferences } from './experience-preferences';
import type { ExperienceNode, ExperienceView } from '@/lib/app-experience-bridge';
import { createExperienceBridge } from '@/lib/app-experience-bridge';
import { createExperienceStartup, experienceStartupStatus } from '@/lib/app-experience-startup';
import { renderExperienceView, clearExperienceView, suspendExperienceView, flushExperienceInputs, EXPERIENCE_RENDERER_CSS } from '@/lib/app-experience-renderer';
import { normalizeInstalledExperienceSession, experienceLifetimeIsCurrent,
  normalizeExperienceExposureStatus, normalizeExperienceExposureReview, normalizeExperienceAccess, type ExperienceExposureStatus,
  type ExperienceExposureReview, type InstalledExperienceSession } from '@/lib/app-experience-session';
import { getSocket } from '@/lib/socket';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { AttachmentParentView } from '@/components/apps/attachment-parent-view';
import {ExperienceSourceFiles} from './experience-source-files';
import {parseSourceView,type SourcePresentation} from '@/lib/app-experience-source-view';
import {reviewedSourcePolicy} from '@/lib/app-experience-source-policy';
import {mountExperienceSourcePresentation} from '@/lib/app-experience-source-presentation';
import {createExperienceResourceDocumentHost,createExperiencePresentationReviewCache} from '@/lib/app-experience-resource-document';
import {createExperienceFieldControlHost} from './experience-field-controls';
import {createExperienceRecordFormHost} from './experience-record-form';
import {createExperienceDataClient} from '@/lib/app-experience-data-client';
import {parseExperienceDataPresentation} from '@/lib/app-experience-data-presentation';
import {createExperienceRecordDocumentHost} from '@/lib/app-experience-record-document';
import {mountExperienceDataSourceFiles} from '@/lib/app-experience-data-source-files';
import {ExperienceDataConsent} from './experience-data-consent';
import {ExperienceRecordAction,type RecordActionRequest} from './experience-record-action';
import {ExperienceResourceAction,type ResourceActionRequest} from './experience-resource-action';
import {parseExperienceResourceAction} from '@/lib/app-experience-resource-action';
import {parseExperienceResourceActionBatch} from '@/lib/app-experience-resource-action-batch';
import {ExperienceResourceActionBatch,type ResourceActionBatchRequest} from './experience-resource-action-batch';
import {AppDataRecordMetaSchema,AppDataRequestSchema,AppDataSourceFileSchema,type AppDataResult} from '../../../../../packages/app-kit/src/app-data';
import { PrivateStateRecoveryGate } from '@/components/apps/private-state-recovery-gate';
import { ExperienceRunReview } from '@/components/apps/experience-run-review';
import { experienceRunReviewTarget, type ExperienceRunReviewTarget } from '@/lib/app-experience-run-review';
import { useExperienceNavigation } from './experience-navigation-context';
import {ExperienceActionConfirmation} from './experience-action-confirmation';
import {experienceActionDialogKeys,parseExperienceConfirmationRequest,type ExperienceConfirmationRequest} from '@/lib/app-experience-action-confirmation';
import { ExperienceActionComposer } from './experience-action-composer';
import { ExperienceAgentPolicy } from './experience-agent-policy';
import {experienceSettingsAccounts} from '@/lib/app-experience-settings-display';
import { ExperienceSettings } from './experience-settings';
import type {ExperienceSettingsSection} from '@/lib/app-experience-settings';
import { connectionSessionRetirementRequired, type PendingAppConnection } from '@/lib/app-connection-flow';
import { ExperienceConnectionSettings } from './experience-connection-settings';
import type { ExperienceComposeRequest } from '@/lib/app-experience-action-composer';
import {createExperienceTargetPreference,experienceTargetPreferenceKey} from '@/lib/app-experience-target-preference';
import {deliverExperienceRecordSubmission,reopenExperienceAfterSubmission} from '@/lib/app-experience-record-submission';

import {ExperienceRecordIntake,ExperienceMailtoRegistration} from './experience-record-intake';
import {createRecordIntake} from '@/lib/app-experience-record-intake';
import type {ExperienceMailtoSuggestion} from '@/lib/app-experience-mailto';
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
  const [startupPhase, setStartupPhase] = useState<string | null>(null);
  const [startupDiagnostic, setStartupDiagnostic] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [nominatedSource,setNominatedSource]=useState<NominatedSourceSurface|null>(null);
  const [preferencesNode,setPreferencesNode]=useState<ExperienceNode|null>(null);
  const intakePrepare=useRef<((suggestion:ExperienceMailtoSuggestion)=>Promise<{account:string;intake:ReturnType<typeof createRecordIntake>}>)|null>(null);
  const preferencesEvent=useRef<((event:unknown)=>void)|null>(null);
  const readingPreferencesChanged=useRef<(()=>void)|null>(null);
  const [opening, setOpening] = useState(0);
  const [resourceTarget, setResourceTarget] = useState('primary');
  const targetNomination=useRef<{scope:string;target:string}|null>(null);
  const targetPreference=useMemo(()=>createExperienceTargetPreference({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}),[]);
  const targetPreferenceScope=useMemo(()=>user&&org?{orgId:org.id,userId:user.id,installationId}:null,[user?.id,org?.id,installationId]);
  const [resourceTargets, setResourceTargets] = useState<{ key: string; label: string }[]>([]);
  const accountLabelScope=JSON.stringify([sessionCacheScope,org?.id,user?.id,installationId,session?.pin.app_version_id,session?.pin.grant_snapshot_id,session?.pin.lifecycle_epoch,session?.pin.grant_epoch]);
  const [accountLabels,setAccountLabels]=useState<{scope:string;labels:{key:string;label:string}[]}|null>(null);
  const receiveAccountLabels=useCallback((labels:{key:string;label:string}[])=>setAccountLabels({scope:accountLabelScope,labels}),[accountLabelScope]);
  const settingsAccounts=experienceSettingsAccounts(resourceTargets,accountLabels?.scope===accountLabelScope?accountLabels.labels:[]);

  const [visibleEpoch, setVisibleEpoch] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [review, setReview] = useState<ExperienceExposureReview | null>(null);
  const [exposure, setExposure] = useState<ExperienceExposureStatus | null>(null);
  const [exposureBusy, setExposureBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryStates, setRecoveryStates] = useState<{ key: string; label: string }[]>([]);
  const continueRecovery = useCallback(() => setRecoveryReady(true), []);
  const recoveryDismissalScope = useMemo(() => session ? {
    org_id: session.pin.org_id, user_id: session.pin.user_id, app_installation_id: session.pin.app_installation_id,
    app_version_id: session.pin.app_version_id, grant_snapshot_id: session.pin.grant_snapshot_id,
    lifecycle_epoch: session.pin.lifecycle_epoch, grant_epoch: session.pin.grant_epoch,
    artifact_digest: session.experience.artifact_digest,
  } : null, [session]);
  const [source, setSource] = useState<{ bindingId: string; recordId: string;resourceKey?:string } | null>(null);
  const [runReview, setRunReview] = useState<ExperienceRunReviewTarget | null>(null);
  const runReviewReturn = useRef<HTMLElement | null>(null);
  const runReviewOpener = useRef<{ element: HTMLElement; key?: string; host: HTMLDivElement; sessionId: string } | null>(null);
  useEffect(() => { runReviewOpener.current = null; }, [session?.pin.session_id]);
  const [confirmation,setConfirmation]=useState<ExperienceConfirmationRequest|null>(null);
  const [recordAction,setRecordAction]=useState<RecordActionRequest|null>(null);
  const [resourceAction,setResourceAction]=useState<ResourceActionRequest|null>(null);
  const resourceActionReply=useRef<ResourceActionRequest['finish']|null>(null);
  const [resourceBatch,setResourceBatch]=useState<ResourceActionBatchRequest|null>(null);
  const resourceBatchReply=useRef<ResourceActionBatchRequest['finish']|null>(null);
  const confirmationReply=useRef<((result:unknown)=>void)|null>(null);
  const closeConfirmation=useCallback((unknown=false)=>{confirmationReply.current?.(unknown?{unknown:true}:{cancelled:true});confirmationReply.current=null;setConfirmation(null);},[]);
  const [composer, setComposer] = useState<ExperienceComposeRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<ExperienceSettingsSection>('accounts');
  const [accountSetupOpen, setAccountSetupOpen] = useState(false);
  const [accountSetupPending, setAccountSetupPending] = useState(false);
  const [connectionSetupBusy, setConnectionSetupBusy] = useState(false);
  const connectionNavigation = useRef<PendingAppConnection | null>(null);
  const onConnectionNavigation = useCallback((pending: PendingAppConnection | null) => { connectionNavigation.current = pending; }, []);
  const connectionBusyRef = useRef(false);
  const connectionBusy = useCallback((busy: boolean) => { connectionBusyRef.current = busy; setConnectionSetupBusy(busy); }, []);
  const settingsOpenRef = useRef(false);
  const completeAccountSetup = useCallback((target: string) => {
    if (document.hidden || !api.getAccessToken()) return;
    const scope=targetPreferenceScope&&experienceTargetPreferenceKey(targetPreferenceScope);
    if(scope)targetNomination.current={scope,target};
    setAccountSetupPending(true); settingsOpenRef.current = true; setSettingsSection('accounts'); setSettingsOpen(true);
    setResourceTarget(target); setOpening(value => value + 1);
  }, [targetPreferenceScope]);
  const refreshNavigation = useRef<(() => void) | null>(null);
  const navigationBusy = useRef(false);
  const composerOpen = useRef(false); composerOpen.current = !!composer||!!confirmation||!!recordAction||!!resourceAction;
  const [appName, setAppName] = useState('App');
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
  const closeRunReview = () => {
    const target = runReviewOpener.current;
    setRunReview(null);
    requestAnimationFrame(() => {
      if (!target || runReviewOpener.current !== target || target.sessionId !== session?.pin.session_id
        || target.host !== viewHost.current || !target.host.isConnected || document.hidden
        || document.activeElement !== document.body) return;
      // Worker views replace buttons while a native review is open. Resolve the
      // same node in this Experience only, after the dialog has unmounted.
      const opener = target.element.isConnected ? target.element
        : target.key ? Array.from(target.host.querySelectorAll<HTMLButtonElement>('button[data-focus-key]'))
          .find(element => element.dataset.focusKey === target.key && !element.disabled) : null;
      opener?.focus();
    });
  };
  const rendered = useRef(false);
  const [renewalBusy, setRenewalBusy] = useState(false);
  const [renewalNotice, setRenewalNotice] = useState<string | null>(null);
  const renewalGeneration = useRef(0);
  const leaseCurrent = useRef<ReturnType<typeof createExperienceLease> | null>(null);
  const ensureAuthority = useRef<(() => Promise<boolean>) | null>(null);
  const dispatchedWrites = useRef(new Set<Promise<unknown>>());
  const flushRecordWrites=useRef<(()=>Promise<boolean>)|null>(null);
  const showSettings = useCallback(async (open: boolean, section: ExperienceSettingsSection = 'accounts') => {
    if (document.hidden || navigationBusy.current || composerOpen.current || connectionBusyRef.current) return;
    if (!open) {
      settingsOpenRef.current = false; setSettingsOpen(false); refreshNavigation.current?.(); return;
    }
    navigationBusy.current = true;
    const token = api.getAccessToken();
    const generation = reviewGeneration.current;
    try {
      if (viewHost.current) flushExperienceInputs(viewHost.current);
      if(flushRecordWrites.current&&!await flushRecordWrites.current())throw Error('Save the draft or reopen its saved version before leaving.');
      if (!await settleDispatchedExperienceWrites(dispatchedWrites.current)) throw new Error('A draft save is not confirmed. Check the save status before opening settings.');
      if (!token || document.hidden || generation !== reviewGeneration.current || !isSameWebSession(token, api.getAccessToken())) return;
      if (document.hidden || generation !== reviewGeneration.current || !isSameWebSession(token, api.getAccessToken())) return;
      settingsOpenRef.current = open; setSettingsSection(section); setSettingsOpen(open); setSource(null);
      sourceReturn.current = null; setRenewalNotice(null); refreshNavigation.current?.();
    } catch (cause) { if (generation === reviewGeneration.current) setRenewalNotice(cause instanceof Error ? cause.message : 'Settings are unavailable.'); }
    finally { navigationBusy.current = false; }
  }, []);
  useEffect(() => {
    settingsOpenRef.current = false; setSettingsOpen(false); setSettingsSection('accounts'); setAccountSetupOpen(false); setAccountSetupPending(false); setAppName('App');
  }, [installationId, experienceKey, sessionCacheScope]);
  useEffect(() => () => {
    renewalGeneration.current += 1;
  }, [installationId, experienceKey, sessionCacheScope]);

  const switchResourceTarget = async (target: string) => {
    if (renewalBusy || connectionBusyRef.current || document.hidden || composer || target === (session?.resource_target_key??resourceTarget)
      || !resourceTargets.some(item => item.key === target)) return;
    const ticket = ++renewalGeneration.current;
    const token = api.getAccessToken();
    setRenewalBusy(true); setRenewalNotice(null);
    try {
      if (viewHost.current) flushExperienceInputs(viewHost.current);
      if(flushRecordWrites.current&&!await flushRecordWrites.current())throw Error('Save the draft or reopen its saved version before leaving.');
      if (!await settleDispatchedExperienceWrites(dispatchedWrites.current)) {
        throw new Error('A draft save is not confirmed. Check the save status before switching accounts.');
      }
      if (ticket !== renewalGeneration.current || document.hidden || !token || !isSameWebSession(token, api.getAccessToken())) return;
      const scope=targetPreferenceScope&&experienceTargetPreferenceKey(targetPreferenceScope);
      if(scope)targetNomination.current={scope,target};
      setResourceTarget(target);
    } catch (cause) {
      if (ticket === renewalGeneration.current) setRenewalNotice(cause instanceof Error ? cause.message : 'Unable to switch accounts.');
    } finally { if (ticket === renewalGeneration.current) setRenewalBusy(false); }
  };

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
      if(flushRecordWrites.current&&!await flushRecordWrites.current())throw Error('Save the draft or reopen its saved version before leaving.');
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
    setSession(null); setResourceTargets([]); setSource(null); setRunReview(null); closeComposer(true);closeConfirmation(true); setRecoveryReady(false); setRecoveryStates([]);
    setError(null); setSuspended(false); setConnectionUnavailable(false);
    setReady(false);
    setReview(null); setExposure(null); setExposureBusy(false); setStartupPhase(null); setStartupDiagnostic(null); reviewGeneration.current += 1;
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
    const retireOwnedSession = (navigation = false) => {
      if (!ownedSessionId) return;
      const id = ownedSessionId;
      ownedSessionId = null;
      if (!navigation || connectionSessionRetirementRequired(connectionNavigation.current, id)) void retireSession(id);
    };
    const pageHide = () => {
      cancelled = true;
      abort.abort();
      stopWorker.current?.(connectionSessionRetirementRequired(connectionNavigation.current, ownedSessionId ?? ''));
      retireOwnedSession(true);
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
        const targetsResponse = await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/targets`, {
          signal: abort.signal,
        });
        if (experienceAuthorityResponse(targetsResponse) === 'unavailable') throw new ExperienceAuthorityUnavailable();
        if (!targetsResponse.ok) throw new Error(await appApiError(targetsResponse, 'Private sources are unavailable.'));
        const targets = await targetsResponse.json();
        if (targets?.schema_version !== 'deft.experience_targets.v1' || !Array.isArray(targets.targets)
          || targets.targets.length > 64 || targets.targets.some((item: { key?: unknown; label?: unknown }) =>
            typeof item?.key !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(item.key)
            || typeof item.label !== 'string' || item.label.length > 80)
          || new Set(targets.targets.map((item: { key: string }) => item.key)).size !== targets.targets.length) {
          throw new Error('Private source list is invalid.');
        }
        if (!openingCurrent()) return;
        setResourceTargets(targets.targets);
        const preferenceScope={orgId:org.id,userId:user.id,installationId};
        const preferenceKey=experienceTargetPreferenceKey(preferenceScope);
        const selectedTarget=targetPreference.select(preferenceScope,targets.targets,openingCurrent,
          targetNomination.current?.scope===preferenceKey?targetNomination.current.target:undefined);
        if(!selectedTarget)return;
        const response = await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/sessions`, {
          method: 'POST', signal: abort.signal, body: JSON.stringify({ resource_target_key: selectedTarget }),
        });
        if (experienceAuthorityResponse(response) === 'unavailable') throw new ExperienceAuthorityUnavailable();
        if (!response.ok) throw new Error(await appApiError(response, 'This Experience is unavailable.'));
        const created = normalizeInstalledExperienceSession(await response.json());
        ownedSessionId = created.pin.session_id;
        if (created.pin.org_id !== org.id || created.pin.user_id !== user.id
          || created.pin.app_installation_id !== installationId
          || (created.resource_target_key ?? 'primary') !== selectedTarget
          || created.experience.key !== experienceKey) throw new Error('Experience session identity changed.');
      if (openingCurrent() && created.app_name) setAppName(created.app_name);
        if (!cancelled && !document.hidden) {
          if (created.bundle.resource_keys.length || created.bundle.state_keys?.length || created.bundle.record_store_keys?.length) {
            setExposureBusy(true);
            const acquired = await api.fetch(`${root}/sessions/${encodeURIComponent(created.pin.session_id)}/access/acquire`, { method: 'POST', signal: abort.signal, body: '{}' });
            if (experienceAuthorityResponse(acquired) === 'unavailable') throw new ExperienceAuthorityUnavailable();
            if (!acquired.ok) throw new Error(await appApiError(acquired, 'Private access is unavailable.'));
            const access = normalizeExperienceAccess(await acquired.json());
            if (cancelled) { retireOwnedSession(); return; }
            setRecoveryStates(access.states); setExposure(access.exposure); setExposureBusy(false);
          }
          if(!openingCurrent()){retireOwnedSession();return;}
          if(preferenceKey)targetNomination.current={scope:preferenceKey,target:selectedTarget};
          targetPreference.remember(preferenceScope,targets.targets,selectedTarget,openingCurrent);
          openingComplete = true; setConnectionUnavailable(false); setSuspended(false);
          setAccountSetupOpen(false); setAccountSetupPending(false); setSession(created); setReady(true);
        }
        else {
          retireOwnedSession();
          if (openingCurrent()) { setSuspended(true); retry = setTimeout(() => { if (!document.hidden) setOpening(value => value + 1); }, 5000); }
        }
      } catch (cause) {
        retireOwnedSession();
        if (openingCurrent()) {
          setAccountSetupPending(false);
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
      stopWorker.current?.(connectionSessionRetirementRequired(connectionNavigation.current, ownedSessionId ?? '')); retireOwnedSession(true);
      reviewGeneration.current += 1; setReview(null); setExposure(null);
    };
  }, [installationId, experienceKey, user?.id, org?.id, sessionCacheScope, opening, resourceTarget, closeComposer, closeConfirmation]);

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
      || ((session.bundle.resource_keys.length > 0 || !!session.bundle.state_keys?.length || !!session.bundle.record_store_keys?.length) && !exposure)) return;
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
    type TrustedDocument={key:string;recordId:string;format:string;content:string};
    let trustedDocument:TrustedDocument|null=null;
    // Current Worker lifetime only; retain no review token and never create/accept access here.
    const sourceReview=createExperiencePresentationReviewCache<Pick<ExperienceExposureReview,'review_digest'|'snapshot'>>();
    const sourcePolicy=async(key:string,signal:AbortSignal)=>{
      if(!exposure||!locallyCurrent()||signal.aborted||!session.bundle.resource_keys.includes(key))return undefined;
      const value=await sourceReview.read(signal,async signal=>{const r=await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access/review`,{method:'POST',signal,body:'{}'});if(!r.ok)throw Error('Source unavailable');const {review_digest,snapshot}=normalizeExperienceExposureReview(await r.json());if(!locallyCurrent()||signal.aborted)throw Error('Source unavailable');return {review_digest,snapshot};});
      // Deny this expired read; a later explicit operation may fetch a fresh read-only snapshot.
      if(Date.parse(value.snapshot.expires_at)<=Date.now())sourceReview.invalidate(value);
      return reviewedSourcePolicy(value,exposure,{artifact_digest:session.experience.artifact_digest,resource_keys:session.bundle.resource_keys},key,()=>locallyCurrent()&&!signal.aborted,lease?.value.exposure);
    };
    const sourcePresentations=new Map<string,Promise<{presentation:SourcePresentation;expires_at:string}>>();
    const presentationDisposals=new Map<string,{document:TrustedDocument;mount:ReturnType<typeof mountExperienceSourcePresentation>}>();let usedPresentations=new Set<string>();
    const presentationPrinters=new Map<string,()=>boolean>();
    const sourcePresentation=async(key:string,recordId:string,signal:AbortSignal)=>{
      const cacheKey=`${key}/${recordId}`;let pending=sourcePresentations.get(cacheKey);
      if(!pending){pending=(async()=>{if(!exposure||!locallyCurrent()||!await sourcePolicy(key,signal))throw Error('Source unavailable');const r=await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/resources/${encodeURIComponent(key)}/content`,{method:'POST',signal,body:JSON.stringify({operation:'read_presentation',record_id:recordId})});if(!r.ok)throw Error('Source unavailable');const value=parseSourceView(await r.json(),exposure);if(!value.presentation||!locallyCurrent()||signal.aborted)throw Error('Source unavailable');return {presentation:value.presentation,expires_at:value.expires_at};})();sourcePresentations.clear();sourcePresentations.set(cacheKey,pending);void pending.catch(()=>{if(sourcePresentations.get(cacheKey)===pending)sourcePresentations.delete(cacheKey);});}
      const value=await pending;if(Date.parse(value.expires_at)<=Date.now()&&sourcePresentations.get(cacheKey)===pending)sourcePresentations.delete(cacheKey);if(!locallyCurrent()||signal.aborted||Date.parse(value.expires_at)<=Date.now())throw Error('Source unavailable');return value;
    };
    const resourceDocuments=createExperienceResourceDocumentHost({resourceKeys:session.bundle.resource_keys,current:locallyCurrent,load:sourcePresentation,
      mount:(reference,node,wrap,current,load)=>{
        if(!exposure)throw Error('Source unavailable');
        return mountExperienceSourcePresentation({wrap,node,scope:exposure,sessionId:session.pin.session_id,resourceKey:reference.resource_key,recordId:reference.record_id,current,load,
          registerPrint:print=>{presentationPrinters.set(node.id,print);return()=>{if(presentationPrinters.get(node.id)===print)presentationPrinters.set(node.id,()=>true);};}});
      }});
    const fieldControls=createExperienceFieldControlHost({
      filesPolicy:async(node,signal)=>{
        if(!exposure||!locallyCurrent()||signal.aborted||!session.bundle.state_keys?.includes(node.state_key))throw Error('Files unavailable');
        const value=await sourceReview.read(signal,async signal=>{const response=await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/access/review`,{method:'POST',signal,body:'{}'});
          if(!response.ok)throw Error('Files unavailable');const {review_digest,snapshot}=normalizeExperienceExposureReview(await response.json());return {review_digest,snapshot};});
        const effective=lease?.value.exposure??exposure;
        if(!locallyCurrent()||signal.aborted||effective.exposure_id!==exposure.exposure_id||effective.exposure_epoch!==exposure.exposure_epoch
          ||value.review_digest!==effective.review_digest||value.snapshot.artifact_digest!==session.experience.artifact_digest
          ||Date.parse(value.snapshot.expires_at)<=Date.now())throw Error('Files unavailable');
        const rows=value.snapshot.private_state?.filter(row=>row.key===node.state_key);
        if(rows?.length!==1||!rows[0].files||!rows[0].allowed_operations.includes('read')||!rows[0].allowed_operations.includes('put'))throw Error('Files unavailable');
        return rows[0].files;
      },
      filesCall:async(node,suffix,options)=>{
        if(!exposure||!locallyCurrent()||options.signal?.aborted||!session.bundle.state_keys?.includes(node.state_key))throw Error('Files unavailable');
        const response=await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/state/${encodeURIComponent(node.state_key)}/${encodeURIComponent(node.record_id)}/files${suffix}`,options);
        if(!response.ok)throw Error('Files unavailable');const value:unknown=await response.json();
        if(!locallyCurrent()||options.signal?.aborted)throw Error('Files unavailable');return value;
      },
    });
    const sourceNominationAbort=new AbortController();
    const dataClient=createExperienceDataClient({installationId,principal:{orgId:session.pin.org_id,userId:session.pin.user_id},targetKey:session.resource_target_key??resourceTarget,current:locallyCurrent,fetch:(path,options)=>api.fetch(path,options),
      review:async(node,row,signal,recovery)=>{
        if(!locallyCurrent()||!node.action_key||!session.bundle.action_keys.includes(node.action_key)||!await live())throw Error('Review unavailable');
        const target=await dataClient.select(node.store_key,signal);if(!locallyCurrent()||signal.aborted)throw Error('Review unavailable');
        return new Promise<boolean>(resolve=>{let finished=false;const aborted=()=>finish(false);const finish=(submitted=false)=>{if(finished)return;finished=true;signal.removeEventListener('abort',aborted);setRecordAction(current=>current?.finish===finish?null:current);resolve(submitted);};
          signal.addEventListener('abort',aborted,{once:true});setRecordAction({node,row,signal,current:locallyCurrent,ports:dataClient.ports,sessionId:session.pin.session_id,targetKey:target.target_key,connectionSessionId:target.session_id,futureSubmissionId:typeof row.summary?.future_submission_id==='string'?row.summary.future_submission_id:undefined,futurePolicy:target.stores.find(store=>store.declaration.key===node.store_key)?.declaration.future_record_actions?.find(policy=>policy.action_key===node.action_key),dataAuthorityExpiresAt:target.stores.find(store=>store.declaration.key===node.store_key)?.consent?.expires_at,recovery,finish});});
      }});
    type ChildValue={session:InstalledExperienceSession;exposure:ExperienceExposureStatus;lease:ReturnType<typeof createExperienceLease>;client:typeof dataClient};
    const createdRecords=new Map<string,AccountChild<ChildValue>>(),routedRuns=new Map<string,AccountChild<ChildValue>>();
    const accounts=createExperienceAccountRouting<ChildValue>({current:locallyCurrent,
      catalog:async signal=>{const response=await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/targets`,{signal,cache:'no-store'});if(!response.ok)throw Error('Account catalog unavailable');const body=await response.json();if(body.schema_version!=='deft.experience_targets.v1'||!Array.isArray(body.targets))throw Error('Account catalog invalid');return body.targets;},
      open:async(targetKey,signal)=>{
        if(targetKey===(session.resource_target_key??resourceTarget)){if(!exposure||!lease)throw Error('Account review required');const target=await dataClient.select(session.bundle.record_store_keys?.[0]??'drafts',signal);return {targetKey,accountRef:target.account.account_ref,label:target.account.label,value:{session,exposure,lease,client:dataClient}};}
        const response=await api.fetch(`${root}/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}/sessions`,{method:'POST',signal,body:JSON.stringify({resource_target_key:targetKey})});if(!response.ok)throw Error('Account unavailable');const child=normalizeInstalledExperienceSession(await response.json());
        try{if(child.pin.org_id!==session.pin.org_id||child.pin.user_id!==session.pin.user_id||child.pin.app_installation_id!==installationId||child.resource_target_key!==targetKey||child.experience.artifact_digest!==session.experience.artifact_digest)throw Error('Account child changed');
          const response=await api.fetch(`${root}/sessions/${encodeURIComponent(child.pin.session_id)}/access/acquire`,{method:'POST',signal,body:'{}'});if(!response.ok)throw Error('Account review required');const access=normalizeExperienceAccess(await response.json());if(!access.exposure)throw Error('Account review required');
          let pinnedAccount:string|undefined;let client:typeof dataClient;client=createExperienceDataClient({installationId,targetKey,accountRef:()=>pinnedAccount,principal:{orgId:child.pin.org_id,userId:child.pin.user_id},current:locallyCurrent,fetch:(path,options)=>api.fetch(path,options),review:async(node,row,signal,recovery)=>{
            const target=await client.select(node.store_key,signal);if(!locallyCurrent()||!node.action_key||!child.bundle.action_keys.includes(node.action_key)||!await live(signal))throw Error('Review unavailable');
            return new Promise<boolean>(resolve=>{let finished=false;const finish=(submitted=false)=>{if(finished)return;finished=true;signal.removeEventListener('abort',aborted);setRecordAction(current=>current?.finish===finish?null:current);resolve(submitted);};const aborted=()=>finish(false);signal.addEventListener('abort',aborted,{once:true});setRecordAction({node,row,signal,current:locallyCurrent,ports:client.ports,sessionId:child.pin.session_id,targetKey,connectionSessionId:target.session_id,futureSubmissionId:typeof row.summary?.future_submission_id==='string'?row.summary.future_submission_id:undefined,futurePolicy:target.stores.find(store=>store.declaration.key===node.store_key)?.declaration.future_record_actions?.find(policy=>policy.action_key===node.action_key),dataAuthorityExpiresAt:target.stores.find(store=>store.declaration.key===node.store_key)?.consent?.expires_at,recovery,finish});});
          }});const target=await client.select(child.bundle.record_store_keys?.[0]??'drafts',signal);pinnedAccount=target.account.account_ref;
          const childLease=createExperienceLease({initial:{session_expires_at:child.expires_at,exposure:access.exposure},current:locallyCurrent,refresh:async()=>{
            let refreshed:string|null;try{refreshed=await refreshAccessToken();}catch(error){if(error instanceof SessionRefreshUnavailableError)throw new ExperienceAuthorityUnavailable();throw error;}
            if(!refreshed||!locallyCurrent())throw Error('Account access ended');
            const response=await readExperienceAuthority(locallyCurrent,()=>api.fetch(`${root}/sessions/${encodeURIComponent(child.pin.session_id)}/refresh`,{method:'POST',body:'{}',signal:AbortSignal.timeout(10_000)}));
            if(experienceAuthorityResponse(response)==='unavailable')throw new ExperienceAuthorityUnavailable();if(!response?.ok)throw Error('Account access ended');
            return normalizeExperienceLeaseRefresh(await response.json());
          }});
          return {targetKey,accountRef:target.account.account_ref,label:target.account.label,value:{session:child,exposure:access.exposure,lease:childLease,client}};
        }catch(error){void retireSession(child.pin.session_id);throw error;}
      },validate:async(child,signal)=>{signal.throwIfAborted();if(!locallyCurrent()||!await (child.value.session.pin.session_id===session.pin.session_id?live(signal):child.value.lease.ensure()))return false;signal.throwIfAborted();if(!locallyCurrent()||!child.value.lease.valid())return false;const target=await child.value.client.select(child.value.session.bundle.record_store_keys?.[0]??'drafts',signal);signal.throwIfAborted();if(!locallyCurrent()||!child.value.lease.valid()||target.account.account_ref!==child.accountRef)return false;if(child.value.session.pin.session_id===session.pin.session_id)return live(signal);
        const [liveResponse,exposureResponse]=await Promise.all([api.fetch(livePath(child.value.session.pin.session_id),{signal,cache:'no-store'}),api.fetch(`${root}/sessions/${encodeURIComponent(child.value.session.pin.session_id)}/exposure`,{signal,cache:'no-store'})]);signal.throwIfAborted();if(!locallyCurrent()||!child.value.lease.valid()||[liveResponse,exposureResponse].some(response=>[401,403,404,410].includes(response.status)))return false;if(!liveResponse.ok||!exposureResponse.ok)throw Error('Account temporarily unavailable');const current=normalizeExperienceExposureStatus(await exposureResponse.json());signal.throwIfAborted();const effective=child.value.lease.value.exposure;return locallyCurrent()&&child.value.lease.valid()&&Date.parse(current.expires_at)>Date.now()&&current.exposure_id===effective.exposure_id&&current.exposure_epoch===effective.exposure_epoch&&current.review_digest===effective.review_digest;},
      retire:child=>{if(child.value.session.pin.session_id!==session.pin.session_id){child.value.lease.dispose();void retireSession(child.value.session.pin.session_id);}for(const [id,owner]of createdRecords)if(owner.targetKey===child.targetKey)createdRecords.delete(id);for(const [id,owner]of routedRuns)if(owner.targetKey===child.targetKey)routedRuns.delete(id);},
    });
    const nominateSource=async(nomination:NonNullable<ReturnType<typeof parseSourceNomination>>,owner:AccountChild<ChildValue>,current:()=>boolean,signal:AbortSignal,taskOnly=false)=>{
      const sourceClient=owner.value.client;
      const presentation=await openSourceNomination(nomination,{current,storeKeys:owner.value.session.bundle.record_store_keys??[],resourceKeys:owner.value.session.bundle.resource_keys,select:sourceClient.select,read:async(ref,signal)=>{const result=await accounts.execute(owner,signal,()=>sourceClient.request(ref.store_key,'resource_read_presentation',ref,signal));if(!result.presentation)throw Error('Source unavailable');return parseExperienceDataPresentation(result.presentation,owner.value.exposure,owner.value.lease.value.exposure.expires_at).presentation;}},signal);
      const exactSource={resource_key:nomination.resource_key,record_id:nomination.record_id,content_digest:nomination.content_digest};accounts.retain(owner,[exactSource]);
      const calendarOwner=async(signal:AbortSignal)=>{const target=await sourceClient.select('drafts',signal),owner=await accounts.child(target.target_key,signal);if(!locallyCurrent()||signal.aborted||owner.accountRef!==nomination.account_ref)throw Error('Invitation account changed');return owner;};
      const replyInput=(intent:Record<string,unknown>)=>({store_key:'drafts',value:intent,source_refs:[exactSource]});
      if(current()&&!signal.aborted)setNominatedSource({nomination,installationId,scopeKey:JSON.stringify([sessionCacheScope,session.pin.org_id,session.pin.user_id,installationId]),presentation,taskOnly,current:()=>current()&&owner.value.lease.valid()&&!signal.aborted,signal,calendar:{
        listFiles:async signal=>{const result=await sourceClient.request(nomination.store_key,'resource_list_files',{store_key:nomination.store_key,...exactSource},signal);if((await sourceClient.select(nomination.store_key,signal)).account.account_ref!==nomination.account_ref)throw Error('Invitation account changed');return result.files??[];},
        createReply:async(intent,requestId,signal)=>{const owner=await calendarOwner(signal),result=await owner.value.client.request('drafts','record_create',replyInput(intent),signal,requestId);if(!result.record||result.record.store_key!=='drafts'||(await calendarOwner(signal)).accountRef!==owner.accountRef)throw Error('Response draft unconfirmed');createdRecords.set(result.record.record_id,owner);return result.record.record_id;},
        replyStatus:async(intent,requestId,signal)=>{const owner=await calendarOwner(signal),result=await owner.value.client.request('drafts','request_status',{store_key:'drafts',request_id:requestId},signal),status=result.request_status;if(!status||status.state!=='completed')return null;if(status.request_id!==requestId||status.operation!=='record_create'||status.input_digest!==await appDataInputDigest('record_create',replyInput(intent))||!status.record_id)throw Error('Response draft changed');const record=await owner.value.client.request('drafts','record_read',{store_key:'drafts',record_id:status.record_id},signal);if(!record.record||(await calendarOwner(signal)).accountRef!==owner.accountRef)throw Error('Response draft changed');createdRecords.set(status.record_id,owner);return status.record_id;},
      }});
    };
    if(exposure){void (async()=>{const nomination=parseSourceNomination(new URLSearchParams(location.search));if(!nomination)return;
      const owner=await resolveSourceNominationAccount(nomination,{current:locallyCurrent,catalog:accounts.catalog,child:accounts.child},sourceNominationAbort.signal);
      await nominateSource(nomination,owner,locallyCurrent,sourceNominationAbort.signal);
    })().catch(()=>{if(locallyCurrent())setRenewalNotice('The original source is unavailable or this account needs review.');});}
    const sourceChild=(refs:readonly AccountReference[],signal:AbortSignal)=>accounts.source(refs,signal);
    const recordClient=async(node:{record_id:string;resource_key?:string;content_digest?:string},signal:AbortSignal)=>{
      if(node.resource_key&&node.content_digest)return (await sourceChild([{resource_key:node.resource_key,record_id:node.record_id,content_digest:node.content_digest}],signal)).value.client;
      const owner=createdRecords.get(node.record_id);return owner?(await accounts.child(owner.targetKey,signal)).value.client:dataClient;
    };
    const sourceCall=async<T extends {bytes?:Uint8Array}>(reference:{record_id:string;resource_key?:string;content_digest?:string},signal:AbortSignal,work:(client:typeof dataClient)=>Promise<T>):Promise<T>=>{const result=await work(await recordClient(reference,signal));try{await recordClient(reference,signal);return result;}catch(error){result.bytes?.fill(0);throw error;}};
    const routedPorts=new Proxy(dataClient.ports,{get(target,key: keyof typeof dataClient.ports){const method=target[key];if(typeof method!=='function')return method;return async(...args:unknown[])=>{const node=args[0] as {record_id:string},signal=args.find(arg=>arg instanceof AbortSignal) as AbortSignal|undefined;if(!signal)throw Error('Record operation signal required');const client=await recordClient(node,signal);const result=await (client.ports[key] as (...values:unknown[])=>unknown)(...args);await recordClient(node,signal);const row=result&&typeof result==='object'&&'record'in result?(result as {record?:unknown}).record:result;if(row&&typeof row==='object'&&'summary'in row){const runId=(row as {summary?:{run_id?:unknown}}).summary?.run_id,owner=createdRecords.get(node.record_id);if(owner&&typeof runId==='string'&&/^[0-9a-f-]{36}$/i.test(runId)){const previous=routedRuns.get(runId);if(previous&&previous.accountRef!==owner.accountRef){accounts.forget(previous.targetKey);accounts.forget(owner.targetKey);throw Error('Run account collision');}routedRuns.set(runId,owner);}}return result;};}});
    const recordMirrorControls=createExperienceRecordMirrorHost({experienceId:session.pin.session_id,select:(store,signal)=>dataClient.select(store,signal),current:locallyCurrent,fetch:(path,options)=>api.fetch(path,options)});
    const localJobControls=createExperienceLocalJobHost({select:async(store,signal,ref)=>(ref?(await sourceChild([ref],signal)).value.client:dataClient).select(store,signal),current:locallyCurrent,fetch:(path,options)=>api.fetch(path,options)});
    const recordForms=createExperienceRecordFormHost({...routedPorts,
      deliverSubmitted:(node,row,signal)=>deliverExperienceRecordSubmission({confirmed:true,nodeId:node.id,row,signal,current:locallyCurrent,
        send:(event,signal)=>bridge.sendUiEvent(event,{signal})}),
      reopenSubmitted:()=>{
        if(!locallyCurrent()||navigationBusy.current)return;navigationBusy.current=true;
        void reopenExperienceAfterSubmission({confirmed:true,current:locallyCurrent,
          flush:async()=>{if(viewHost.current)flushExperienceInputs(viewHost.current);return await flushRecordWrites.current?.()??false;},
          settle:()=>settleDispatchedExperienceWrites(dispatchedWrites.current),reopen:()=>setOpening(value=>value+1),
        }).then(reopened=>{if(!reopened&&locallyCurrent())setRenewalNotice('A draft save is not confirmed. Check its saved state before reopening the app.');})
          .finally(()=>{navigationBusy.current=false;});
      },
    });
    flushRecordWrites.current=recordForms.flushRecordForms;
    const recordDocuments=createExperienceRecordDocumentHost({storeKeys:session.bundle.record_store_keys??[],resourceKeys:session.bundle.resource_keys,current:locallyCurrent,
      load:async(reference,signal)=>{
        if(!exposure)throw Error('Source unavailable');const client=await recordClient(reference,signal),result=await client.presentation(reference,signal);
        await recordClient(reference,signal);const presentation=result.presentation;if(!presentation)throw Error('Source unavailable');
        const effective=lease?.value.exposure??exposure;return parseExperienceDataPresentation(presentation,exposure,effective.expires_at);
      },mount:(reference,node,wrap,current,load)=>{
        if(!exposure)throw Error('Source unavailable');const controller=new AbortController();
        const presentation=mountExperienceSourcePresentation({wrap,node,scope:exposure,sessionId:session.pin.session_id,resourceKey:reference.resource_key,recordId:reference.record_id,current,load,maxSourceBytes:35*1048576,
          authorizedLifetime:()=>lease?.value,automaticImages:async signal=>{const client=await recordClient(reference,signal),result=await client.automaticImages(reference,signal);await recordClient(reference,signal);return result;},
          readBinary:async(input,signal)=>sourceCall(reference,signal,client=>client.sourceBinary(reference,{...input,...(input.image_ref?{image_ref:'sha256:'+input.image_ref}:{})},signal)),
          registerPrint:print=>{presentationPrinters.set(node.id,print);return()=>{if(presentationPrinters.get(node.id)===print)presentationPrinters.delete(node.id);};}});
        const input={store_key:reference.store_key,resource_key:reference.resource_key,record_id:reference.record_id,content_digest:reference.content_digest};
        const files=mountExperienceDataSourceFiles({wrapper:wrap,current,signal:controller.signal,
          list:async signal=>{const result=await (await recordClient(reference,signal)).request(reference.store_key,'resource_list_files',input,signal);await recordClient(reference,signal);return result.files?.map(file=>AppDataSourceFileSchema.parse(file))??[];},
          read:async(file,signal)=>sourceCall(reference,signal,client=>client.binary(reference.store_key,'resource_read_file',{...input,file_ref:file.file_ref},signal)),
          source:async signal=>sourceCall(reference,signal,client=>client.sourceBinary(reference,{operation:'read_source'},signal))});
        const task=mountRecordTaskEntry({wrapper:wrap,reference,current,signal:controller.signal,
          owner:(ref,signal)=>sourceChild([ref],signal),
          open:(nomination,owner,signal)=>nominateSource(nomination,owner,current,signal,true)});
        return()=>{controller.abort();task();presentation();files();};
      }});
    const rendererOptions={capabilities:session.experience.capabilities,resourceKeys:session.bundle.resource_keys,stateKeys:session.bundle.state_keys,storeKeys:session.bundle.record_store_keys,actionKeys:session.bundle.action_keys,...resourceDocuments,...fieldControls,...localJobControls,...recordMirrorControls,...recordForms,...recordDocuments,
      printDocument:(node:Extract<ExperienceNode,{kind:'document'}>)=>presentationPrinters.get(node.id)?.()??false,enhanceDocument:(node:Extract<ExperienceNode,{kind:'document'}>,wrap:HTMLElement)=>{
      const known=trustedDocument;if(session.experience.renderer_version!=='deft.trusted_renderer.v1'||!known||known.format!==node.format||known.content!==node.content||!locallyCurrent()||!exposure)return;
      const mountKey=`${known.key}/${known.recordId}/${node.id}`;usedPresentations.add(mountKey);const existing=presentationDisposals.get(mountKey);if(existing?.document===known){existing.mount.attach(wrap);return;}existing?.mount();
      const dispose=mountExperienceSourcePresentation({wrap,node,scope:exposure,sessionId:session.pin.session_id,resourceKey:known.key,recordId:known.recordId,current:()=>locallyCurrent()&&trustedDocument===known,load:(signal)=>sourcePresentation(known.key,known.recordId,signal),registerPrint:print=>{presentationPrinters.set(node.id,print);return()=>{if(presentationPrinters.get(node.id)===print)presentationPrinters.set(node.id,()=>true);};}});presentationDisposals.set(mountKey,{document:known,mount:dispose});
    }};
    const sendViewEvent=(event:unknown)=>bridge.sendUiEvent(event);
    const renderHostView=(view:ExperienceView)=>{usedPresentations=new Set();if(viewHost.current){renderExperienceView(viewHost.current,view,event=>sendViewEvent(event),rendererOptions);startup.view();}for(const [key,entry]of presentationDisposals)if(!usedPresentations.has(key)){entry.mount();presentationDisposals.delete(key);}if(!usedPresentations.size)sourcePresentations.clear();};
    let latestView: ExperienceView | null = null;
    readingPreferencesChanged.current=()=>{
      if(!locallyCurrent())return;
      sourcePresentations.clear();for(const entry of presentationDisposals.values())entry.mount();presentationDisposals.clear();
      if(latestView)renderHostView(latestView);
    };
    const navigationOwner = Symbol('experience-navigation');
    // Outside the Worker ID grammar: an author cannot intercept this host entry.
    const settingsId = '@deft/settings';
    const publishViewNavigation = (view: ExperienceView) => {
      if (!locallyCurrent()) { clearNavigation(navigationOwner); return; }
      publishNavigation({ owner: navigationOwner, installationId,
        pathname: `/apps/${encodeURIComponent(installationId)}/${encodeURIComponent(experienceKey)}`,
        scope: sessionCacheScope, items: [...(view.navigation ?? []).map(item => settingsOpenRef.current ? { ...item, selected: false } : item),
          { kind: 'button', id: settingsId, label: `${appName} settings`, variant: 'secondary', selected: settingsOpenRef.current }],
        select: (id) => {
          if (!locallyCurrent() || navigationBusy.current || composerOpen.current || connectionBusyRef.current) return;
          if (id === settingsId) { void showSettings(true); return; }
          const item = latestView?.navigation?.find(item => item.id === id);
          if (!item || item.disabled) return;
          if (viewHost.current) flushExperienceInputs(viewHost.current);
          settingsOpenRef.current = false; setSettingsOpen(false);
          setSource(null); sourceReturn.current = null;
          void sendViewEvent({ kind: 'click', node_id: id });
          if (latestView) publishViewNavigation(latestView);
        },
      });
    };
    refreshNavigation.current = () => { if (latestView) publishViewNavigation(latestView); };
    const knownRunIds = new Set<string>();
    const port = new MessageChannel();
    const frame = document.createElement('iframe');
    frame.title = 'Isolated App Experience Worker';
    frame.sandbox.add('allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    // Transport diagnostics only: never retain message data, origins or identity values.
    const bootstrapDiagnostic = { load_observed: false, ready_candidate_seen: false,
      ready_source_match: false, ready_origin_opaque: false, ready_shape_exact: false,
      ready_identity_current: false, ready_accepted: false, start_transfer_attempted: false };
    const onBootstrapLoad = () => { if (!stopped) bootstrapDiagnostic.load_observed = true; };
    const connection = createExperienceConnection({ current: identityCurrent, valid: authorityCurrent,
      read: async () => {
        if (!identityCurrent()) return 'denied';
        if (lease && !await lease.ensure()) return 'denied';
        if (!authorityCurrent()) return 'denied';
        const [response, status] = await readExperienceAuthorityPair(authorityCurrent,
          () => api.fetch(livePath(session.pin.session_id), { signal: AbortSignal.timeout(10_000) }),
          exposure ? () => api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/exposure`, { signal: AbortSignal.timeout(10_000) }) : undefined);
        if (!identityCurrent()) return 'denied';
        const responseState = experienceAuthorityResponse(response);
        if (responseState !== 'available') return responseState;
        if (exposure) {
          if (!identityCurrent()) return 'denied';
          const statusState = experienceAuthorityResponse(status);
          if (statusState !== 'available') return statusState;
          let current: ExperienceExposureStatus;
          try { current = normalizeExperienceExposureStatus(await status!.json()); } catch (error) { if (isExperienceAuthorityUnavailable(error)) throw error; return 'denied'; }
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
        if (!document.hidden) startWorker();
        if (recovering && !document.hidden && latestView && viewHost.current) {
          publishViewNavigation(latestView);
          renderHostView(latestView);
          rendered.current = true; setSuspended(false);
        }
      },
    });
    const live = connection.ensure;
    ensureAuthority.current = live;
    const startup = createExperienceStartup(phase => {
      const diagnostic = JSON.stringify({ ...bootstrapDiagnostic, identity_current: identityCurrent(),
        authority_current: authorityCurrent(), visible: !document.hidden, connection_available: !unavailable });
      stop();
      setStartupDiagnostic(diagnostic);
      setStartupPhase(phase);
      setError('The app could not open. Reconnect to try again.');
    });
    const bridge = createExperienceBridge({
      port: port.port1, pin: session.pin,
      resourceKeys: session.bundle.resource_keys,
      capabilities: session.experience.capabilities,
      stateKeys: session.bundle.state_keys,
      storeKeys:session.bundle.record_store_keys,
      actionKeys: session.bundle.action_keys,
      dialogKeys: experienceActionDialogKeys(session.protocol_version??''),
      broker: {
        isLive:(_pin,signal)=>live(signal),
        async appData(_pin,key,input,signal){
          if(!exposure||!locallyCurrent()||!session.bundle.record_store_keys?.includes(key)||!input||typeof input!=='object'||Array.isArray(input))return undefined;
          const intent=input as Record<string,unknown>;
          if(intent.operation==='account_catalog'){if(Object.keys(intent).sort().join(',')!=='input,operation')throw Error('Account catalog intent denied');const rows=await accounts.catalog(signal);return {targets:rows,selected_target_key:session.resource_target_key??resourceTarget};}
          if(Object.keys(intent).some(field=>!['input','operation','target_key'].includes(field)))throw Error('App data intent denied');const {target_key:requestedTarget,...releasedIntent}=intent;
          if(requestedTarget!==undefined&&(typeof requestedTarget!=='string'||!['resource_list','record_list'].includes(String(intent.operation))))throw Error('Only readonly account nomination is allowed');const request=AppDataRequestSchema.parse({schema_version:'deft.app_data_request.v1',request_id:crypto.randomUUID(),...releasedIntent});
          if(request.input.store_key!==key||!['record_list','record_read','record_create','record_archive','resource_list','resource_refresh','connection_metadata','request_status'].includes(request.operation)
            ||request.input.resource_key!==undefined&&!session.bundle.resource_keys.includes(String(request.input.resource_key)))throw Error('App data operation denied');
          if(request.operation==='connection_metadata'&&request.input.seed!==undefined)throw Error('Trusted seed metadata only');
          const refs=request.input.source_refs as readonly AccountReference[]|undefined,recordOwner=typeof request.input.record_id==='string'?createdRecords.get(request.input.record_id):undefined;
          let owner:AccountChild<ChildValue>,result:AppDataResult;
          if(requestedTarget!==undefined){
            try{({owner,result}=await accounts.listTarget(requestedTarget as string,signal,child=>child.value.client.request(key,request.operation,request.input,signal,request.request_id)));}
            catch(error){if(error instanceof Error&&error.message==='Account visibility ended')return {outcome:'not_found',items:[],account_state:'denied'};throw error;}
          }else{
            try{owner=refs?.length?await sourceChild(refs,signal):recordOwner?await accounts.child(recordOwner.targetKey,signal):request.input.anchor_record_id?await sourceChild([accounts.reference(String(request.input.resource_key),String(request.input.anchor_record_id))],signal):await accounts.child(session.resource_target_key??resourceTarget,signal);}catch(error){if(['resource_list','record_list'].includes(request.operation)&&error instanceof Error&&error.message==='Account visibility ended')return {outcome:'not_found',items:[],account_state:'denied'};throw error;}
            result=await accounts.execute(owner,signal,()=>owner.value.client.request(key,request.operation,request.input,signal,request.request_id));
          }
          if(owner&&request.operation==='resource_list'&&result.items)accounts.retain(owner,result.items.map(item=>({resource_key:String(request.input.resource_key),record_id:item.record_id,content_digest:item.content_digest})));
          const records=request.operation==='record_list'?result.items??[]:request.operation==='record_create'&&result.record?[result.record]:[];for(const item of records){const previous=createdRecords.get(item.record_id);if(previous&&previous.accountRef!==owner.accountRef){accounts.forget(previous.targetKey);accounts.forget(owner.targetKey);for(const target of [previous.targetKey,owner.targetKey])await bridge.sendUiEvent({kind:'click',node_id:'account_visibility_'+target});throw Error('Record account collision');}}for(const item of records){createdRecords.set(item.record_id,owner);const runId='summary' in item?item.summary?.run_id:undefined;if(typeof runId==='string'&&/^[0-9a-f-]{36}$/i.test(runId)){const previous=routedRuns.get(runId);if(previous&&previous.accountRef!==owner.accountRef)throw Error('Run account collision');routedRuns.set(runId,owner);}}
          if(!locallyCurrent()||signal.aborted)return undefined;
          // Only these explicit metadata projections may cross the small Worker port.
          const {presentation:_presentation,files:_files,prepared:_prepared,prepared_resource:_preparedResource,record:full,record_seed_value:_recordSeedValue,...metadata}=result;
          const record=full?AppDataRecordMetaSchema.parse(Object.fromEntries(Object.entries(full).filter(([field])=>field!=='value'&&field!=='files'))):undefined;
          if(request.operation==='record_read'){if(!record)throw Error('Record unavailable');return {...record,account_target_key:owner.targetKey};}
          return {...metadata,...(record?{record:{...record,account_target_key:owner.targetKey}}:{})};
        },
        async dialog(_pin, key, input, signal) {
          if(key==='review_resource_action_batch'){
            if(!exposure||!locallyCurrent()||composerOpen.current||resourceActionReply.current||resourceBatchReply.current)return undefined;
            let intent:ReturnType<typeof parseExperienceResourceActionBatch>;try{intent=parseExperienceResourceActionBatch(input,{actions:session.bundle.action_keys,stores:session.bundle.record_store_keys??[],resources:session.bundle.resource_keys});}catch{return undefined;}
            if(!await live(signal)||signal.aborted||!locallyCurrent())return undefined;
            const sources=intent.children.flatMap(child=>child.sources),first=intent.children[0]!;
            const source=await sourceChild(sources,signal);
            const refs=intent.children.flatMap(child=>[...(child.destination?[child.destination]:[]),...(child.labels?.add??[]),...(child.labels?.remove??[])]);
            if(refs.some(ref=>createdRecords.get(ref.record_id)&&createdRecords.get(ref.record_id)!.targetKey!==source.targetKey))throw Error('Mixed account action denied');
            const target=await source.value.client.select(first.store_key,signal),store=target.stores.find(item=>item.declaration.key===first.store_key);
            if(signal.aborted||!locallyCurrent()||composerOpen.current||resourceActionReply.current||resourceBatchReply.current||target.resource_key!==first.resource_key||!store?.consent||Date.parse(store.consent.expires_at)<=Date.now())return undefined;
            return new Promise(resolve=>{let finished=false;const finish:ResourceActionBatchRequest['finish']=value=>{if(finished)return;finished=true;if(value&&'items'in value)for(const item of value.items)routedRuns.set(item.run_id,source);signal.removeEventListener('abort',aborted);resourceBatchReply.current=null;setResourceBatch(current=>current?.finish===finish?null:current);resolve(value);};
              const aborted=()=>finish(undefined);signal.addEventListener('abort',aborted,{once:true});resourceBatchReply.current=finish;
              setResourceBatch({input:intent,sessionId:source.value.session.pin.session_id,targetKey:target.target_key,connectionSessionId:target.session_id,accountRef:target.account.account_ref,signal,current:locallyCurrent,ensureAuthority:live,finish});});
          }
          if(key==='review_resource_action'){
            if(!exposure||!locallyCurrent()||composerOpen.current||resourceActionReply.current||resourceBatchReply.current)return undefined;
            let intent:ReturnType<typeof parseExperienceResourceAction>;try{intent=parseExperienceResourceAction(input,{actions:session.bundle.action_keys,stores:session.bundle.record_store_keys??[],resources:session.bundle.resource_keys});}catch{return undefined;}
            if(!await live(signal)||signal.aborted||!locallyCurrent())return undefined;
            const recordRefs=[...(intent.record_sources??[]),...(intent.destination?[intent.destination]:[]),...(intent.labels?.add??[]),...(intent.labels?.remove??[])];const source=await resolveExperienceActionAccount({sources:intent.sources,recordRefs,fallbackTarget:session.resource_target_key??resourceTarget},{current:locallyCurrent,recordOwner:id=>createdRecords.get(id),source:sourceChild,child:accounts.child},signal);const target=await source.value.client.select(intent.store_key,signal),store=target.stores.find(item=>item.declaration.key===intent.store_key);
            if(signal.aborted||!locallyCurrent()||composerOpen.current||resourceActionReply.current||resourceBatchReply.current||target.resource_key!==intent.resource_key||!store?.consent||Date.parse(store.consent.expires_at)<=Date.now())return undefined;
            return new Promise(resolve=>{let finished=false;const finish:ResourceActionRequest['finish']=value=>{if(finished)return;if(value&&typeof value==='object'&&'run'in value&&value.run&&typeof value.run==='object'&&'id'in value.run&&typeof value.run.id==='string')routedRuns.set(value.run.id,source);finished=true;signal.removeEventListener('abort',aborted);resourceActionReply.current=null;setResourceAction(current=>current?.finish===finish?null:current);resolve(value);};
              const aborted=()=>finish(undefined);signal.addEventListener('abort',aborted,{once:true});resourceActionReply.current=finish;
              setResourceAction({input:intent,sessionId:source.value.session.pin.session_id,targetKey:target.target_key,connectionSessionId:target.session_id,accountRef:target.account.account_ref,signal,current:locallyCurrent,ensureAuthority:live,finish});});
          }

          if(key==='confirm_action'){
            if(!locallyCurrent()||composerOpen.current||resourceActionReply.current||resourceBatchReply.current||composerReply.current||confirmationReply.current)return undefined;
            let request:ExperienceConfirmationRequest;try{request=parseExperienceConfirmationRequest(input,session.bundle.action_keys);}catch{return undefined;}
            if(!await live()||signal.aborted||!locallyCurrent())return undefined;
            return new Promise(resolve=>{const finish=(result:unknown)=>{signal.removeEventListener('abort',aborted);resolve(result);};const aborted=()=>{finish(undefined);confirmationReply.current=null;setConfirmation(null);};signal.addEventListener('abort',aborted,{once:true});confirmationReply.current=finish;setConfirmation(request);});
          }
          if (key === 'compose_action') {
            if (!locallyCurrent() || composerOpen.current || resourceActionReply.current || resourceBatchReply.current || composerReply.current || confirmationReply.current || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
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
          const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const host = viewHost.current;
          const openerTarget = opener && host?.contains(opener)
            ? { element: opener, key: opener.dataset.focusKey, host, sessionId: session.pin.session_id } : null;
          const target = await readRunReview(input.run_id, signal);
          if (!await live() || !locallyCurrent() || signal.aborted) return undefined;
          runReviewOpener.current = openerTarget;
          runReviewReturn.current = opener?.isConnected ? opener : null;
          setRunReview(target); return { opened: true };
        },
        async openResource(_pin, key, input, signal) {
          if (APP_ATTACHMENT_BROKER_ENABLED && session.protocol_version === '7' && exposure && locallyCurrent()
            && input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).sort().join(',') === 'operation,record_id'
            && 'operation' in input && input.operation === 'read_source' && 'record_id' in input
            && typeof input.record_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.record_id)) {
            const response=await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/resources/${encodeURIComponent(key)}/content`,{method:'POST',signal,body:JSON.stringify(input)});
            if(!response.ok||response.headers.get('content-type')!=='message/rfc822'||response.headers.get('content-disposition')!=='attachment; filename="message.eml"'
              ||response.headers.get('x-deft-exposure-id')!==exposure.exposure_id||response.headers.get('x-deft-exposure-epoch')!==String(exposure.exposure_epoch))return undefined;
            const length=Number(response.headers.get('content-length'));if(!Number.isSafeInteger(length)||length<1||length>8388608)return undefined;
            const reader=response.body?.getReader();if(!reader)return undefined;const chunks:Uint8Array[]=[];let size=0;
            try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>length||signal.aborted||!locallyCurrent()){await reader.cancel();return undefined;}chunks.push(row.value);}}
            finally{reader.releaseLock();}
            if(size!==length||signal.aborted||!locallyCurrent()||!await live())return undefined;
            const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;chunk.fill(0);}
            const url=URL.createObjectURL(new Blob([bytes],{type:'message/rfc822'}));bytes.fill(0);
            const anchor=document.createElement('a');anchor.href=url;anchor.download='message.eml';anchor.click();URL.revokeObjectURL(url);return {opened:true};
          }
          if (!APP_ATTACHMENT_BROKER_ENABLED || session.protocol_version !== '7' || !exposure || !locallyCurrent()
            || !input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).length !== 1 || !('record_id' in input)
            || typeof input.record_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.record_id)) return undefined;
          if(await sourcePolicy(key,signal)){if(!await live()||!locallyCurrent()||signal.aborted)return undefined;sourceReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setSource({bindingId:'',recordId:input.record_id,resourceKey:key});setSettingsOpen(false);settingsOpenRef.current=false;return {opened:true};}
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
          const content = input && typeof input === 'object' && !Array.isArray(input) && 'operation' in input && ['read_document','triage_options'].includes(String(input.operation));
          const browse = input && typeof input === 'object' && !Array.isArray(input) && 'operation' in input && input.operation === 'browse';
          const response = await api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}/resources/${encodeURIComponent(key)}${content ? '/content' : browse ? '/browse' : ''}`,
            { method: 'POST', signal, body: JSON.stringify(input) });
          const body = await response.json() as { exposure_id?: string; exposure_epoch?: number; output?: unknown; code?: string };
          const documentRequest=input&&typeof input==='object'&&!Array.isArray(input)&&'operation'in input&&input.operation==='read_document'&&'record_id'in input&&typeof input.record_id==='string'?input.record_id:null;
          if (!response.ok) {
            if (body.code === 'RESOURCE_PAYLOAD_TOO_LARGE' || body.code === 'RESOURCE_CURSOR_STALE') throw new Error(body.code);
            let fallbackPolicy;try{fallbackPolicy=documentRequest?await sourcePolicy(key,signal):undefined;}catch{return undefined;}
            if(documentRequest&&fallbackPolicy?.source&&(fallbackPolicy.document.formats??['plain']).includes('plain')){try{const value=await sourcePresentation(key,documentRequest,signal),p=value.presentation,limit=Math.min(8192,fallbackPolicy.document.max_characters);const bounded=(value:string)=>new TextDecoder().decode(new TextEncoder().encode(value).subarray(0,limit)).replace(/\ufffd$/u,'');const output={format:'plain',content:bounded(p.plain_text),plain_text:bounded(p.plain_text),truncated:p.truncated||new TextEncoder().encode(p.plain_text).length>limit,metadata:p.metadata};if(session.experience.renderer_version==='deft.trusted_renderer.v1')trustedDocument={key,recordId:documentRequest,format:output.format,content:output.content};return output;}catch{return undefined;}}
            return undefined;
          }
          if (!locallyCurrent() || signal.aborted || body.exposure_id !== exposure.exposure_id || body.exposure_epoch !== exposure.exposure_epoch) return undefined;
          if(session.experience.renderer_version==='deft.trusted_renderer.v1'&&documentRequest&&body.output&&typeof body.output==='object'&&!Array.isArray(body.output)){const doc=body.output as Record<string,unknown>;if(['plain','html'].includes(String(doc.format))&&typeof doc.content==='string'){sourcePresentations.delete(`${key}/${documentRequest}`);trustedDocument={key,recordId:documentRequest,format:String(doc.format),content:doc.content};}}
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
        async runInspect(_pin,input,signal){if(session.protocol_version!=='7'||!locallyCurrent()||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='run_id')return undefined;const runId=(input as {run_id?:unknown}).run_id;if(typeof runId!=='string'||!/^[0-9a-f-]{36}$/i.test(runId))return undefined;const owner=routedRuns.get(runId);if(owner)await accounts.child(owner.targetKey,signal);const response=await api.fetch(`${root}/sessions/${encodeURIComponent(owner?.value.session.pin.session_id??session.pin.session_id)}/runs/${encodeURIComponent(runId)}/inspect`,{method:'POST',signal,body:'{}'});if(!response.ok)throw Error('Inspection is not confirmed. Check original status.');const body=await response.json() as {run?:unknown};if(owner)await accounts.child(owner.targetKey,signal);if(!locallyCurrent()||signal.aborted)return undefined;return body.run;},
        async runStatus(_pin, input, signal) {
          if (!locallyCurrent()) return undefined;
          const runId = input && typeof input === 'object' && !Array.isArray(input)
            ? (input as { run_id?: unknown }).run_id : null;
          if (typeof runId !== 'string' || (session.protocol_version === '7'
            ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
            : !knownRunIds.has(runId))) return undefined;
          const owner=routedRuns.get(runId);if(owner)await accounts.child(owner.targetKey,signal);const response = await api.fetch(session.protocol_version === '7'
            ? `${root}/sessions/${encodeURIComponent(owner?.value.session.pin.session_id??session.pin.session_id)}/runs/${encodeURIComponent(runId)}`
            : `/api/app-runs/${encodeURIComponent(runId)}`, { signal });
          if (!response.ok) return undefined;
          const body = await response.json() as { run?: unknown };
          if(owner)await accounts.child(owner.targetKey,signal);
          if (!locallyCurrent() || signal.aborted) return undefined;
          return body.run;
        },
      },
      onView(view) {
        if (!authorityCurrent()) return;
        latestView = view;setPreferencesNode(view.preferences??null);
        if (!locallyCurrent() || !viewHost.current) return;
        publishViewNavigation(view);
        renderHostView(view);
        rendered.current = true;
      },
    });
    intakePrepare.current=async suggestion=>{
      const intake=session.bundle.record_intakes?.[0];if(!intake||!session.experience.capabilities?.includes('record_intake.mailto.v1')||!exposure||!await live()||!locallyCurrent())throw Error('Intake unavailable');
      const signal=new AbortController().signal,target=await dataClient.select(intake.store_key,signal),store=target.stores.find(item=>item.declaration.key===intake.store_key);
      if(!store?.consent||Date.parse(store.consent.expires_at)<=Date.now()||!locallyCurrent()||intake.profile.max_record_bytes>store.declaration.max_record_bytes||intake.profile.schema_version!=='deft.record_form_profile.v1'||intake.profile.files.max_files>store.declaration.max_files||intake.profile.files.max_file_bytes>store.declaration.max_file_bytes||intake.profile.files.max_total_bytes>store.declaration.max_total_file_bytes)throw Error('Draft access unavailable');
      const scopedClient=createExperienceDataClient({installationId,targetKey:target.target_key,current:locallyCurrent,fetch:(path,options)=>{
        if(path.includes('/api/app-data/connections/')&&!path.startsWith('/api/app-data/connections/'+encodeURIComponent(target.session_id)+'/'))return Promise.reject(Error('Account changed'));
        return api.fetch(path,options);
      }});
      const check=async()=>{if(!await live()||!locallyCurrent())throw Error('Account access ended');const current=await dataClient.select(intake.store_key,signal);if(current.target_key!==target.target_key||current.session_id!==target.session_id||current.account.account_ref!==target.account.account_ref)throw Error('Account changed');};
      return {account:target.account.label,intake:createRecordIntake(intake,suggestion,{request:async(operation,input,requestId)=>{await check();return scopedClient.request(intake.store_key,operation,input,signal,requestId);},emit:async event=>{await check();return bridge.emitHostEvent(event);}})};
    };
    preferencesEvent.current=event=>{if(locallyCurrent()&&settingsOpenRef.current)void bridge.sendUiEvent(event);};
    let childSweepBusy=false;
    const childTimer=setInterval(()=>{if(childSweepBusy||!locallyCurrent()||document.hidden)return;childSweepBusy=true;void accounts.sweep(AbortSignal.timeout(10000)).then(async ended=>{if(!locallyCurrent())return;for(const target of ended){setResourceBatch(current=>{if(current?.targetKey===target){current.finish(undefined);return null;}return current;});setResourceAction(current=>{if(current?.targetKey===target){current.finish(undefined);return null;}return current;});setRecordAction(current=>{if(current?.targetKey===target){current.finish(false);return null;}return current;});await bridge.sendUiEvent({kind:'click',node_id:'account_visibility_'+target});}}).catch(()=>{}).finally(()=>{childSweepBusy=false;});},5000);
    const stop = (retireSession = true) => {
      if (stopped) return;
      startup.dispose();
      frame.removeEventListener('load', onBootstrapLoad);
      sourceNominationAbort.abort();setNominatedSource(null);
      stopped = true; latestView = null;trustedDocument=null;sourceReview.clear();sourcePresentations.clear();for(const entry of presentationDisposals.values())entry.mount();presentationDisposals.clear();setPreferencesNode(null);preferencesEvent.current=null;intakePrepare.current=null;readingPreferencesChanged.current=null; setSuspended(false); setSource(null); setRunReview(null);
      clearInterval(childTimer);accounts.close();connection.dispose(); lease?.dispose(); ensureAuthority.current = null;flushRecordWrites.current=null; setConnectionUnavailable(false);
      clearNavigation(navigationOwner);
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (viewHost.current) clearExperienceView(viewHost.current);
      rendered.current = false;
      closeComposer(true);closeConfirmation(true); setError('This Experience session ended. Reopen it to continue.');
      if (retireSession) void api.fetch(`${root}/sessions/${encodeURIComponent(session.pin.session_id)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
    stopWorker.current = stop;
    let started = false, bootstrapReady = false;
    const startWorker = () => {
      if (!bootstrapReady || !locallyCurrent() || started || !frame.contentWindow) return;
      bootstrapDiagnostic.start_transfer_attempted = true;
      started = true;
      frame.contentWindow.postMessage({ kind: 'start', session_id: session.pin.session_id, worker_source: session.bundle.worker_source }, '*', [port.port2]);
    };
    const onBootstrapReady = (event: MessageEvent) => {
      if (!stopped && event.data?.kind === 'deft_experience_bootstrap_ready.v1') {
        bootstrapDiagnostic.ready_candidate_seen = true;
        bootstrapDiagnostic.ready_source_match = !!frame.contentWindow && event.source === frame.contentWindow;
        bootstrapDiagnostic.ready_origin_opaque = event.origin === 'null';
        bootstrapDiagnostic.ready_shape_exact = Object.keys(event.data).join(',') === 'kind';
        bootstrapDiagnostic.ready_identity_current = identityCurrent();
      }
      const status = experienceStartupStatus(event, frame.contentWindow, session.pin.session_id);
      if (status && authorityCurrent()) {
        if (status === 'started') startup.started(); else startup.fail(status);
        return;
      }
      // Readiness is transport metadata. Retain it across a renewable lease gap;
      // startWorker still requires current authority, visibility and one transfer.
      if (!identityCurrent() || started || event.source !== frame.contentWindow || event.origin !== 'null'
        || !event.data || Object.keys(event.data).join(',') !== 'kind' || event.data.kind !== 'deft_experience_bootstrap_ready.v1'
        || !frame.contentWindow) return;
      bootstrapDiagnostic.ready_accepted = true;
      startup.ready(); bootstrapReady = true; startWorker();
    };
    addEventListener('message', onBootstrapReady);
    frame.addEventListener('load', onBootstrapLoad);
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
      current: authorityCurrent, live:async()=>{if(!await live())return false;const ended=await accounts.sweep(AbortSignal.timeout(10000));if(ended.length){latestView=null;for(const target of ended){setResourceBatch(current=>{if(current?.targetKey===target){current.finish(undefined);return null;}return current;});setResourceAction(current=>{if(current?.targetKey===target){current.finish(undefined);return null;}return current;});setRecordAction(current=>{if(current?.targetKey===target){current.finish(false);return null;}return current;});await bridge.sendUiEvent({kind:'click',node_id:'account_visibility_'+target});}}return locallyCurrent();}, hidden: () => document.hidden,
      flush: () => { if (viewHost.current) flushExperienceInputs(viewHost.current); },
      clear: () => { clearNavigation(navigationOwner); setSuspended(true); setSource(null); setRunReview(null); if (viewHost.current) suspendExperienceView(viewHost.current); rendered.current = false; },
      restore: () => { setSuspended(false); startWorker(); if (latestView && viewHost.current) { publishViewNavigation(latestView); renderHostView(latestView); rendered.current = true; } },
      end: stop,
    });
    const hidden = () => { if (document.hidden) suspension.hide(); else void suspension.show(); };
    document.addEventListener('visibilitychange', hidden);
    const pageHide = () => stop(connectionSessionRetirementRequired(connectionNavigation.current, session.pin.session_id));
    addEventListener('pagehide', pageHide);
    // Grant-backed leases renew through live(); a fixed timer would retire a
    // healthy Worker at the original deadline after successful renewal.
    const expiry = exposure ? undefined : setTimeout(() => stop(), Math.max(0, Date.parse(session.expires_at) - Date.now()));
    return () => {
      startup.dispose();
      frame.removeEventListener('load', onBootstrapLoad);
      clearInterval(poll); removeEventListener('online', checkConnection); suspension.dispose();
      removeEventListener('message', onBootstrapReady);
      removeEventListener('storage', onStorage);
      socket?.off('app:changed', onAppChange);
      document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', pageHide); clearTimeout(expiry);
      stopped = true;
      sourceNominationAbort.abort();setNominatedSource(null);
      connection.dispose(); lease?.dispose(); ensureAuthority.current = null;flushRecordWrites.current=null;
      refreshNavigation.current = null;
      if (leaseCurrent.current === lease) leaseCurrent.current = null;
      clearNavigation(navigationOwner);
      sourceNominationAbort.abort();setNominatedSource(null);
      frame.contentWindow?.postMessage({ kind: 'stop', session_id: session.pin.session_id }, '*');
      bridge.revoke();
      frame.remove();
      if (viewHost.current) clearExperienceView(viewHost.current);
      rendered.current = false;
      stopWorker.current = null;
      if (connectionSessionRetirementRequired(connectionNavigation.current, session.pin.session_id)) void retireSession(session.pin.session_id);
    };
  }, [session, sessionCacheScope, exposure, recoveryReady, readRunReview, visibleEpoch, installationId, experienceKey, publishNavigation, clearNavigation, closeComposer, closeConfirmation, showSettings, appName]);

  useEffect(() => {
    const clear = () => { renewalGeneration.current += 1; reviewGeneration.current += 1; setReview(null); setExposureBusy(false); };
    const hidden = () => {
      if (document.hidden) { renewalGeneration.current += 1; setRenewalBusy(false); if (!stopWorker.current) reviewGeneration.current += 1; setReview(null); setExposureBusy(false); }
      else if (!stopWorker.current) setVisibleEpoch(value => value + 1);
    };
    document.addEventListener('visibilitychange', hidden); addEventListener('pagehide', clear);
    return () => { clear(); document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', clear); };
  }, []);

  const privateAccessReview = session && !error && (session.bundle.resource_keys.length > 0 || !!session.bundle.state_keys?.length || !!session.bundle.record_store_keys?.length) && !exposure ? <section aria-label="Experience private access" className="mx-auto w-full max-w-3xl shrink-0 space-y-4 overflow-y-auto px-5 py-6 text-sm" style={{ maxHeight: 'calc(100% - 100px)' }}>
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
            {resource.content_policy?.document && <p>Read current document content, up to {resource.content_policy.document.max_characters.toLocaleString()} characters. Additional reviewed fields: {Object.keys(resource.content_policy.document.metadata_schema?.properties ?? {}).join(', ') || 'None'}. {resource.content_policy.document.formats?.includes('html')?'Message formatting is sanitized. Active content is blocked; external images are blocked by default and load only when you choose.':'Reviewed document text is shown as plain text.'}</p>}
                {resource.content_policy?.source && <p>Read and download original message files, up to {resource.content_policy.source.max_bytes.toLocaleString()} bytes each, from this account. Deft can show sanitized formatting and embedded images from these files. External images load only when you choose.</p>}
            {resource.content_policy?.triage_options && <p>Read names of up to {resource.content_policy.triage_options.max_options} folders or labels for mailbox actions.</p>}
            {!!resource.content_policy?.search_filters?.length && <p>Search this account using: {resource.content_policy.search_filters.map(field=>field.replaceAll('_',' ')).join(', ')}.</p>}
            {resource.allowed_operations.includes('search') && <p>Literal search examines the complete saved approved fields within the app’s reviewed limits, with at most 240 characters per matching excerpt.</p>}
                <p>At most 10 {resource.allowed_operations.includes('search') ? 'summaries or search matches' : 'summaries'} per page; 32 scalar fields; 4096 characters per string; 60 KiB per response.</p>
              </div></details></div>)}
          {review.snapshot.private_state?.map(state => <div key={state.key} className="space-y-2 border-t py-3" style={{ borderColor: 'var(--ghost-border)' }}><p className="font-medium">Manage {state.label.toLowerCase()}</p>
            <p>List, read, save and delete up to {state.max_records} encrypted records, retained for {state.retention_days} days from creation. Only you and this reviewed app can access them; workspace search and AI context are excluded.</p>
            <details><summary className="min-h-11 cursor-pointer py-3 text-xs">Storage limits</summary><div className="space-y-1 pb-2 text-xs">
              <p>{state.max_record_bytes} bytes per record; {state.max_total_bytes} bytes total.</p>
              {state.files && <p>Files: up to {state.files.max_files_per_record} per record; {state.files.max_file_bytes.toLocaleString()} bytes each; {state.files.max_total_bytes_per_record.toLocaleString()} bytes per record. Types: {state.files.allowed_media_types.join(', ')}. Files cannot outlive their saved record.</p>}
              {state.action_payloads?.map(payload => <p key={payload.action_key}>Captured payload for {payload.action_key}: {payload.max_payload_bytes.toLocaleString()} bytes per action. Current action authority and confirmation remain required.</p>)}
            </div></details></div>)}
          {review.snapshot.record_stores?.map(store=><div key={store.key} className="space-y-2 border-t py-3" style={{borderColor:'var(--ghost-border)'}}><p className="font-medium">Use app-owned {store.key.replaceAll('_',' ')} records</p>
            <p>The connected app runtime stores these records. A separate human review enables creating or editing them for this account. Sending requires a separate review of the exact saved message.</p>
            <p className="text-xs">Up to {store.max_record_bytes.toLocaleString()} bytes per complete record; {store.max_files} files; {store.max_total_file_bytes.toLocaleString()} file bytes per record.</p>
            {store.resource_content&&<p className="text-xs">Current source presentation up to {store.resource_content.max_presentation_bytes.toLocaleString()} bytes; original files up to {store.resource_content.max_source_bytes.toLocaleString()} bytes. Formatting is sanitized and external images load only with your choice.</p>}</div>)}
          <details className="border-t pt-3" style={{ borderColor: 'var(--ghost-border)' }}><summary className="min-h-11 cursor-pointer py-3 text-xs">Verified app and access details</summary>
            <div className="space-y-2 pb-3 text-xs"><p>Screen: {review.snapshot.experience_label}</p><p className="break-all font-mono">{review.snapshot.artifact_digest}</p>
              <p>Access is limited to this verified app version and the listed fields. Provider credentials and internal provider metadata are excluded. Changed permissions require a new review.</p></div></details>
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => void acceptExposure()}>Allow listed private access</button>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy} onClick={() => { reviewGeneration.current += 1; setReview(null); }}>Cancel private access review</button></div></>
          : <><p>Grant this app access to the exact private fields and saved data you choose. You can revoke access at any time.</p>
            <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={exposureBusy || !!error} onClick={() => void prepareExposure()}>Review private access</button></>}
      {exposureBusy && <p role="status">Checking private access…</p>}
    </section> : null;

  return <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
    <style>{EXPERIENCE_RENDERER_CSS}</style>
    <h1 className="sr-only">{session?.experience.label ?? 'Account setup'}</h1>
    {renewalNotice && <p role="alert" className="shrink-0 px-5 py-3 text-sm">{renewalNotice}</p>}
    {connectionUnavailable && !error && <p role="status" className="shrink-0 px-6 py-4 text-sm">Connection interrupted. Reconnecting... Your saved work is kept.</p>}
    {suspended && !connectionUnavailable && !error && <p role="status" className="shrink-0 px-6 py-4 text-sm">Resuming app…</p>}
    {session&&(error||!exposure)&&!settingsOpen&&<div className="shrink-0 px-5 py-2"><button type="button" className="deft-pill min-h-11" disabled={connectionSetupBusy||!!composer}
      onClick={()=>void showSettings(true)}>Account settings</button></div>}
    {error && session && !accountSetupOpen ? <p role="alert" data-experience-startup-phase={startupPhase ?? undefined} data-experience-startup-diagnostic={startupPhase ? startupDiagnostic ?? undefined : undefined} className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>{error}</p>
      : !ready && !error && !accountSetupOpen ? <p role="status" className="shrink-0 px-6 py-4 text-sm" style={{ background: 'var(--surface-container-low)' }}>Opening app…</p>
      : null}
    {!session && user && user.role !== 'guest' && org && sessionCacheScope && !accountSetupOpen && <section className="shrink-0 space-y-3 px-5 py-4 text-sm">
      <p>Set up your own account to use this app.</p>
      <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={connectionSetupBusy}
        onClick={() => { if (!document.hidden) setAccountSetupOpen(true); }}>Set up account</button>
    </section>}
    {!session && accountSetupOpen && user && user.role !== 'guest' && <div className="min-h-0 flex-1 overflow-hidden">
      <ExperienceSettings experienceLabel={appName} title={appName === 'App' ? 'Account setup' : `${appName} settings`} onBack={() => { if (!connectionBusyRef.current) setAccountSetupOpen(false); }}
        accounts={settingsAccounts} selectedAccountKey={resourceTarget} accountsBusy={connectionSetupBusy}
        access={{ state: 'unavailable', summary: 'Review your own account access before opening the app.' }}
        connectAccount={<>{accountSetupPending && <p role="status" className="mb-3 text-sm">Opening your account…</p>}
          <ExperienceConnectionSettings onAccountLabels={receiveAccountLabels} installationId={installationId} experienceKey={experienceKey}
            ensureAuthority={composerAuthority} disabled={renewalBusy || accountSetupPending} onBusy={connectionBusy} onConnectionNavigation={onConnectionNavigation} onSetupComplete={completeAccountSetup} /></>} />
    </div>}
    {!settingsOpen&&privateAccessReview}
    {error && session && !accountSetupOpen && <section className="shrink-0 space-y-2 px-5 py-3 text-sm"><p>Your saved drafts remain private. Reconnect to recover them; sign in again if your login has ended.</p>
      <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={renewalBusy} onClick={() => void renewPrivateAccess()}>{renewalBusy ? 'Reconnecting…' : 'Reconnect app'}</button></section>}
    {session && exposure && recoveryDismissalScope && !error && !!session.bundle.state_keys?.length && !recoveryReady && <PrivateStateRecoveryGate suspended={connectionUnavailable}
      key={`${session.pin.session_id}/${exposure.exposure_id}/${exposure.exposure_epoch}`} sessionId={session.pin.session_id} exposure={exposure}
      states={recoveryStates} dismissalScope={recoveryDismissalScope} currentTarget={session.resource_target_key ?? resourceTarget} onContinue={continueRecovery} />}
    {!settingsOpen&&session&&exposure&&!error&&!suspended&&!connectionUnavailable&&!!session.bundle.record_store_keys?.length&&<ExperienceDataConsent installationId={installationId}
      targetKey={session.resource_target_key??resourceTarget} storeKeys={session.bundle.record_store_keys} scopeKey={`${session.pin.session_id}/${exposure.exposure_id}/${exposure.exposure_epoch}`}
      onOpenSettings={()=>void showSettings(true,'access')} onChanged={()=>setOpening(value=>value+1)}/>}
    {nominatedSource&&!settingsOpen&&!error&&!suspended&&!connectionUnavailable&&<div className="min-h-0 flex-1 overflow-auto"><SourceNominationPanel surface={nominatedSource} onClose={()=>setNominatedSource(null)}/></div>}
    <div ref={viewHost} className="min-h-0 flex-1 overflow-auto" style={nominatedSource || source || settingsOpen || accountSetupOpen ? { display: 'none' } : undefined} aria-label="App Experience" />
    {settingsOpen && session && <div className="min-h-0 flex-1 overflow-hidden">
      <ExperienceSettings key={settingsSection} initialSection={settingsSection} preferences={preferencesNode&&exposure&&!error&&!connectionUnavailable&&!suspended?<ExperiencePreferences node={preferencesNode} onEvent={event=>preferencesEvent.current?.(event)}/>:undefined} experienceLabel={appName} onBack={() => void showSettings(false)}
        accounts={settingsAccounts} selectedAccountKey={session.resource_target_key ?? resourceTarget}
        onSelectAccount={target => void switchResourceTarget(target)}
        accountsBusy={connectionSetupBusy || renewalBusy || exposureBusy || !!composer || !ready || connectionUnavailable || suspended}
        connectAccount={<>
          {!!session.bundle.state_keys?.length && !recoveryReady && <p role="status" className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>Finish the saved-data review before reconnecting this account.</p>}
          <ExperienceConnectionSettings
            key={session.pin.session_id} onAccountLabels={receiveAccountLabels} appOwnedRecords={!!session.bundle.record_store_keys?.length} sessionId={exposure&&!error&&!connectionUnavailable&&!suspended?session.pin.session_id:undefined} installationId={installationId} experienceKey={experienceKey}
            targetKey={session.resource_target_key ?? resourceTarget}
            onReadingPreferencesChanged={()=>readingPreferencesChanged.current?.()}
            ensureAuthority={composerAuthority} disabled={renewalBusy || exposureBusy || !!composer || !!session.bundle.state_keys?.length && !recoveryReady}
            onBusy={connectionBusy} onConnectionNavigation={onConnectionNavigation} onSetupComplete={completeAccountSetup} />
        </>}
        access={{ state: exposure && !error && !connectionUnavailable && !suspended ? 'active' : privateAccessReview ? 'review_required' : 'unavailable' }}
        accessBusy={exposureBusy || connectionUnavailable || suspended}
        onRevokeAccess={exposure && !error ? () => void withdrawExposure() : undefined}
        accessReview={<div className="space-y-3 text-sm">
          {privateAccessReview}
          {exposure&&!error&&!suspended&&!connectionUnavailable&&!!session.bundle.record_store_keys?.length&&<ExperienceDataConsent installationId={installationId} showEnabled
            targetKey={session.resource_target_key??resourceTarget} storeKeys={session.bundle.record_store_keys} scopeKey={`${session.pin.session_id}/${exposure.exposure_id}/${exposure.exposure_epoch}`}
            onChanged={()=>setOpening(value=>value+1)}/>}
          {exposure&&!error&&!suspended&&!connectionUnavailable&&!!session.bundle.record_store_keys?.length&&<CurrentIntegrationAccessSettings installationId={installationId} targetKey={session.resource_target_key??resourceTarget??''} storeKeys={session.bundle.record_store_keys} scopeKey={session.pin.session_id+'/'+exposure.exposure_id+'/'+exposure.exposure_epoch}/>}
          {APP_ATTACHMENT_BROKER_ENABLED && <Link className="deft-pill" href="/settings/apps/private-resources" style={{ minHeight: 44 }}>Manage private resources</Link>}
          <Link className="deft-pill" href="/settings/apps" style={{ minHeight: 44 }}>Manage installed apps</Link>
        </div>}
        agentPolicy={exposure && !error && !connectionUnavailable && !suspended ? <ExperienceAgentPolicy
          sessionId={session.pin.session_id} actions={session.bundle.action_keys} ensureAuthority={composerAuthority} /> : undefined} />
    </div>}
    {source && exposure && !error && <section className="flex min-h-0 flex-1 flex-col" aria-label="Selected App resource">
      <div className="shrink-0 border-b px-4 py-2" style={{ borderColor: 'var(--ghost-border)' }}><button ref={sourceBack} className="deft-pill min-h-11" onClick={closeSource}>Back to {session?.experience.label ?? 'app'}</button></div>
      {source.resourceKey&&session?<ExperienceSourceFiles sessionId={session.pin.session_id} resourceKey={source.resourceKey} recordId={source.recordId} exposure={exposure} ensureAuthority={composerAuthority} disabled={suspended||connectionUnavailable}/>:<AttachmentParentView bindingId={source.bindingId} projectionId={source.recordId} compact />}
    </section>}
    <ExperienceRecordIntake prepare={suggestion=>{if(!intakePrepare.current)return Promise.reject(Error('Review account access'));return intakePrepare.current(suggestion);}}/>
    {settingsOpen&&session?.bundle.record_intakes?.length===1&&<ExperienceMailtoRegistration/>}
    <div ref={iframeHost} aria-hidden="true" />
    {resourceBatch&&session&&!error&&<ExperienceResourceActionBatch request={resourceBatch}/>}
    {resourceAction&&session&&!error&&<ExperienceResourceAction request={resourceAction} onRun={run=>{void readRunReview(run.id).then(setRunReview).catch(()=>setRenewalNotice('Open Activity to check this action.'));}}/>}
    {recordAction&&session&&!error&&<ExperienceRecordAction request={recordAction} onRun={run=>{void readRunReview(run.id).then(setRunReview).catch(()=>setRenewalNotice('The submission was accepted. Open Activity to check its current status.'));}}/>}
    {runReview && !error && <ExperienceRunReview key={runReview.runId} initial={runReview} returnFocusRef={runReviewReturn}
      refresh={() => readRunReview(runReview.runId)} onClose={closeRunReview} />}
    {confirmation&&session&&<ExperienceActionConfirmation request={confirmation} sessionId={session.pin.session_id} pins={session.pin} suspended={connectionUnavailable||suspended} ensureAuthority={composerAuthority} onClose={closeConfirmation} onResult={run=>{confirmationReply.current?.({run});confirmationReply.current=null;setConfirmation(null);}}/>}
    {composer && session && <ExperienceActionComposer request={composer} sessionId={session.pin.session_id}
      draftScope={{ orgId: session.pin.org_id, userId: session.pin.user_id, installationId, resourceTargetKey: session.resource_target_key }}
      suspended={connectionUnavailable || suspended} ensureAuthority={composerAuthority} onClose={closeComposer} onResult={run => {
        composerReply.current?.({ run }); composerReply.current = null; setComposer(null);
      }} />}
  </div>;
}
