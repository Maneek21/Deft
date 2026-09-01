import { randomUUID } from 'node:crypto';
import { AppDigestSchema } from '@deft/app-kit';
import { appAutomationFires, appRuns, moduleRecords } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appActionService, type AppActionResourceEvidence } from './app-action-service.js';
import { AppBindingInvokeInputSchema } from './app-action-operations.js';
import {
  AppAutomationDefinitionReviewInputSchema,
  createReviewedAppAutomationDefinition,
  getAppAutomationDefinition,
  listAppAutomationDefinitions,
  pauseAppAutomationDefinition,
  prepareAppAutomationDefinitionReview,
  resumeAppAutomationDefinition,
} from './app-automation-definition-service.js';
import type { AppAutomationDefinitionRow } from './app-automation-repository.js';
import { nextEligibleAppAutomationOccurrence } from './app-automation-schedule.js';
import { db } from './db.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import { AppError } from './app-errors.js';
import { digestAppGrantValue } from './app-grant-service.js';

const KeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((value) => !/^(deft|core|system)(_|$)/.test(value));
const AutomationActionInputSchema = AppBindingInvokeInputSchema.omit({
  idempotency_key: true,
  user_inputs: true,
}).extend({
  automation_request_key: KeySchema,
  local_time: AppAutomationDefinitionReviewInputSchema.shape.local_time,
  timezone: AppAutomationDefinitionReviewInputSchema.shape.timezone,
  validity_seconds: AppAutomationDefinitionReviewInputSchema.shape.validity_seconds,
  max_org_runs_per_utc_day:
    AppAutomationDefinitionReviewInputSchema.shape.max_org_runs_per_utc_day,
  max_pending_org_fires: AppAutomationDefinitionReviewInputSchema.shape.max_pending_org_fires,
});

export const AppAutomationReviewRequestSchema = AutomationActionInputSchema;
export const AppAutomationCreateRequestSchema = AutomationActionInputSchema.extend({
  expected_review_digest: AppDigestSchema,
  accept_code_owned_policy: z.literal(true),
});

function unavailable(message: string): never {
  throw new AppError(message, 'APP_STALE', 409);
}

function interactiveAutomationActionActor(
  actor: ModuleActor,
): Extract<ModuleActor, { kind: 'human' }> {
  if (
    actor.kind !== 'human'
    || (actor.role !== 'owner' && actor.role !== 'admin')
    || (actor.source !== 'ui' && actor.source !== 'rest')
  ) {
    throw new AppError(
      'Only interactive workspace owners and admins can manage App automations',
      'APP_ACCESS_DENIED',
      403,
    );
  }
  // The /api/apps management adapter authenticates an interactive browser
  // through its REST route. App Action prepared authority records the caller
  // surface, not the transport, so keep the original actor for approval/audit
  // and use the established human:ui surface only for effect-free preparation.
  return Object.freeze({ ...actor, source: 'ui' });
}

function refIdentity(ref: AppActionResourceEvidence['ref']): string {
  return `${ref.provider.provider_instance_id}\0${ref.resource_type}\0${ref.resource_id}`;
}

async function pinEvidence(
  actor: ModuleActor,
  evidence: AppActionResourceEvidence,
) {
  const [record] = await db.select({
    revision: moduleRecords.revision,
    data: moduleRecords.data,
  }).from(moduleRecords).where(and(
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, evidence.ref.provider.provider_instance_id),
    eq(moduleRecords.collection_key, evidence.ref.resource_type),
    eq(moduleRecords.id, evidence.ref.resource_id),
    eq(moduleRecords.is_deleted, false),
  )).limit(1);
  if (!record || record.revision !== evidence.revision) {
    return unavailable('Automation resource changed while preparing its review');
  }
  return {
    resource_ref: evidence.ref,
    revision: String(record.revision),
    content_digest: digestAppGrantValue(record.data),
  };
}

