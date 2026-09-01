'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, Play, ShieldCheck } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import { useAppActions, useAppRun, useAppRunResult } from '@/hooks/use-app-actions';
import {
  createAppActionIntentKey,
  invokeAppAction,
  isTerminalAppRun,
  prepareAppAction,
  resolveAppAction,
  type AppActionExecutionInput,
  type AppActionItem,
  type AppActionPrepared,
  type AppActionResolveResult,
  type AppRunView,
  type JsonValue,
} from '@/lib/app-actions';
import { resourceRefKey, resourceRefPayload, type ResourceRef } from '@/lib/modules';
import { useAuth } from '@/lib/auth-context';
import {
  createAppAutomation,
  prepareAppAutomation,
  type AppAutomationReview,
  type AppAutomationScheduleInput,
} from '@/lib/app-automations';

export function ModuleRecordAppActions({ resourceRef, enabled = true }: { resourceRef: ResourceRef; enabled?: boolean }) {
  const { user } = useAuth();
  const canManageAutomations = user?.role === 'owner' || user?.role === 'admin';
  const actionsState = useAppActions(resourceRef, enabled);
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<AppActionResolveResult | null>(null);
  const [selections, setSelections] = useState<Record<string, ResourceRef>>({});
  const [userInputs, setUserInputs] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<AppActionPrepared | null>(null);
  const [executionInput, setExecutionInput] = useState<AppActionExecutionInput | null>(null);
  const [submittedRun, setSubmittedRun] = useState<AppRunView | null>(null);
  const [intentKey, setIntentKey] = useState<string | null>(null);
  const [automationMode, setAutomationMode] = useState(false);
  const [automationReview, setAutomationReview] = useState<AppAutomationReview | null>(null);
  const [automationCreated, setAutomationCreated] = useState(false);
  const [automationRequestKey, setAutomationRequestKey] = useState('');
  const [localTime, setLocalTime] = useState('09:00');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [busy, setBusy] = useState<'resolve' | 'prepare' | 'invoke' | 'automation-review' | 'automation-create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runState = useAppRun(submittedRun?.id ?? null);
  const run = runState.data ?? submittedRun;
  const resultState = useAppRunResult(
    run?.id ?? null,
    Boolean(run?.state === 'succeeded' && run.safeOutcome?.resultStatus === 'retained'),
  );
  const automationSelectionInputs = resolved?.inputs.filter((input) => input.kind === 'selected_relation_field') ?? [];
  const automationSelectionReady = automationSelectionInputs.length === 1
    && Boolean(selections[automationSelectionInputs[0].inputKey]);

  if (!enabled || (!actionsState.isLoading && !actionsState.error && actionsState.actions.length === 0)) return null;

  const begin = async (action: AppActionItem) => {
    setOpen(true); setBusy('resolve'); setError(null); setResolved(null); setPrepared(null); setExecutionInput(null); setSubmittedRun(null);
    setUserInputs({}); setSelections({}); setIntentKey(createAppActionIntentKey());
    setAutomationMode(false); setAutomationReview(null); setAutomationCreated(false); setAutomationRequestKey('');
    try {
      const next = await resolveAppAction(action.bindingId, resourceRef);
      setResolved(next);
      setAutomationRequestKey(next.action.automationRequests[0]?.key ?? '');
      setSelections(Object.fromEntries(next.inputs.flatMap((input) => input.kind === 'selected_relation_field' && input.options.length === 1
        ? [[input.inputKey, input.options[0].ref]]
        : [])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to resolve this App action.');
    } finally {
      setBusy(null);
    }
  };

  const buildInput = (): AppActionExecutionInput | null => {
    if (!resolved || !intentKey) return null;
    for (const input of resolved.inputs) {
      if (input.kind === 'selected_relation_field' && !selections[input.inputKey]) {
        setError(`Choose ${humanize(input.inputKey)}.`); return null;
      }
      if (input.kind === 'user_input') {
        const value = userInputs[input.inputKey]?.trim() ?? '';
        if (!value) { setError(`${input.label} is required.`); return null; }
        if (input.inputType === 'email' && !/^\S+@\S+\.\S+$/.test(value)) { setError(`${input.label} must be a valid email address.`); return null; }
      }
    }
    return {
      binding_id: resolved.action.bindingId,
      resource_ref: resourceRefPayload(resourceRef),
      selections: resolved.inputs.flatMap((input) => input.kind === 'selected_relation_field'
        ? [{ input_key: input.inputKey, resource_ref: resourceRefPayload(selections[input.inputKey]) }]
        : []),
      user_inputs: Object.fromEntries(resolved.inputs.flatMap((input) => input.kind === 'user_input'
        ? [[input.inputKey, userInputs[input.inputKey].trim()]]
        : [])),
      idempotency_key: intentKey,
    };
  };

  const prepare = async () => {
    const input = buildInput();
    if (!input) return;
    setBusy('prepare'); setError(null);
    try {
      setPrepared(await prepareAppAction(input));
      setExecutionInput(input);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to prepare this App action.');
    } finally {
      setBusy(null);
    }
  };

  const invoke = async () => {
    if (!prepared || !executionInput) return;
    setBusy('invoke'); setError(null);
    try {
      setSubmittedRun(await invokeAppAction(executionInput, prepared.inputCandidate));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to start this App action.');
    } finally {
      setBusy(null);
    }
  };

  const automationInput = (): AppAutomationScheduleInput | null => {
    if (!resolved || !automationRequestKey) return null;
    const selected = resolved.inputs.filter((input) => input.kind === 'selected_relation_field');
    if (selected.length !== 1) return null;
    const selectedRef = selections[selected[0].inputKey];
    if (!selectedRef) { setError(`Choose ${humanize(selected[0].inputKey)}.`); return null; }
    return {
      bindingId: resolved.action.bindingId,
      automationRequestKey,
      placement: resourceRef,
      selection: { inputKey: selected[0].inputKey, resourceRef: selectedRef },
      localTime,
      timezone,
      validitySeconds: 30 * 24 * 60 * 60,
      maxOrgRunsPerUtcDay: 100,
      maxPendingOrgFires: 25,
    };
  };

  const reviewAutomation = async () => {
    const input = automationInput();
    if (!input) return;
    setBusy('automation-review'); setError(null);
    try {
      setAutomationReview(await prepareAppAutomation(resolved!.action.installationId, input));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to review this automation.');
    } finally {
      setBusy(null);
    }
  };

  const confirmAutomation = async () => {
    const input = automationInput();
    if (!input || !automationReview || !resolved) return;
    setBusy('automation-create'); setError(null);
    try {
      await createAppAutomation(resolved.action.installationId, input, automationReview.reviewDigest);
      setAutomationCreated(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create this automation.');
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false); setResolved(null); setPrepared(null); setExecutionInput(null); setSubmittedRun(null); setIntentKey(null); setError(null);
    setAutomationMode(false); setAutomationReview(null); setAutomationCreated(false); setAutomationRequestKey('');
  };

  return (
    <section className="rounded-xl p-3.5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }} aria-label="App actions">
      <div className="flex items-start gap-2.5"><span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-active)', color: 'var(--primary)' }}><Play size={15} /></span><div><h2 className="text-[0.8125rem] font-semibold">App actions</h2><p className="mt-0.5 text-[0.6875rem]" style={{ color: 'var(--outline)' }}>Governed actions available for this record.</p></div></div>
      {actionsState.isLoading ? <div className="flex min-h-14 items-center justify-center"><Loader2 size={15} className="animate-spin" aria-label="Loading App actions" /></div>
        : actionsState.error ? <p role="alert" className="mt-3 text-[0.6875rem]" style={{ color: 'var(--error)' }}>{actionsState.error instanceof Error ? actionsState.error.message : 'App actions are unavailable.'}</p>
          : <div className="mt-3 space-y-2">{actionsState.actions.map((action) => <button key={action.bindingId} type="button" className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-[0.75rem] font-medium" style={{ background: 'var(--surface-container-high)' }} onClick={() => void begin(action)}><span className="truncate">{action.label}</span><Play size={13} className="flex-shrink-0" /></button>)}</div>}

      <AppDialog
        open={open}
        onClose={close}
        title={resolved?.action.label ?? 'App action'}
        description="Deft resolves fields and relations under the App’s reviewed authority. Provider input stays sealed."
        width={520}
        footer={<ActionFooter busy={busy} resolved={resolved} prepared={prepared} run={run} canManageAutomations={canManageAutomations} automationSelectionReady={automationSelectionReady} automationMode={automationMode} automationReview={automationReview} automationCreated={automationCreated} onClose={close} onPrepare={() => void prepare()} onInvoke={() => void invoke()} onBeginAutomation={() => { setAutomationMode(true); setError(null); }} onReviewAutomation={() => void reviewAutomation()} onConfirmAutomation={() => void confirmAutomation()} />}
      >
        {busy === 'resolve' && <div className="flex min-h-28 items-center justify-center"><Loader2 className="animate-spin" aria-label="Resolving App action" /></div>}
        {error && <p role="alert" className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--danger-subtle)' }}>{error}</p>}
        {runState.error && <p role="alert" className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--danger-subtle)' }}>{runState.error instanceof Error ? runState.error.message : 'Run status is unavailable.'}</p>}
        {resolved && !prepared && !run && !automationMode && <div className="space-y-3">{resolved.inputs.map((input) => {
          if (input.kind === 'resource_field') return <ReadOnlyInput key={input.inputKey} label={humanize(input.inputKey)} value="From this record" />;
          if (input.kind === 'selected_relation_field') return <label key={input.inputKey} className="block text-xs font-medium">{humanize(input.inputKey)}<select className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }} value={selections[input.inputKey] ? resourceRefKey(selections[input.inputKey]) : ''} onChange={(event) => {
            const option = input.options.find((candidate) => resourceRefKey(candidate.ref) === event.target.value);
            setSelections((current) => {
              const next = { ...current };
              if (option) next[input.inputKey] = option.ref; else delete next[input.inputKey];
              return next;
            });
            setError(null);
          }}><option value="">Choose a related resource</option>{input.options.map((option) => <option key={resourceRefKey(option.ref)} value={resourceRefKey(option.ref)}>{option.label}</option>)}</select>{input.options.length === 0 && <span className="mt-1 block text-[11px]" style={{ color: 'var(--error)' }}>No authorized related resource is available.</span>}</label>;
          return <label key={input.inputKey} className="block text-xs font-medium">{input.label}<input type={input.inputType} required value={userInputs[input.inputKey] ?? ''} onChange={(event) => { setUserInputs((current) => ({ ...current, [input.inputKey]: event.target.value })); setError(null); }} className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }} /></label>;
        })}</div>}
        {resolved && automationMode && !automationReview && !automationCreated && <div className="space-y-3"><p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Create one approved daily schedule for the currently selected resources. Deft rechecks them before every Run.</p>{resolved.action.automationRequests.length > 1 && <label className="block text-xs font-medium">Automation<select value={automationRequestKey} onChange={(event) => setAutomationRequestKey(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}>{resolved.action.automationRequests.map((request) => <option key={request.key} value={request.key}>{request.label}</option>)}</select></label>}<label className="block text-xs font-medium">Local time<input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }} /></label><label className="block text-xs font-medium">IANA timezone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }} /></label><ReadOnlyInput label="Policy" value="One action per fire · 15 minute catch-up · 30 day approval · 100 Runs/day" /></div>}
        {automationReview && !automationCreated && <div className="space-y-3"><div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'rgba(48,164,108,.10)' }}><ShieldCheck size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--status-green)' }} /><div><h3 className="text-sm font-semibold">Approved automation definition</h3><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Daily at {automationReview.schedule.localTime} · {automationReview.schedule.timezone}. Valid for {Math.round(automationReview.validitySeconds / 86400)} days under policy v{automationReview.policyVersion}.</p></div></div><AutomationResourcePin label="Placement resource" pin={automationReview.placement} /><AutomationResourcePin label="Selected resource" pin={automationReview.selected} /><p className="text-[11px]" style={{ color: 'var(--outline)' }}>Creating this definition permits unattended external writes only for these pinned resources and this exact reviewed action.</p></div>}
        {automationCreated && <div role="status" className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'rgba(48,164,108,.10)' }}><CheckCircle2 size={16} style={{ color: 'var(--status-green)' }} /><div><h3 className="text-sm font-semibold">Automation created</h3><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Manage its schedule, state, Runs, and dead letters in Settings · Apps.</p></div></div>}
        {prepared && !run && <SafePreview preview={prepared.safePreview} />}
        {run && <RunStatus run={run} polling={runState.isLoading || runState.isValidating} result={resultState.data?.value} resultError={resultState.error} />}
      </AppDialog>
    </section>
  );
}

