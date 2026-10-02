import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { agentEmployees, appRuntimeBindings, appRuntimeRegistrations, appRuntimeAgentPolicies, appVersions } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { AppRunError } from './app-run-errors.js';
import { AppError } from './app-errors.js';
import { PostgresAppRunLiveAuthorization } from './app-run-live-authorization.js';
import { experienceExposureDatabase } from './app-experience-exposure-db.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';

export const RuntimeActionListSchema = z.strictObject({ installation_id: z.string().uuid().optional(), after: z.string().uuid().optional(), limit: z.number().int().min(1).max(16).default(16) });
export const RuntimeActionGetSchema = z.strictObject({ runtime_binding_id: z.string().uuid() });
export const runtimeActionDiscoveryInputSchemas = {
  app_runtime_action_list: { type: 'object', properties: { installation_id: { type: 'string', format: 'uuid' }, after: { type: 'string', format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 16 } }, additionalProperties: false },
  app_runtime_action_get: { type: 'object', properties: { runtime_binding_id: { type: 'string', format: 'uuid' } }, required: ['runtime_binding_id'], additionalProperties: false },
} as const;

function assertActor(actor: ModuleActor) {
  if (actor.kind === 'system' || (actor.kind !== 'agent_employee' && actor.role === 'guest')
    || ((actor.kind === 'human' || actor.kind === 'agent_employee') && actor.source === 'mcp' && !actor.scopes.includes('read:apps'))) {
    throw new AppRunError('APP_RUN_ACCESS_DENIED');
  }
  if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
}

/** Metadata only. A descriptor is never authority to invoke; admission repeats
 * the current binding, membership, grant, employee and owner policy checks. */
export async function listRuntimeActions(actor: ModuleActor, raw: unknown = {}) {
  assertActor(actor);
  const request = RuntimeActionListSchema.parse(raw);
  return discover(actor, request);
}

export async function getRuntimeAction(actor: ModuleActor, raw: unknown) {
  assertActor(actor);
  const request = RuntimeActionGetSchema.parse(raw);
  const result = await discover(actor, { ...request, limit: 1 });
  if (!result.actions[0]) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  return result.actions[0];
}

async function discover(actor: ModuleActor, request: { limit: number; after?: string; installation_id?: string; runtime_binding_id?: string }) {
  return experienceExposureDatabase().transaction(async tx => {
    const authorizer = new PostgresAppRunLiveAuthorization(() => false);
    let ownerId = actor.actor_id;
    if (actor.kind === 'agent_employee') {
      const [employee] = await tx.select({ owner: agentEmployees.user_id }).from(agentEmployees).where(and(
        eq(agentEmployees.org_id, actor.org_id), eq(agentEmployees.id, actor.actor_id),
        eq(agentEmployees.is_active, true), eq(agentEmployees.is_deleted, false), eq(agentEmployees.unhealthy, false))).limit(1);
      if (!employee) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      ownerId = employee.owner;
    }
    const locators = await tx.select({ id: appRuntimeBindings.id }).from(appRuntimeBindings)
      .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
      .where(and(eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.state, 'active'),
        eq(appRuntimeRegistrations.operator_user_id, ownerId),
        request.after ? gt(appRuntimeBindings.id, request.after) : undefined,
        request.installation_id ? eq(appRuntimeBindings.app_installation_id, request.installation_id) : undefined,
        request.runtime_binding_id ? eq(appRuntimeBindings.id, request.runtime_binding_id) : undefined))
      .orderBy(asc(appRuntimeBindings.id)).limit(request.limit + 1);
    const actions = [];
    for (const locator of locators.slice(0, request.limit)) {
      let capture;
      try {
        capture = actor.kind === 'agent_employee'
          ? await authorizer.captureReviewedRuntimeAgentInTransaction(tx, { org_id: actor.org_id, agent_employee_id: actor.actor_id, runtime_binding_id: locator.id })
          : await authorizer.captureReviewedRuntimeInTransaction(tx, { org_id: actor.org_id, user_id: actor.actor_id, runtime_binding_id: locator.id });
        if (capture.operator_user_id !== ownerId || (actor.kind === 'agent_employee'
          && 'agent_owner_user_id' in capture && capture.agent_owner_user_id !== ownerId)) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      } catch (error) {
        if ((error instanceof AppRunError && ['APP_RUN_ACCESS_DENIED', 'APP_RUN_AUTHORIZATION_STALE'].includes(error.code))
          || (error instanceof AppError && ['APP_STALE', 'APP_ACCESS_DENIED'].includes(error.code))
          || (error instanceof Error && error.message === 'APP_RUN_AUTHORIZATION_STALE')) continue;
        throw error;
      }
      const [version] = await tx.select({ manifest: appVersions.manifest }).from(appVersions).where(and(eq(appVersions.org_id, actor.org_id), eq(appVersions.id, capture.binding.app_version_id))).limit(1);
      const label = z.object({ name: z.string().max(256), runtime_actions: z.array(z.object({ key: z.string(), label: z.string().max(256) })) }).safeParse(version?.manifest);
      const [policy] = await tx.select({ mode: appRuntimeAgentPolicies.mode }).from(appRuntimeAgentPolicies).where(and(
        eq(appRuntimeAgentPolicies.org_id, actor.org_id), eq(appRuntimeAgentPolicies.owner_user_id, capture.operator_user_id), eq(appRuntimeAgentPolicies.runtime_binding_id, locator.id))).limit(1).for('share');
      actions.push({ runtime_binding_id: locator.id, installation_id: capture.binding.app_installation_id,
        app_label: label.success ? label.data.name : capture.binding.app_installation_id,
        action_key: capture.action.action_key, label: label.success ? label.data.runtime_actions.find(a => a.key === capture.action.action_key)?.label ?? capture.action.action_key : capture.action.action_key,
        input_schema: capture.action.input_schema, setup_state: 'available' as const,
        agent_policy: policy?.mode ?? 'deny', review_requirement: 'always' as const, untrusted_metadata: true as const });
    }
    const hasMore = locators.length > request.limit;
    const result = { actions, has_more: hasMore, next_cursor: hasMore ? locators[request.limit - 1]!.id : null, authority: 'discovery_only' as const };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) throw new AppRunError('APP_RUN_OUTPUT_TOO_LARGE');
    assertActor(actor);
    return result;
  });
}