async function resolveReviewInput(
  actor: ModuleActor,
  appInstallationId: string,
  rawInput: z.input<typeof AppAutomationReviewRequestSchema>,
) {
  const input = AppAutomationReviewRequestSchema.parse(rawInput);
  if (input.selections.length !== 1) {
    throw new AppError(
      'Scheduled App actions require exactly one selected related resource',
      'APP_ACTION_INVALID',
      400,
    );
  }
  const prepared = await appActionService.prepare({
    actor: interactiveAutomationActionActor(actor),
  }, {
    binding_id: input.binding_id,
    resource_ref: input.resource_ref,
    selections: input.selections,
    user_inputs: {},
    idempotency_key: `automation-review:${randomUUID()}`,
  });
  if (prepared.action.installation_id !== appInstallationId) {
    throw new AppError('App action does not belong to this installation', 'APP_NOT_FOUND', 404);
  }
  const placementIdentity = refIdentity(input.resource_ref);
  const selectedIdentity = refIdentity(input.selections[0]!.resource_ref);
  const placementEvidence = prepared.authority_vector.resources.find(
    (item) => refIdentity(item.ref) === placementIdentity,
  );
  const selectedEvidence = prepared.authority_vector.resources.find(
    (item) => refIdentity(item.ref) === selectedIdentity,
  );
  if (!placementEvidence || !selectedEvidence || prepared.authority_vector.resources.length !== 2) {
    return unavailable('Prepared automation resources do not match the exact bounded action');
  }
  const [placement, selected] = await Promise.all([
    pinEvidence(actor, placementEvidence),
    pinEvidence(actor, selectedEvidence),
  ]);
  return {
    app_installation_id: prepared.action.installation_id,
    app_version_id: prepared.action.app_version_id,
    action_binding_id: prepared.action.binding_id,
    automation_request_key: input.automation_request_key,
    placement,
    selected,
    local_time: input.local_time,
    timezone: input.timezone,
    validity_seconds: input.validity_seconds,
    max_org_runs_per_utc_day: input.max_org_runs_per_utc_day,
    max_pending_org_fires: input.max_pending_org_fires,
  };
}

export async function prepareManagedAppAutomationReview(
  actor: ModuleActor,
  appInstallationId: string,
  input: z.input<typeof AppAutomationReviewRequestSchema>,
) {
  return prepareAppAutomationDefinitionReview(
    actor,
    await resolveReviewInput(actor, appInstallationId, input),
  );
}

export async function createManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  rawInput: z.input<typeof AppAutomationCreateRequestSchema>,
) {
  const input = AppAutomationCreateRequestSchema.parse(rawInput);
  const reviewInput = await resolveReviewInput(actor, appInstallationId, input);
  return createReviewedAppAutomationDefinition(actor, {
    ...reviewInput,
    expected_review_digest: input.expected_review_digest as `sha256:${string}`,
    accept_code_owned_policy: input.accept_code_owned_policy,
  });
}

function projectDefinition(definition: AppAutomationDefinitionRow) {
  return {
    id: definition.id,
    app_installation_id: definition.app_installation_id,
    app_version_id: definition.app_version_id,
    action_key: definition.action_key,
    automation_request_key: definition.automation_request_key,
    state: definition.state,
    definition_epoch: definition.definition_epoch,
    schedule: {
      kind: definition.schedule_kind,
      local_time: definition.local_time,
      timezone: definition.timezone,
      misfire_policy: definition.misfire_policy,
      catch_up_window_minutes: definition.catch_up_window_minutes,
    },
    validity: {
      valid_from: definition.valid_from.toISOString(),
      valid_until: definition.valid_until.toISOString(),
    },
    budgets: {
      max_actions_per_fire: definition.max_actions_per_fire,
      max_org_runs_per_utc_day: definition.max_org_runs_per_utc_day,
      max_pending_org_fires: definition.max_pending_org_fires,
    },
    approved_at: definition.approved_at.toISOString(),
    state_changed_at: definition.state_changed_at.toISOString(),
  };
}

