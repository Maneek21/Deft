import type {
  AppAutomationDefinitionScanCursor,
  AppAutomationDefinitionRow,
  AppAutomationFireScanCursor,
  AppAutomationFireRow,
} from './app-automation-repository.js';
import {
  classifyAppAutomationOccurrence,
  listAppAutomationLogicalDates,
  resolveAppAutomationOccurrence,
} from './app-automation-schedule.js';

export const APP_AUTOMATION_SCAN_LIMIT = 100;

export type AppAutomationFireDecision = Readonly<{
  organization_id: string;
  definition_id: string;
  expected_epoch: number;
  logical_local_date: string;
  resolution:
    | Readonly<{ kind: 'resolved'; resolved_at_utc: Date }>
    | Readonly<{ kind: 'dst_gap' }>;
  terminal_reason?: 'dst_gap' | 'misfire_skipped';
}>;

export type AppAutomationScannerPort = Readonly<{
  listEligibleDefinitions(
    now: Date,
    limit: number,
    after?: AppAutomationDefinitionScanCursor,
  ): Promise<AppAutomationDefinitionRow[]>;
  listExpiredClaims(
    now: Date,
    limit: number,
    after?: AppAutomationFireScanCursor,
  ): Promise<AppAutomationFireRow[]>;
  reconcileExpiredClaim(
    fire: AppAutomationFireRow,
    now: Date,
  ): Promise<AppAutomationFireRow | null>;
  ensureFire(input: AppAutomationFireDecision, now: Date): Promise<AppAutomationFireRow | null>;
  recoverFire(fire: AppAutomationFireRow, now: Date): Promise<AppAutomationFireRow | null>;
  deliverFire(
    fire: AppAutomationFireRow,
    now: Date,
  ): Promise<void>;
}>;

export type AppAutomationScanResult = Readonly<{
  definitions: number;
  occurrences: number;
  pending: number;
  skipped: number;
  recovered: number;
}>;

/** Reconcile schedule truth into the durable fire ledger. Queue rows only
 * deliver pending fire IDs and never determine whether an occurrence exists. */
export async function scanAppAutomations(
  port: AppAutomationScannerPort,
  now = new Date(),
): Promise<AppAutomationScanResult> {
  let definitionCount = 0;
  let occurrences = 0;
  let pending = 0;
  let skipped = 0;
  let recovered = 0;

  const deliver = async (fire: AppAutomationFireRow): Promise<void> => {
    await port.deliverFire(fire, now);
  };

  let fireAfter: AppAutomationFireScanCursor | undefined;
  do {
    const expired = await port.listExpiredClaims(now, APP_AUTOMATION_SCAN_LIMIT, fireAfter);
    for (const fire of expired) {
      const reconciled = await port.reconcileExpiredClaim(fire, now);
      if (reconciled?.state === 'pending') await deliver(reconciled);
      if (reconciled) recovered += 1;
    }
    const last = expired.at(-1);
    fireAfter = expired.length === APP_AUTOMATION_SCAN_LIMIT && last
      ? { organization_id: last.org_id, fire_id: last.id }
      : undefined;
  } while (fireAfter);

  let after: AppAutomationDefinitionScanCursor | undefined;
  do {
    const definitions = await port.listEligibleDefinitions(now, APP_AUTOMATION_SCAN_LIMIT, after);
    definitionCount += definitions.length;
    for (const definition of definitions) {
      const eligibleAfter = definition.state_changed_at > definition.valid_from
        ? definition.state_changed_at
        : definition.valid_from;
      const dates = listAppAutomationLogicalDates({
        eligible_after: eligibleAfter,
        now,
        timezone: definition.timezone,
      });
      for (const logicalLocalDate of dates) {
        const occurrence = resolveAppAutomationOccurrence({
          logical_local_date: logicalLocalDate,
          local_time: definition.local_time,
          timezone: definition.timezone,
        });
        const decision = classifyAppAutomationOccurrence({
          occurrence,
          now,
          eligible_after: eligibleAfter,
          eligible_before: definition.valid_until,
          catch_up_window_minutes: 15,
        });
        if (decision.kind === 'future' || decision.kind === 'not_eligible') continue;

        let fire = await port.ensureFire({
          organization_id: definition.org_id,
          definition_id: definition.id,
          expected_epoch: definition.definition_epoch,
          logical_local_date: logicalLocalDate,
          resolution: occurrence.resolution,
          ...(decision.kind === 'skipped' ? { terminal_reason: decision.reason } : {}),
        }, now);
        if (!fire) continue;
        if (fire.state === 'claimed'
          && fire.claim_token
          && fire.lease_expires_at
          && fire.lease_expires_at <= now) {
          fire = await port.recoverFire(fire, now);
          if (!fire) continue;
        }
        occurrences += 1;
        if (fire.state === 'pending') {
          pending += 1;
          await deliver(fire);
        } else if (fire.state === 'skipped') {
          skipped += 1;
        }
      }
    }
    const last = definitions.at(-1);
    after = definitions.length === APP_AUTOMATION_SCAN_LIMIT && last
      ? { organization_id: last.org_id, definition_id: last.id }
      : undefined;
  } while (after);

  return { definitions: definitionCount, occurrences, pending, skipped, recovered };
}
