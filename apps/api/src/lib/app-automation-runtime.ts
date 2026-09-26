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
  listExpiredClaimedAppAutomationFiresWithExecutor,
  listEligibleAppAutomationDefinitionsWithExecutor,
  recoverExpiredAppAutomationFireClaimWithExecutor,
  settleFailedAppAutomationFireClaimWithExecutor,
  terminalizeAppAutomationFireDefinitionIneligibleWithExecutor,
  terminalizeUnclaimedAppAutomationFireMisfireWithExecutor,
} from './app-automation-repository.js';
import { scanAppAutomations, type AppAutomationScannerPort } from './app-automation-scanner.js';
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

export async function runAppAutomationScan(now = new Date(), signal?: AbortSignal): Promise<void> {
  if (!APP_AUTOMATIONS_ENABLED) return;
  const started = performance.now();
  const currentTime = () => new Date(now.getTime() + performance.now() - started);
  const transaction = <T>(run: (tx: AppAutomationScanTransaction) => Promise<T>) => (
    appAutomationScanDatabase().transaction(run, signal)
  );
  const reconcileExpiredClaim: AppAutomationScannerPort['reconcileExpiredClaim'] = (fire) => (
    transaction(async (tx) => {
      const definition = await getAppAutomationDefinitionWithExecutor(
        tx,
        fire.org_id,
        fire.definition_id,
        { lock: true },
      );
      // Read policy time only after both mutable rows are locked. Reusing this
      // path for occurrence recovery avoids passing time captured before a wait.
      const currentFire = await getAppAutomationFireWithExecutor(
        tx, fire.org_id, fire.definition_id, fire.id, { lock: true },
      );
      if (!currentFire || currentFire.state !== 'claimed'
        || currentFire.claim_token !== fire.claim_token) return null;
      const recoveredAt = currentTime();
      if (!definition
        || definition.state !== 'active'
        || definition.definition_epoch !== fire.definition_epoch
        || definition.valid_from > recoveredAt
        || definition.valid_until <= recoveredAt) {
        return terminalizeAppAutomationFireDefinitionIneligibleWithExecutor(tx, {
          organization_id: fire.org_id,
          definition_id: fire.definition_id,
          fire_id: fire.id,
          expected_epoch: fire.definition_epoch,
          expected_state: 'claimed',
          expected_claim_token: fire.claim_token!,
          terminal_at: recoveredAt,
        });
      }
      const recovered = await recoverExpiredAppAutomationFireClaimWithExecutor(tx, {
        organization_id: fire.org_id,
        definition_id: fire.definition_id,
        fire_id: fire.id,
        expected_epoch: fire.definition_epoch,
        expected_claim_token: fire.claim_token!,
        recovered_at: recoveredAt,
      });
      if (currentTime() >= definition.valid_until) {
        throw new Error('App automation definition expired during claim recovery');
      }
      return recovered;
    })
  );
  const result = await scanAppAutomations({
    listEligibleDefinitions: (eligibleAt, limit, after) => (
      transaction(tx => listEligibleAppAutomationDefinitionsWithExecutor(tx, {
        eligible_at: eligibleAt,
        limit,
        after,
      }))
    ),
    listExpiredClaims: (scanAt, limit, after) => (
      transaction(tx => listExpiredClaimedAppAutomationFiresWithExecutor(tx, { now: scanAt, limit, after }))
    ),
    reconcileExpiredClaim,
    ensureFire: async (input) => {
      try {
        return await transaction(tx => persistAppAutomationFire(input, { now: currentTime, executor: tx }));
      } catch (error) {
        if (isAppError(error) && (error.code === 'APP_STALE' || error.code === 'APP_NOT_FOUND')) {
          return null;
        }
        throw error;
      }
    },
    recoverFire: reconcileExpiredClaim,
    deliverFire: (fire) => transaction(async (tx) => {
      const delivery = await enqueueOrRearmFailed(
        QUEUE_NAMES.SCHEDULED_JOBS,
        'app-automation-fire',
        {
          organization_id: fire.org_id,
          definition_id: fire.definition_id,
          fire_id: fire.id,
          definition_epoch: fire.definition_epoch,
        },
        {
          orgId: fire.org_id,
          dedupeKey: `app-automation-fire:${fire.fire_identity}:attempt:${fire.attempt_count}`,
          maxAttempts: 3,
          executor: tx,
        },
      );
      if (delivery !== 'rearmed') return;
      const charged = await chargeFailedAppAutomationFireDeliveryWithExecutor(tx, {
        organization_id: fire.org_id,
        definition_id: fire.definition_id,
        fire_id: fire.id,
        expected_epoch: fire.definition_epoch,
        expected_attempt_count: fire.attempt_count,
        charged_at: currentTime(),
      });
      if (!charged) throw new Error('Failed queue delivery changed before its attempt was charged');
    }),
  }, now, { signal, now: currentTime });
  if (Object.values(result.errors).some(count => count > 0)) {
    // One bounded aggregate warning; never emit raw tenant/provider errors.
    console.warn('[app-automations] scan item failures', result);
  }
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
