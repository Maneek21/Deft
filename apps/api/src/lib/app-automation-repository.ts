import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import {
  appAutomationDefinitions,
  appAutomationFires,
  orgMembers,
} from '@deft/db/schema';
import { db } from './db.js';

export type AppAutomationDefinitionRow = typeof appAutomationDefinitions.$inferSelect;
export type AppAutomationDefinitionInsert = typeof appAutomationDefinitions.$inferInsert;
export type AppAutomationFireRow = typeof appAutomationFires.$inferSelect;
export type AppAutomationFireInsert = typeof appAutomationFires.$inferInsert;

/**
 * Host-only verification view consumed by live authorization. The full rows
 * are intentional: every immutable request, App, grant, binding, provider,
 * resource, schedule, budget, validity, approver, epoch, policy, and digest
 * pin is required to construct and revalidate the prepared authority vector.
 */
export type AppAutomationDefinitionVerificationView = Readonly<AppAutomationDefinitionRow>;
export type AppAutomationFireVerificationView = Readonly<AppAutomationFireRow>;
export type AppAutomationVerificationContext = Readonly<{
  definition: AppAutomationDefinitionVerificationView;
  fire: AppAutomationFireVerificationView;
  approver: Readonly<{
    user_id: string;
    role: 'owner' | 'admin';
    authorization_version: number;
  }>;
}>;

export type AppAutomationVerificationReadPort = Readonly<{
  load(input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
  }>): Promise<AppAutomationVerificationContext | null>;
}>;

type AutomationExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

const MAX_AUTOMATION_SCAN_LIMIT = 500;

export type AppAutomationDefinitionScanCursor = Readonly<{
  organization_id: string;
  definition_id: string;
}>;

export type AppAutomationFireScanCursor = Readonly<{
  organization_id: string;
  fire_id: string;
}>;

export async function getAppAutomationDefinitionWithExecutor(
  executor: AutomationExecutor,
  organizationId: string,
  definitionId: string,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<AppAutomationDefinitionRow | null> {
  let query = executor.select().from(appAutomationDefinitions).where(and(
    eq(appAutomationDefinitions.org_id, organizationId),
    eq(appAutomationDefinitions.id, definitionId),
  )).limit(1);
  if (options.lock) query = query.for('update') as typeof query;
  return (await query)[0] ?? null;
}

export async function listAppAutomationDefinitionsWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    app_installation_id?: string;
    limit: number;
  }>,
): Promise<AppAutomationDefinitionRow[]> {
  const where = input.app_installation_id
    ? and(
      eq(appAutomationDefinitions.org_id, input.organization_id),
      eq(appAutomationDefinitions.app_installation_id, input.app_installation_id),
    )
    : eq(appAutomationDefinitions.org_id, input.organization_id);
  return executor.select().from(appAutomationDefinitions)
    .where(where)
    .orderBy(desc(appAutomationDefinitions.created_at), desc(appAutomationDefinitions.id))
    .limit(input.limit);
}

/**
 * Host-scheduler read across organizations. Results are eligibility-filtered,
 * deterministically ordered, cursor-pageable, and hard bounded so a singleton
 * scan cannot turn into an unbounded tenant-wide read.
 */
export async function listEligibleAppAutomationDefinitionsWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    eligible_at: Date;
    limit: number;
    after?: AppAutomationDefinitionScanCursor;
  }>,
): Promise<AppAutomationDefinitionRow[]> {
  if (!Number.isFinite(input.limit) || input.limit <= 0) return [];
  const cursorCondition = input.after
    ? or(
      gt(appAutomationDefinitions.org_id, input.after.organization_id),
      and(
        eq(appAutomationDefinitions.org_id, input.after.organization_id),
        gt(appAutomationDefinitions.id, input.after.definition_id),
      ),
    )
    : undefined;
  return executor.select().from(appAutomationDefinitions).where(and(
    eq(appAutomationDefinitions.state, 'active'),
    lte(appAutomationDefinitions.valid_from, input.eligible_at),
    gt(appAutomationDefinitions.valid_until, input.eligible_at),
    cursorCondition,
  )).orderBy(
    asc(appAutomationDefinitions.org_id),
    asc(appAutomationDefinitions.id),
  ).limit(Math.min(Math.trunc(input.limit), MAX_AUTOMATION_SCAN_LIMIT));
}

