'use client';

import { useState } from 'react';
import { AlertTriangle, Clock3, Loader2, Pause, Play, ShieldAlert } from 'lucide-react';
import { useAppAutomations } from '@/hooks/use-apps';
import { transitionAppAutomation, type AppAutomationDefinition } from '@/lib/app-automations';

export function AppAutomationManagement({ installationId }: { installationId: string }) {
  const state = useAppAutomations(installationId);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const management = state.automations;

  const transition = async (definition: AppAutomationDefinition, action: 'pause' | 'resume') => {
    setBusy(definition.id); setMessage(null);
    try {
      await transitionAppAutomation(installationId, definition, action);
      await state.mutate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Unable to ${action} automation.`);
    } finally {
      setBusy(null);
    }
  };

  return <section className="space-y-3" aria-label="Scheduled App automations">
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
      <div><h3 className="text-xs font-semibold">Scheduled automations</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>Host-governed daily runs with pinned resources, bounded retries, and receipts.</p></div>
      {management && <span className="rounded-full px-2 py-1 text-[10px] font-semibold uppercase" style={{ color: management.killSwitchEnabled ? 'var(--status-green)' : 'var(--status-amber)', background: 'var(--surface-container-high)' }}>{management.killSwitchEnabled ? 'Runner on' : 'Kill switch off'}</span>}
    </div>
    {message && <p role="alert" className="rounded-lg px-3 py-2 text-[11px]" style={{ color: 'var(--error)', background: 'var(--danger-subtle)' }}>{message}</p>}
    {state.isLoading ? <div className="flex min-h-14 items-center justify-center"><Loader2 size={15} className="animate-spin" aria-label="Loading App automations" /></div>
      : state.error || !management ? <p role="alert" className="text-[11px]" style={{ color: 'var(--error)' }}>{state.error instanceof Error ? state.error.message : 'Automations did not load.'}</p>
        : management.definitions.length === 0 ? <div className="rounded-lg px-3 py-3 text-[11px]" style={{ background: 'var(--surface-container-high)', color: 'var(--outline)' }}><Clock3 size={14} className="mb-1.5" />No approved schedules yet. Open an automation-capable App action on a record to create one.</div>
          : <ul className="space-y-2">{management.definitions.map((definition) => <AutomationRow key={definition.id} definition={definition} runnerEnabled={management.killSwitchEnabled} busy={busy === definition.id} onTransition={transition} />)}</ul>}
  </section>;
}

function AutomationRow({ definition, runnerEnabled, busy, onTransition }: {
  definition: AppAutomationDefinition;
  runnerEnabled: boolean;
  busy: boolean;
  onTransition: (definition: AppAutomationDefinition, action: 'pause' | 'resume') => Promise<void>;
}) {
  const active = definition.state === 'active';
  const mutable = active || definition.state === 'paused';
  const last = definition.latestFire;
  return <li className="rounded-lg p-3 text-[11px]" style={{ background: 'var(--surface-container-high)' }}>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><p className="font-semibold">{humanize(definition.automationRequestKey)}</p><p className="mt-0.5" style={{ color: 'var(--outline)' }}>Daily at {definition.schedule.localTime} · {definition.schedule.timezone}</p></div>
      {mutable && <button type="button" className="deft-pill min-h-11 flex-shrink-0" disabled={busy} onClick={() => void onTransition(definition, active ? 'pause' : 'resume')}>{busy ? <Loader2 size={13} className="animate-spin" /> : active ? <Pause size={13} /> : <Play size={13} />} {active ? 'Pause' : 'Resume'}</button>}
    </div>
    <dl className="mt-3 grid gap-2 sm:grid-cols-3">
      <Fact label="State" value={definition.state.replaceAll('_', ' ')} />
      <Fact label="Next fire" value={!runnerEnabled ? 'Runner disabled' : definition.nextFireAtUtc ? formatDate(definition.nextFireAtUtc) : 'Not scheduled'} />
      <Fact label="Last fire / Run" value={definition.latestRun ? `${definition.latestRun.state.replaceAll('_', ' ')} · ${formatDate(definition.latestRun.updatedAt)}` : last ? `${last.state.replaceAll('_', ' ')} · ${last.logicalLocalDate}` : 'No fire yet'} />
      <Fact label="Budget" value={`${definition.budgets.maxOrgRunsPerUtcDay}/day · ${definition.budgets.maxPendingOrgFires} pending`} />
      <Fact label="Dead letters" value={String(definition.fireSummary.deadLetter)} />
      <Fact label="Catch-up" value={`${definition.schedule.catchUpWindowMinutes} minutes`} />
    </dl>
    {!runnerEnabled && <p className="mt-3 flex items-start gap-1.5" style={{ color: 'var(--status-amber)' }}><ShieldAlert size={13} className="mt-0.5 flex-shrink-0" />Resources remain available while scheduled delivery is disabled.</p>}
    {last?.state === 'dead_letter' && <p className="mt-3 flex items-start gap-1.5" style={{ color: 'var(--status-amber)' }}><AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />{definition.retry.reason}</p>}
  </li>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt style={{ color: 'var(--outline)' }}>{label}</dt><dd className="mt-0.5 font-medium">{value}</dd></div>;
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
