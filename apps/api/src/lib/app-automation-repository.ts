import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
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

export async function insertAppAutomationFireWithExecutor(
  executor: AutomationExecutor,
  value: AppAutomationFireInsert,
): Promise<AppAutomationFireRow> {
  const [created] = await executor.insert(appAutomationFires).values(value).returning();
  if (!created) throw new Error('App automation fire insert returned no row');
  return created;
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
  )).returning();
  return claimed ?? null;
}

export async function bindAppAutomationFireRunWithExecutor(
  executor: AutomationExecutor,
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    fire_id: string;
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
    eq(appAutomationFires.state, 'claimed'),
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