export async function insertAppAutomationDefinitionWithExecutor(
  executor: AutomationExecutor,
  value: AppAutomationDefinitionInsert,
): Promise<AppAutomationDefinitionRow> {
  const [created] = await executor.insert(appAutomationDefinitions).values(value).returning();
  if (!created) throw new Error('App automation definition insert returned no row');
  return created;
}

export async function transitionAppAutomationDefinitionWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    expected_epoch: number;
    expected_state: 'active' | 'paused';
    next_state: 'active' | 'paused' | 'revoked' | 'expired';
    changed_at: Date;
  }>,
): Promise<AppAutomationDefinitionRow | null> {
  const [updated] = await executor.update(appAutomationDefinitions).set({
    state: input.next_state,
    definition_epoch: input.expected_epoch + 1,
    state_changed_at: input.changed_at,
    revoked_at: input.next_state === 'revoked' ? input.changed_at : null,
    expired_at: input.next_state === 'expired' ? input.changed_at : null,
    updated_at: input.changed_at,
  }).where(and(
    eq(appAutomationDefinitions.org_id, input.organization_id),
    eq(appAutomationDefinitions.id, input.definition_id),
    eq(appAutomationDefinitions.definition_epoch, input.expected_epoch),
    eq(appAutomationDefinitions.state, input.expected_state),
  )).returning();
  return updated ?? null;
}

export async function getAppAutomationFireWithExecutor(
  executor: AutomationExecutor,
  organizationId: string,
  definitionId: string,
  fireId: string,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<AppAutomationFireRow | null> {
  let query = executor.select().from(appAutomationFires).where(and(
    eq(appAutomationFires.org_id, organizationId),
    eq(appAutomationFires.definition_id, definitionId),
    eq(appAutomationFires.id, fireId),
  )).limit(1);
  if (options.lock) query = query.for('update') as typeof query;
  return (await query)[0] ?? null;
}

export async function getAppAutomationFireByIdentityWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    fire_identity: string;
  }>,
): Promise<AppAutomationFireRow | null> {
  const [fire] = await executor.select().from(appAutomationFires).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.fire_identity, input.fire_identity),
  )).limit(1);
  return fire ?? null;
}

export async function getAppAutomationFireByOccurrenceWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    definition_epoch: number;
    logical_local_date: string;
    local_time: string;
    timezone: string;
  }>,
): Promise<AppAutomationFireRow | null> {
  const [fire] = await executor.select().from(appAutomationFires).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.definition_epoch, input.definition_epoch),
    eq(appAutomationFires.logical_local_date, input.logical_local_date),
    eq(appAutomationFires.local_time, input.local_time),
    eq(appAutomationFires.timezone, input.timezone),
  )).limit(1);
  return fire ?? null;
}

/**
 * Host-scheduler discovery of expired claims only. Lifecycle policy remains in
 * the caller; this read is deterministic, cursor-pageable, and hard bounded.
 */
export async function listExpiredClaimedAppAutomationFiresWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    now: Date;
    limit: number;
    after?: AppAutomationFireScanCursor;
  }>,
): Promise<AppAutomationFireRow[]> {
  if (!Number.isFinite(input.limit) || input.limit <= 0) return [];
  const cursorCondition = input.after
    ? or(
      gt(appAutomationFires.org_id, input.after.organization_id),
      and(
        eq(appAutomationFires.org_id, input.after.organization_id),
        gt(appAutomationFires.id, input.after.fire_id),
      ),
    )
    : undefined;
  return executor.select().from(appAutomationFires).where(and(
    eq(appAutomationFires.state, 'claimed'),
    lte(appAutomationFires.lease_expires_at, input.now),
    cursorCondition,
  )).orderBy(
    asc(appAutomationFires.org_id),
    asc(appAutomationFires.id),
  ).limit(Math.min(Math.trunc(input.limit), MAX_AUTOMATION_SCAN_LIMIT));
}