function ActionFooter({ busy, resolved, prepared, run, canManageAutomations, automationSelectionReady, automationMode, automationReview, automationCreated, onClose, onPrepare, onInvoke, onBeginAutomation, onReviewAutomation, onConfirmAutomation }: {
  busy: 'resolve' | 'prepare' | 'invoke' | 'automation-review' | 'automation-create' | null;
  resolved: AppActionResolveResult | null;
  prepared: AppActionPrepared | null;
  run: AppRunView | null;
  canManageAutomations: boolean;
  automationSelectionReady: boolean;
  automationMode: boolean;
  automationReview: AppAutomationReview | null;
  automationCreated: boolean;
  onClose: () => void;
  onPrepare: () => void;
  onInvoke: () => void;
  onBeginAutomation: () => void;
  onReviewAutomation: () => void;
  onConfirmAutomation: () => void;
}) {
  const done = Boolean(run && isTerminalAppRun(run.state)) || automationCreated;
  const canSchedule = resolved
    && !prepared
    && !run
    && !automationMode
    && canManageAutomations
    && automationSelectionReady
    && resolved.action.automationRequests.length > 0;
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    <button type="button" className="deft-pill min-h-11" disabled={Boolean(busy)} onClick={onClose}>{done ? 'Done' : 'Cancel'}</button>
    {canSchedule && <button type="button" className="deft-pill min-h-11" disabled={Boolean(busy)} onClick={onBeginAutomation}><Clock3 size={13} /> Schedule daily</button>}
    {resolved && !prepared && !run && !automationMode && <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={Boolean(busy)} onClick={onPrepare}>{busy === 'prepare' && <Loader2 size={13} className="animate-spin" />} Review action</button>}
    {automationMode && !automationReview && !automationCreated && <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={Boolean(busy)} onClick={onReviewAutomation}>{busy === 'automation-review' && <Loader2 size={13} className="animate-spin" />} Review schedule</button>}
    {automationReview && !automationCreated && <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={Boolean(busy)} onClick={onConfirmAutomation}>{busy === 'automation-create' && <Loader2 size={13} className="animate-spin" />} Approve and create</button>}
    {prepared && !run && <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={Boolean(busy)} onClick={onInvoke}>{busy === 'invoke' && <Loader2 size={13} className="animate-spin" />} Confirm and run</button>}
  </div>;
}

