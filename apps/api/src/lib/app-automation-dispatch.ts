import type { AppAutomationFireRow } from './app-automation-repository.js';
import { isAppError } from './app-errors.js';
import { RetryLaterJobError } from './queues.js';

export type AppAutomationFireDelivery = Readonly<{
  job_id: string;
  lease_expires_at?: Date;
  organization_id: string;
  definition_id: string;
  fire_id: string;
  definition_epoch: number;
}>;

type ExactFireInput = Readonly<{
  organization_id: string;
  definition_id: string;
  fire_id: string;
  expected_epoch: number;
}>;

export type AppAutomationDispatchPort = Readonly<{
  enabled(): boolean;
  newClaimToken(): string;
  preflight(input: AppAutomationFireDelivery): Promise<void>;
  load(input: AppAutomationFireDelivery): Promise<AppAutomationFireRow | null>;
  recover(input: ExactFireInput & Readonly<{
    expected_claim_token: string;
    recovered_at: Date;
  }>): Promise<AppAutomationFireRow | null>;
  claim(input: ExactFireInput & Readonly<{
    claim_owner: string;
    claim_token: string;
    claimed_at: Date;
    lease_expires_at: Date;
  }>): Promise<AppAutomationFireRow | null>;
  terminalize(input: ExactFireInput & Readonly<{
    expected_state: 'pending' | 'claimed';
    expected_claim_token?: string;
    terminal_at: Date;
  }>): Promise<AppAutomationFireRow | null>;
  terminalizeMisfire(input: ExactFireInput & Readonly<{
    terminal_at: Date;
  }>): Promise<AppAutomationFireRow | null>;
  settleFailure(input: ExactFireInput & Readonly<{
    expected_claim_token: string;
    failed_at: Date;
  }>): Promise<AppAutomationFireRow | null>;
  invoke(input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    claim_token: string;
  }>): Promise<unknown>;
}>;

/** Claim and submit one exact fire. App Run owns provider execution after
 * submission, so run_created replay is deliberately a no-op here. */
export async function dispatchAppAutomationFire(
  port: AppAutomationDispatchPort,
  delivery: AppAutomationFireDelivery,
  now = new Date(),
): Promise<void> {
  if (!port.enabled()) throw new RetryLaterJobError('App automations are disabled', 60_000);
  let fire = await port.load(delivery);
  if (!fire || fire.definition_epoch !== delivery.definition_epoch) return;
  if (fire.state === 'run_created' || fire.state === 'skipped' || fire.state === 'dead_letter') return;

  const exact = {
    organization_id: delivery.organization_id,
    definition_id: delivery.definition_id,
    fire_id: delivery.fire_id,
    expected_epoch: delivery.definition_epoch,
  } as const;
  if (fire.state === 'claimed') {
    if (!fire.lease_expires_at || !fire.claim_token) return;
    if (fire.lease_expires_at > now) {
      throw new RetryLaterJobError(
        'App automation fire claim is still leased',
        Math.max(1_000, fire.lease_expires_at.getTime() - now.getTime() + 1_000),
      );
    }
    fire = await port.recover({
      ...exact,
      expected_claim_token: fire.claim_token,
      recovered_at: now,
    });
    if (!fire || fire.state !== 'pending') return;
  }

  if (fire.attempt_count === 0) {
    if (!fire.resolved_at_utc) return;
    if (fire.resolved_at_utc > now) {
      throw new RetryLaterJobError(
        'App automation fire is not due',
        Math.max(1_000, fire.resolved_at_utc.getTime() - now.getTime()),
      );
    }
    if (now.getTime() - fire.resolved_at_utc.getTime() > 15 * 60_000) {
      await port.terminalizeMisfire({ ...exact, terminal_at: now });
      return;
    }
  }

  try {
    await port.preflight(delivery);
  } catch (error) {
    if (isAppError(error) && error.code === 'APP_PROVIDER_UNAVAILABLE') {
      throw new RetryLaterJobError('App automation provider is unavailable', 60_000);
    }
    if (isAppError(error)) {
      await port.terminalize({ ...exact, expected_state: 'pending', terminal_at: now });
      return;
    }
    throw error;
  }

  const claimToken = port.newClaimToken();
  const leaseExpiresAt = delivery.lease_expires_at && delivery.lease_expires_at > now
    ? delivery.lease_expires_at
    : new Date(now.getTime() + 60_000);
  const claimed = await port.claim({
    ...exact,
    claim_owner: `job:${delivery.job_id}`,
    claim_token: claimToken,
    claimed_at: now,
    lease_expires_at: leaseExpiresAt,
  });
  if (!claimed) {
    await port.terminalize({ ...exact, expected_state: 'pending', terminal_at: now });
    return;
  }

  try {
    await port.invoke({
      organization_id: delivery.organization_id,
      definition_id: delivery.definition_id,
      fire_id: delivery.fire_id,
      claim_token: claimToken,
    });
  } catch (error) {
    if (isAppError(error) && (
      error.code === 'APP_STALE'
      || error.code === 'APP_ACCESS_DENIED'
      || error.code === 'APP_DISABLED'
      || error.code === 'APP_FEATURE_DISABLED'
    )) {
      await port.terminalize({
        ...exact,
        expected_state: 'claimed',
        expected_claim_token: claimToken,
        terminal_at: new Date(),
      });
      return;
    }
    const settled = await port.settleFailure({
      ...exact,
      expected_claim_token: claimToken,
      failed_at: new Date(),
    });
    if (settled?.state === 'dead_letter') return;
    throw error;
  }
}