export async function insertAppAutomationFireWithExecutor(
  executor: AutomationExecutor,
  value: AppAutomationFireInsert,
): Promise<AppAutomationFireRow> {
  const [created] = await executor.insert(appAutomationFires).values(value).returning();
  if (!created) throw new Error('App automation fire insert returned no row');
  return created;
}

/**
 * Inserts a deterministic occurrence once. A concurrent scanner that loses a
 * unique-key race receives the already persisted occurrence instead of
 * manufacturing a second fire or treating normal overlap as a failure.
 */
export async function insertAppAutomationFireIdempotentlyWithExecutor(
  executor: AutomationExecutor,
  value: AppAutomationFireInsert,
): Promise<AppAutomationFireRow> {
  const [created] = await executor.insert(appAutomationFires)
    .values(value)
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const byIdentity = await getAppAutomationFireByIdentityWithExecutor(executor, {
    organization_id: value.org_id,
    fire_identity: value.fire_identity,
  });
  if (byIdentity
    && byIdentity.definition_id === value.definition_id
    && byIdentity.definition_epoch === value.definition_epoch
    && byIdentity.logical_local_date === value.logical_local_date
    && byIdentity.local_time === value.local_time
    && byIdentity.timezone === value.timezone) return byIdentity;

  const byOccurrence = await getAppAutomationFireByOccurrenceWithExecutor(executor, {
    organization_id: value.org_id,
    definition_id: value.definition_id,
    definition_epoch: value.definition_epoch,
    logical_local_date: value.logical_local_date,
    local_time: value.local_time,
    timezone: value.timezone,
  });
  if (byOccurrence && byOccurrence.fire_identity === value.fire_identity) return byOccurrence;

  throw new Error('App automation fire insert conflicted without a matching deterministic occurrence');
}

type AppAutomationFireClaimSettlementInput = Readonly<{
  organization_id: string;
  definition_id: string;
  fire_id: string;
  expected_epoch: number;
  expected_claim_token: string;
  settled_at: Date;
}>;

async function settleFailedAppAutomationFireClaim(
  executor: AutomationExecutor,
  input: AppAutomationFireClaimSettlementInput,
  options: Readonly<{ require_expired_lease: boolean }>,
): Promise<AppAutomationFireRow | null> {
  const leaseFence = options.require_expired_lease
    ? lte(appAutomationFires.lease_expires_at, input.settled_at)
    : undefined;
  const exactClaim = and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, 'claimed'),
    eq(appAutomationFires.claim_token, input.expected_claim_token),
    leaseFence,
  );
  const [deadLettered] = await executor.update(appAutomationFires).set({
    state: 'dead_letter',
    claim_owner: null,
    claim_token: null,
    claimed_at: null,
    lease_expires_at: null,
    terminal_reason: 'attempts_exhausted',
    terminal_at: input.settled_at,
    updated_at: input.settled_at,
  }).where(and(
    exactClaim,
    eq(appAutomationFires.attempt_count, 3),
  )).returning();
  if (deadLettered) return deadLettered;

  const [released] = await executor.update(appAutomationFires).set({
    state: 'pending',
    claim_owner: null,
    claim_token: null,
    claimed_at: null,
    lease_expires_at: null,
    updated_at: input.settled_at,
  }).where(and(
    exactClaim,
    lt(appAutomationFires.attempt_count, 3),
  )).returning();
  return released ?? null;
}

/**
 * Recovers one expired claim using its immutable tenant/definition/fire tuple,
 * definition epoch, and secret claim token as CAS fences. The third failed
 * orchestration attempt is terminal; earlier attempts return to pending.
 */
export async function recoverExpiredAppAutomationFireClaimWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    expected_claim_token: string;
    recovered_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  return settleFailedAppAutomationFireClaim(executor, {
    ...input,
    settled_at: input.recovered_at,
  }, { require_expired_lease: true });
}