function AutomationResourcePin({ label, pin }: { label: string; pin: AppAutomationReview['placement'] }) {
  const { resourceRef } = pin;
  return <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--surface-container-high)' }}><p className="text-[11px] font-semibold">{label}</p><code className="mt-1 block break-all text-[11px]">{resourceRef.providerKind}:{resourceRef.providerInstanceId}:{resourceRef.resourceType}:{resourceRef.resourceId}</code><code className="mt-1 block break-all text-[10px]" style={{ color: 'var(--outline)' }}>revision {pin.revision} · {pin.contentDigest}</code></div>;
}

function ReadOnlyInput({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--surface-container-high)' }}><p className="text-[11px] font-medium">{label}</p><p className="mt-0.5 text-xs" style={{ color: 'var(--outline)' }}>{value}</p></div>;
}

function SafePreview({ preview }: { preview: AppActionPrepared['safePreview'] }) {
  return <div className="space-y-3"><div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'rgba(48,164,108,.10)' }}><ShieldCheck size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--status-green)' }} /><div><h3 className="text-sm font-semibold">{preview.title}</h3>{preview.summary && <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>{preview.summary}</p>}</div></div>{preview.resourceLabels.length > 0 && <ReadOnlyInput label="Resources" value={preview.resourceLabels.join(', ')} />}{Object.keys(preview.fields).length > 0 && <dl className="space-y-2">{Object.entries(preview.fields).map(([key, value]) => <div key={key} className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-container-high)' }}><dt className="text-[10px] font-semibold uppercase" style={{ color: 'var(--outline)' }}>{humanize(key)}</dt><dd className="mt-1 break-words text-xs">{formatJsonValue(value)}</dd></div>)}</dl>}<p className="text-[11px]" style={{ color: 'var(--outline)' }}>This preview is safe metadata only. Deft will revalidate the exact authority before creating the Run.</p></div>;
}