export async function listManagedAppAutomations(
  actor: ModuleActor,
  appInstallationId: string,
  now = new Date(),
) {
  const definitions = await listAppAutomationDefinitions(actor, {
    app_installation_id: appInstallationId,
    limit: 50,
  });
  const definitionIds = definitions.map((definition) => definition.id);
  const latestFires = new Map<string, typeof appAutomationFires.$inferSelect>();
  const fireCounts = new Map<string, Record<string, number>>();
  const runs = new Map<string, Pick<typeof appRuns.$inferSelect, 'id' | 'state' | 'updated_at' | 'terminal_at'>>();

  if (definitionIds.length > 0) {
    for (const definitionId of definitionIds) {
      const [latest] = await db.select().from(appAutomationFires).where(and(
        eq(appAutomationFires.org_id, actor.org_id),
        eq(appAutomationFires.definition_id, definitionId),
      )).orderBy(desc(appAutomationFires.created_at), desc(appAutomationFires.id)).limit(1);
      if (latest) latestFires.set(definitionId, latest);
    }
    const counts = await db.select({
      definition_id: appAutomationFires.definition_id,
      state: appAutomationFires.state,
      value: count(appAutomationFires.id),
    }).from(appAutomationFires).where(and(
      eq(appAutomationFires.org_id, actor.org_id),
      inArray(appAutomationFires.definition_id, definitionIds),
    )).groupBy(appAutomationFires.definition_id, appAutomationFires.state);
    for (const item of counts) {
      const current = fireCounts.get(item.definition_id) ?? {};
      current[item.state] = Number(item.value);
      fireCounts.set(item.definition_id, current);
    }
    const runIds = [...latestFires.values()].flatMap((fire) => fire.app_run_id ? [fire.app_run_id] : []);
    if (runIds.length > 0) {
      const rows = await db.select({
        id: appRuns.id,
        state: appRuns.state,
        updated_at: appRuns.updated_at,
        terminal_at: appRuns.terminal_at,
      }).from(appRuns).where(and(
        eq(appRuns.org_id, actor.org_id),
        inArray(appRuns.id, runIds),
      ));
      for (const run of rows) runs.set(run.id, run);
    }
  }

  return {
    schema: 'deft.app_automation_management.v1' as const,
    generated_at: now.toISOString(),
    kill_switch: {
      enabled: APP_AUTOMATIONS_ENABLED,
      status: APP_AUTOMATIONS_ENABLED ? 'enabled' as const : 'disabled' as const,
    },
    definitions: definitions.map((definition) => {
      const latest = latestFires.get(definition.id) ?? null;
      const run = latest?.app_run_id ? runs.get(latest.app_run_id) ?? null : null;
      const counts = fireCounts.get(definition.id) ?? {};
      const eligibleAfter = definition.state_changed_at > definition.valid_from
        ? definition.state_changed_at
        : definition.valid_from;
      const next = definition.state === 'active' && APP_AUTOMATIONS_ENABLED
        ? nextEligibleAppAutomationOccurrence({
          local_time: definition.local_time,
          timezone: definition.timezone,
          now,
          eligible_after: eligibleAfter,
          eligible_before: definition.valid_until,
        })
        : null;
      return {
        ...projectDefinition(definition),
        next_fire_at_utc: next?.resolution.kind === 'resolved'
          ? next.resolution.resolved_at_utc.toISOString()
          : null,
        fire_summary: {
          pending: counts.pending ?? 0,
          claimed: counts.claimed ?? 0,
          run_created: counts.run_created ?? 0,
          skipped: counts.skipped ?? 0,
          dead_letter: counts.dead_letter ?? 0,
        },
        latest_fire: latest ? {
          id: latest.id,
          logical_local_date: latest.logical_local_date,
          resolved_at_utc: latest.resolved_at_utc?.toISOString() ?? null,
          state: latest.state,
          attempt_count: latest.attempt_count,
          terminal_reason: latest.terminal_reason,
          terminal_at: latest.terminal_at?.toISOString() ?? null,
        } : null,
        latest_run: run ? {
          id: run.id,
          state: run.state,
          updated_at: run.updated_at.toISOString(),
          terminal_at: run.terminal_at?.toISOString() ?? null,
        } : null,
        retry: {
          eligible: false,
          reason: latest?.state === 'dead_letter'
            ? 'Create a freshly reviewed definition; silent dead-letter replay is forbidden.'
            : 'No dead-lettered fire requires review.',
        },
      };
    }),
  };
}

async function exactManagedDefinition(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
) {
  const definition = await getAppAutomationDefinition(actor, definitionId);
  if (definition.app_installation_id !== appInstallationId) {
    throw new AppError('App automation definition not found', 'APP_NOT_FOUND', 404);
  }
  return definition;
}

export async function pauseManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
  expectedEpoch: number,
) {
  await exactManagedDefinition(actor, appInstallationId, definitionId);
  return pauseAppAutomationDefinition(actor, { definition_id: definitionId, expected_epoch: expectedEpoch });
}

export async function resumeManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
  expectedEpoch: number,
) {
  await exactManagedDefinition(actor, appInstallationId, definitionId);
  return resumeAppAutomationDefinition(actor, { definition_id: definitionId, expected_epoch: expectedEpoch });
}

export const projectManagedAppAutomationDefinition = projectDefinition;