/** Settles an explicitly failed live claim without waiting for lease expiry. */
export async function settleFailedAppAutomationFireClaimWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    expected_claim_token: string;
    failed_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  return settleFailedAppAutomationFireClaim(executor, {
    ...input,
    settled_at: input.failed_at,
  }, { require_expired_lease: false });
}

type DefinitionIneligibleFireExpectation =
  | Readonly<{ expected_state: 'pending' }>
  | Readonly<{ expected_state: 'claimed'; expected_claim_token: string }>;

/** Terminalizes one caller-verified ineligible fire without widening its CAS. */
export async function terminalizeAppAutomationFireDefinitionIneligibleWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    terminal_at: Date;
  }> & DefinitionIneligibleFireExpectation,
): Promise<AppAutomationFireRow | null> {
  const claimFence = input.expected_state === 'claimed'
    ? eq(appAutomationFires.claim_token, input.expected_claim_token)
    : undefined;
  const [terminalized] = await executor.update(appAutomationFires).set({
    state: 'skipped',
    claim_owner: null,
    claim_token: null,
    claimed_at: null,
    lease_expires_at: null,
    terminal_reason: 'definition_ineligible',
    terminal_at: input.terminal_at,
    updated_at: input.terminal_at,
  }).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, input.expected_state),
    claimFence,
  )).returning();
  return terminalized ?? null;
}

/** Marks one never-claimed pending occurrence as an elapsed-window misfire. */
export async function terminalizeUnclaimedAppAutomationFireMisfireWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    terminal_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  const [terminalized] = await executor.update(appAutomationFires).set({
    state: 'skipped',
    claim_owner: null,
    claim_token: null,
    claimed_at: null,
    lease_expires_at: null,
    terminal_reason: 'misfire_skipped',
    terminal_at: input.terminal_at,
    updated_at: input.terminal_at,
  }).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, 'pending'),
    eq(appAutomationFires.attempt_count, 0),
  )).returning();
  return terminalized ?? null;
}

/** Charge one terminal queue-delivery generation against the fire's bounded
 * orchestration attempts. Exact CAS prevents duplicate scanners charging it. */
export async function chargeFailedAppAutomationFireDeliveryWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    expected_attempt_count: number;
    charged_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  if (input.expected_attempt_count < 0 || input.expected_attempt_count >= 3) return null;
  const nextAttempt = input.expected_attempt_count + 1;
  const [charged] = await executor.update(appAutomationFires).set({
    attempt_count: nextAttempt,
    state: nextAttempt === 3 ? 'dead_letter' : 'pending',
    terminal_reason: nextAttempt === 3 ? 'attempts_exhausted' : null,
    terminal_at: nextAttempt === 3 ? input.charged_at : null,
    updated_at: input.charged_at,
  }).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, 'pending'),
    eq(appAutomationFires.attempt_count, input.expected_attempt_count),
  )).returning();
  return charged ?? null;
}

/**
 * Claims one caller-selected fire only. Callers must provide a transaction so
 * the organization advisory lock, budget read, and CAS update remain atomic.
 * This deliberately does not scan for due work or enqueue anything.
 */
