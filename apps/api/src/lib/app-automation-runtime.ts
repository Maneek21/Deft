import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appActionService } from './app-action-service.js';
import { dispatchAppAutomationFire } from './app-automation-dispatch.js';
import { persistAppAutomationFire } from './app-automation-definition-service.js';
import {
  chargeFailedAppAutomationFireDeliveryWithExecutor,
  claimAppAutomationFireWithExecutor,
  getAppAutomationDefinitionWithExecutor,
  getAppAutomationFireWithExecutor,
  listUnsettledAppAutomationFiresWithExecutor,
  listEligibleAppAutomationDefinitionsWithExecutor,
  recoverExpiredAppAutomationFireClaimWithExecutor,
  settleFailedAppAutomationFireClaimWithExecutor,
  terminalizeAppAutomationFireDefinitionIneligibleWithExecutor,
  terminalizeUnclaimedAppAutomationFireMisfireWithExecutor,
  type AppAutomationFireRow,
} from './app-automation-repository.js';
import { scanAppAutomationSlice, APP_AUTOMATION_SCAN_SLICE_LIMITS } from './app-automation-scan-slice.js';
import { initialAppAutomationScanProgress, loadAppAutomationScanProgress, saveAppAutomationScanProgress,
  type AppAutomationScanDelivery } from './app-automation-scan-progress.js';
import { appAutomationScanDatabase, type AppAutomationScanTransaction } from './app-automation-scan-db.js';
import { db } from './db.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import { isAppError } from './app-errors.js';
import { enqueueOrRearmFailed, QUEUE_NAMES } from './queues.js';
import type { JobData } from '../workers/types.js';

const AppAutomationFireJobSchema = z.strictObject({
  organization_id: z.string().min(1).max(256),
  definition_id: z.string().min(1).max(256),
  fire_id: z.string().min(1).max(256),
  definition_epoch: z.number().int().min(1),
});

