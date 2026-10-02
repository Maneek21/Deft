import type { AppAutomationDefinitionRow, AppAutomationFireRow } from './app-automation-repository.js';
import type { AppAutomationScannerPort } from './app-automation-scanner.js';
import { classifyAppAutomationOccurrence, listAppAutomationLogicalDates, resolveAppAutomationOccurrence } from './app-automation-schedule.js';
import type { AppAutomationScanProgress } from './app-automation-scan-progress.js';

export const APP_AUTOMATION_SCAN_SLICE_LIMITS = Object.freeze({
  milliseconds: 10_000, definition_visits: 256, fire_items: 256, occurrence_decisions: 512,
});
export type AppAutomationSlicePort = Pick<AppAutomationScannerPort, 'listEligibleDefinitions' | 'ensureFire' | 'deliverFire'> & {
  loadDefinition(organizationId: string, definitionId: string): Promise<AppAutomationDefinitionRow | null>;
  listUnsettledFires(now: Date, limit: number, after?: { organization_id: string; fire_id: string }): Promise<AppAutomationFireRow[]>;
  reconcileFire(fire: AppAutomationFireRow, now: Date): Promise<void>;
  save(progress: AppAutomationScanProgress): Promise<void>;
};

/** Fair work units are a single logical date or unsettled fire. Persist only
 * after the corresponding operation settles; crashes before save safely replay. */
export async function scanAppAutomationSlice(port: AppAutomationSlicePort, initial: AppAutomationScanProgress,
  options: Readonly<{ now: () => Date; signal?: AbortSignal; deadline: number }>) {
  const progress = structuredClone(initial);
  let definitionVisits = 0;
  let fireItems = 0;
  let decisions = 0;
  let saved = 0;
  let errors = 0;
  let definitions: AppAutomationDefinitionRow[] = [];
  let fires: AppAutomationFireRow[] = [];
  let currentDefinition: AppAutomationDefinitionRow | null = null;
  const blocked = { definitions: false, fires: false };
  const cancelled = (error: unknown) => {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
  };
  const save = async () => { await port.save(progress); saved++; };
  const finishDefinition = (definition: { org_id: string; id: string }) => {
    progress.definitions.after = { organization_id: definition.org_id, definition_id: definition.id };
    progress.definitions.partial = null;
    currentDefinition = null;
  };
  while (performance.now() + 1_000 < options.deadline
    && definitionVisits < APP_AUTOMATION_SCAN_SLICE_LIMITS.definition_visits
    && fireItems < APP_AUTOMATION_SCAN_SLICE_LIMITS.fire_items
    && decisions < APP_AUTOMATION_SCAN_SLICE_LIMITS.occurrence_decisions) {
    options.signal?.throwIfAborted();
    if (progress.definitions.done && progress.fires.done) {
      progress.complete = true;
      await save();
      return { state: 'complete' as const, saved, definitionVisits, fireItems, decisions, errors };
    }
    let lane = progress.next_lane;
    if (progress[lane].done || blocked[lane]) lane = lane === 'fires' ? 'definitions' : 'fires';
    if (progress[lane].done || blocked[lane]) {
      if (saved > 0) return { state: 'partial' as const, saved, definitionVisits, fireItems, decisions, errors };
      throw new Error('App automation scan catalog unavailable');
    }
    progress.next_lane = lane === 'fires' ? 'definitions' : 'fires';
    if (lane === 'fires') {
      if (fires.length === 0) {
        try { fires = await port.listUnsettledFires(options.now(), 100, progress.fires.after ?? undefined); }
        catch (error) { cancelled(error); blocked.fires = true; errors++; continue; }
        if (fires.length === 0) { progress.fires.done = true; await save(); continue; }
      }
      const fire = fires.shift()!;
      try { await port.reconcileFire(fire, options.now()); }
      catch (error) { cancelled(error); errors++; }
      progress.fires.after = { organization_id: fire.org_id, fire_id: fire.id };
      fireItems++;
      await save();
      continue;
    }
    if (!currentDefinition) {
      if (progress.definitions.partial) {
        const partial = progress.definitions.partial;
        try { currentDefinition = await port.loadDefinition(partial.organization_id, partial.definition_id); }
        catch (error) { cancelled(error); blocked.definitions = true; errors++; continue; }
        definitionVisits++;
        if (!currentDefinition || currentDefinition.definition_epoch !== partial.definition_epoch) {
          finishDefinition({ org_id: partial.organization_id, id: partial.definition_id });
          await save();
          continue;
        }
      } else {
        if (definitions.length === 0) {
          try { definitions = await port.listEligibleDefinitions(options.now(), 100, progress.definitions.after ?? undefined); }
          catch (error) { cancelled(error); blocked.definitions = true; errors++; continue; }
          if (definitions.length === 0) { progress.definitions.done = true; await save(); continue; }
        }
        currentDefinition = definitions.shift()!;
        definitionVisits++;
      }
    }
    const definition = currentDefinition;
    const now = options.now();
    if (definition.state !== 'active' || definition.valid_from > now || definition.valid_until <= now) {
      finishDefinition(definition); await save(); continue;
    }
    const eligibleAfter = definition.state_changed_at > definition.valid_from ? definition.state_changed_at : definition.valid_from;
    let dates: string[];
    try { dates = listAppAutomationLogicalDates({ eligible_after: eligibleAfter, now, timezone: definition.timezone }); }
    catch (error) { cancelled(error); errors++; finishDefinition(definition); await save(); continue; }
    const nextDate = progress.definitions.partial?.next_logical_local_date;
    const index = nextDate ? dates.findIndex(date => date >= nextDate) : 0;
    if (index < 0 || index >= dates.length) { finishDefinition(definition); await save(); continue; }
    const logicalDate = dates[index]!;
    try {
      const occurrence = resolveAppAutomationOccurrence({ logical_local_date: logicalDate,
        local_time: definition.local_time, timezone: definition.timezone });
      const decision = classifyAppAutomationOccurrence({ occurrence, now,
        eligible_after: eligibleAfter, eligible_before: definition.valid_until, catch_up_window_minutes: 15 });
      if (decision.kind !== 'future' && decision.kind !== 'not_eligible') {
        const fire = await port.ensureFire({ organization_id: definition.org_id, definition_id: definition.id,
          expected_epoch: definition.definition_epoch, logical_local_date: logicalDate,
          resolution: occurrence.resolution,
          ...(decision.kind === 'skipped' ? { terminal_reason: decision.reason } : {}),
        }, options.now());
        if (fire && (fire.state === 'pending' || fire.state === 'claimed')) await port.reconcileFire(fire, options.now());
      }
    } catch (error) { cancelled(error); errors++; }
    decisions++;
    const following = dates[index + 1];
    if (following) progress.definitions.partial = { organization_id: definition.org_id, definition_id: definition.id,
      definition_epoch: definition.definition_epoch, next_logical_local_date: following };
    else finishDefinition(definition);
    await save();
  }
  options.signal?.throwIfAborted();
  if (saved === 0) throw new Error('App automation scan made no durable progress');
  return { state: 'partial' as const, saved, definitionVisits, fireItems, decisions, errors };
}