export async function claimAppAutomationFireWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    claim_owner: string;
    claim_token: string;
    claimed_at: Date;
    lease_expires_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  if (input.lease_expires_at <= input.claimed_at) return null;
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`deft.app_automation.pending_budget:${input.organization_id}`}, 0
  ))`);
  const definition = await getAppAutomationDefinitionWithExecutor(
    executor,
    input.organization_id,
    input.definition_id,
  );
  if (!definition
    || definition.state !== 'active'
    || definition.definition_epoch !== input.expected_epoch
    || input.claimed_at < definition.valid_from
    || input.claimed_at >= definition.valid_until) return null;
  const [budget] = await executor.select({
    pending_count: sql<number>`count(*)::int`,
  }).from(appAutomationFires).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    inArray(appAutomationFires.state, ['pending', 'claimed']),
  ));
  if ((budget?.pending_count ?? 0) > Math.min(definition.max_pending_org_fires, 25)) {
    return null;
  }
  const utcDayStart = new Date(input.claimed_at);
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const utcDayEnd = new Date(utcDayStart.getTime() + 24 * 60 * 60_000);
  const [runBudget] = await executor.select({
    reserved_count: sql<number>`count(*)::int`,
  }).from(appAutomationFires).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    inArray(appAutomationFires.state, ['claimed', 'run_created']),
    sql`COALESCE(${appAutomationFires.terminal_at}, ${appAutomationFires.claimed_at}) >= ${utcDayStart}`,
    sql`COALESCE(${appAutomationFires.terminal_at}, ${appAutomationFires.claimed_at}) < ${utcDayEnd}`,
  ));
  if ((runBudget?.reserved_count ?? 0) >= Math.min(definition.max_org_runs_per_utc_day, 100)) {
    return null;
  }
  const [claimed] = await executor.update(appAutomationFires).set({
    state: 'claimed',
    attempt_count: sql`${appAutomationFires.attempt_count} + 1`,
    claim_owner: input.claim_owner,
    claim_token: input.claim_token,
    claimed_at: input.claimed_at,
    lease_expires_at: input.lease_expires_at,
    updated_at: input.claimed_at,
  }).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, 'pending'),
    lt(appAutomationFires.attempt_count, 3),
    // An occurrence delayed before its first claim must never execute outside
    // the approved catch-up window. Later safe orchestration retries retain
    // the same fire identity and were already admitted by a timely claim.
    or(
      gt(appAutomationFires.attempt_count, 0),
      and(
        gte(
          appAutomationFires.resolved_at_utc,
          new Date(input.claimed_at.getTime() - definition.catch_up_window_minutes * 60_000),
        ),
        lte(appAutomationFires.resolved_at_utc, input.claimed_at),
      ),
    ),
  )).returning();
  return claimed ?? null;
}

export async function bindAppAutomationFireRunWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
    expected_epoch: number;
    expected_claim_token: string;
    app_run_id: string;
    terminal_at: Date;
  }>,
): Promise<AppAutomationFireRow | null> {
  const [updated] = await executor.update(appAutomationFires).set({
    state: 'run_created',
    app_run_id: input.app_run_id,
    terminal_reason: 'run_created',
    terminal_at: input.terminal_at,
    updated_at: input.terminal_at,
  }).where(and(
    eq(appAutomationFires.org_id, input.organization_id),
    eq(appAutomationFires.definition_id, input.definition_id),
    eq(appAutomationFires.id, input.fire_id),
    eq(appAutomationFires.definition_epoch, input.expected_epoch),
    eq(appAutomationFires.state, 'claimed'),
    eq(appAutomationFires.claim_token, input.expected_claim_token),
    gt(appAutomationFires.lease_expires_at, input.terminal_at),
  )).returning();
  return updated ?? null;
}

async function loadVerificationContext(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
  }>,
): Promise<AppAutomationVerificationContext | null> {
  const definition = await getAppAutomationDefinitionWithExecutor(
    executor,
    input.organization_id,
    input.definition_id,
  );
  if (!definition) return null;
  const fire = await getAppAutomationFireWithExecutor(
    executor,
    input.organization_id,
    input.definition_id,
    input.fire_id,
  );
  if (!fire) return null;
  const [approver] = await executor.select({
    user_id: orgMembers.user_id,
    role: orgMembers.role,
    authorization_version: orgMembers.app_run_authorization_version,
  }).from(orgMembers).where(and(
    eq(orgMembers.org_id, input.organization_id),
    eq(orgMembers.user_id, definition.approved_by_user_id),
    eq(orgMembers.is_active, true),
    inArray(orgMembers.role, ['owner', 'admin']),
  )).limit(1);
  if (!approver || (approver.role !== 'owner' && approver.role !== 'admin')) return null;
  return { definition, fire, approver: { ...approver, role: approver.role } };
}

export const postgresAppAutomationVerificationReadPort: AppAutomationVerificationReadPort = {
  load: (input) => loadVerificationContext(db, input),
};