export async function runAppAutomationScan(now = new Date(), signal?: AbortSignal,
  delivery?: AppAutomationScanDelivery): Promise<void> {
  if (!APP_AUTOMATIONS_ENABLED) return;
  const started = performance.now();
  const deadline = started + APP_AUTOMATION_SCAN_SLICE_LIMITS.milliseconds;
  const currentTime = () => new Date(now.getTime() + performance.now() - started);
  const budget = new AbortController();
  const budgetReason = new Error('App automation scan slice budget exhausted');
  const timer = setTimeout(() => budget.abort(budgetReason), APP_AUTOMATION_SCAN_SLICE_LIMITS.milliseconds);
  const scanSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const transaction = <T>(run: (tx: AppAutomationScanTransaction) => Promise<T>) => (
    appAutomationScanDatabase().transaction(run, scanSignal, deadline)
  );
  let saved = 0;
  try {
    const initial = delivery ? await loadAppAutomationScanProgress(delivery, scanSignal)
      : initialAppAutomationScanProgress();
    const reconcileFire = async (candidate: AppAutomationFireRow): Promise<void> => {
      await transaction(async tx => {
        const definition = await getAppAutomationDefinitionWithExecutor(tx,
          candidate.org_id, candidate.definition_id, { lock: true });
        let fire = await getAppAutomationFireWithExecutor(tx,
          candidate.org_id, candidate.definition_id, candidate.id, { lock: true });
        if (!fire || (fire.state !== 'pending' && fire.state !== 'claimed')) return;
        const checkedAt = currentTime();
        if (fire.state === 'claimed' && (!fire.lease_expires_at || fire.lease_expires_at > checkedAt)) return;
        if (!definition || definition.state !== 'active'
          || definition.definition_epoch !== fire.definition_epoch
          || definition.valid_from > checkedAt || definition.valid_until <= checkedAt) {
          await terminalizeAppAutomationFireDefinitionIneligibleWithExecutor(tx, {
            organization_id: fire.org_id, definition_id: fire.definition_id, fire_id: fire.id,
            expected_epoch: fire.definition_epoch, terminal_at: checkedAt,
            ...(fire.state === 'claimed'
              ? { expected_state: 'claimed' as const, expected_claim_token: fire.claim_token! }
              : { expected_state: 'pending' as const }),
          });
          return;
        }
        if (fire.state === 'claimed') {
          fire = await recoverExpiredAppAutomationFireClaimWithExecutor(tx, {
            organization_id: fire.org_id, definition_id: fire.definition_id, fire_id: fire.id,
            expected_epoch: fire.definition_epoch, expected_claim_token: fire.claim_token!, recovered_at: currentTime(),
          });
        }
        if (!fire || fire.state !== 'pending') return;
        const catchUpExpired = () => fire!.attempt_count === 0 && fire!.resolved_at_utc !== null
          && currentTime().getTime() - fire!.resolved_at_utc.getTime() > definition.catch_up_window_minutes * 60_000;
        if (catchUpExpired()) {
          await terminalizeUnclaimedAppAutomationFireMisfireWithExecutor(tx, {
            organization_id: fire.org_id, definition_id: fire.definition_id, fire_id: fire.id,
            expected_epoch: fire.definition_epoch, terminal_at: currentTime(),
          });
          return;
        }
        const deliveryResult = await enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-fire', {
          organization_id: fire.org_id, definition_id: fire.definition_id, fire_id: fire.id,
          definition_epoch: fire.definition_epoch,
        }, { orgId: fire.org_id,
          dedupeKey: `app-automation-fire:${fire.fire_identity}:attempt:${fire.attempt_count}`,
          maxAttempts: 3, executor: tx });
        if (deliveryResult === 'rearmed') {
          const charged = await chargeFailedAppAutomationFireDeliveryWithExecutor(tx, {
            organization_id: fire.org_id, definition_id: fire.definition_id, fire_id: fire.id,
            expected_epoch: fire.definition_epoch, expected_attempt_count: fire.attempt_count,
            charged_at: currentTime(),
          });
          if (!charged) throw new Error('Failed queue delivery changed before its attempt was charged');
        }
        // Queue insertion/rearm can wait on a queue lock. Roll it back if the
        // locked definition or first-claim window expired during that wait.
        if (currentTime() >= definition.valid_until || catchUpExpired()) {
          throw new Error('App automation eligibility expired during delivery');
        }
      });
    };
    const result = await scanAppAutomationSlice({
      listEligibleDefinitions: (eligibleAt, limit, after) => transaction(tx =>
        listEligibleAppAutomationDefinitionsWithExecutor(tx, { eligible_at: eligibleAt, limit, after })),
      loadDefinition: (orgId, definitionId) => transaction(tx =>
        getAppAutomationDefinitionWithExecutor(tx, orgId, definitionId)),
      listUnsettledFires: (at, limit, after) => transaction(tx =>
        listUnsettledAppAutomationFiresWithExecutor(tx, { now: at, limit, after })),
      reconcileFire,
      deliverFire: reconcileFire,
      ensureFire: async input => {
        try { return await transaction(tx => persistAppAutomationFire(input, { now: currentTime, executor: tx })); }
        catch (error) {
          scanSignal.throwIfAborted();
          if (isAppError(error) && (error.code === 'APP_STALE' || error.code === 'APP_NOT_FOUND')) return null;
          throw error;
        }
      },
      save: async progress => {
        if (delivery) await saveAppAutomationScanProgress(delivery, progress, scanSignal, deadline);
        saved++;
      },
    }, initial, { now: currentTime, signal: scanSignal, deadline });
    if (result.errors > 0) console.warn('[app-automations] scan item failures', result);
  } catch (error) {
    signal?.throwIfAborted();
    if (budget.signal.aborted && saved > 0) return;
    throw error;
  } finally { clearTimeout(timer); }
}
export async function runAppAutomationFire(job: JobData, now = new Date()): Promise<void> {
  const input = AppAutomationFireJobSchema.parse(job.data);
  await dispatchAppAutomationFire({
    enabled: () => APP_AUTOMATIONS_ENABLED,
    newClaimToken: randomUUID,
    preflight: (delivery) => appActionService.preflightApprovedAutomation({
      organization_id: delivery.organization_id,
      definition_id: delivery.definition_id,
      fire_id: delivery.fire_id,
    }),
    load: (delivery) => getAppAutomationFireWithExecutor(
      db,
      delivery.organization_id,
      delivery.definition_id,
      delivery.fire_id,
    ),
    recover: (value) => db.transaction((tx) => (
      recoverExpiredAppAutomationFireClaimWithExecutor(tx, value)
    )),
    claim: (value) => db.transaction((tx) => claimAppAutomationFireWithExecutor(tx, value)),
    terminalize: (value) => db.transaction((tx) => (
      terminalizeAppAutomationFireDefinitionIneligibleWithExecutor(tx, value.expected_state === 'claimed'
        ? { ...value, expected_state: 'claimed', expected_claim_token: value.expected_claim_token! }
        : { ...value, expected_state: 'pending' })
    )),
    terminalizeMisfire: (value) => db.transaction((tx) => (
      terminalizeUnclaimedAppAutomationFireMisfireWithExecutor(tx, value)
    )),
    settleFailure: (value) => db.transaction((tx) => (
      settleFailedAppAutomationFireClaimWithExecutor(tx, value)
    )),
    invoke: (value) => appActionService.invokeApprovedAutomation(value),
  }, {
    job_id: job.id,
    lease_expires_at: job.leaseExpiresAt,
    ...input,
  }, now);
}