function RunStatus({ run, polling, result, resultError }: { run: AppRunView; polling: boolean; result?: JsonValue; resultError?: unknown }) {
  const pendingApproval = run.state === 'pending_approval';
  const failed = run.state === 'failed' || run.state === 'cancelled' || run.state === 'expired' || run.state === 'unknown_outcome';
  return <div className="space-y-3"><div className="flex items-start gap-2 rounded-xl p-3" style={{ background: failed ? 'var(--danger-subtle)' : run.state === 'succeeded' ? 'rgba(48,164,108,.10)' : 'var(--surface-container-high)' }}>{failed ? <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--error)' }} /> : run.state === 'succeeded' ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--status-green)' }} /> : <Loader2 size={16} className={`mt-0.5 flex-shrink-0 ${polling ? 'animate-spin' : ''}`} />}<div><h3 className="text-sm font-semibold">{run.state.replaceAll('_', ' ')}</h3><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{run.safeOutcome?.summary ?? run.safePreview.summary ?? 'Deft is tracking this governed Run.'}</p></div></div>{pendingApproval && <Link href="/inbox" className="flex min-h-11 items-center justify-center rounded-lg px-3 text-xs font-semibold" style={{ background: 'var(--primary-container)', color: 'white' }}>Review approval in Inbox</Link>}{result !== undefined && <div><h3 className="text-xs font-semibold">Authorized result</h3><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 text-[11px]" style={{ background: 'var(--surface-container-high)' }}>{JSON.stringify(result, null, 2)}</pre></div>}{resultError !== undefined && resultError !== null && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{resultError instanceof Error ? resultError.message : 'The retained result is unavailable.'}</p>}{run.safeOutcome?.resultStatus === 'expired' && <p className="text-xs" style={{ color: 'var(--outline)' }}>The retained result has expired.</p>}</div>;
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}
