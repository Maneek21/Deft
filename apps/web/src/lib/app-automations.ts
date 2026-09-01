import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { resourceRefPayload, type ResourceRef } from '@/lib/modules';

type UnknownRecord = Record<string, unknown>;

export type AppAutomationScheduleInput = {
  bindingId: string;
  automationRequestKey: string;
  placement: ResourceRef;
  selection: { inputKey: string; resourceRef: ResourceRef };
  localTime: string;
  timezone: string;
  validitySeconds: number;
  maxOrgRunsPerUtcDay: number;
  maxPendingOrgFires: number;
};

export type AppAutomationReview = {
  reviewDigest: string;
  placement: AppAutomationResourcePin;
  selected: AppAutomationResourcePin;
  schedule: { localTime: string; timezone: string; catchUpWindowMinutes: number };
  validitySeconds: number;
  budgets: { maxOrgRunsPerUtcDay: number; maxPendingOrgFires: number };
  policyVersion: string;
};

export type AppAutomationResourcePin = {
  resourceRef: ResourceRef;
  revision: string;
  contentDigest: string;
};

export type AppAutomationDefinition = {
  id: string;
  actionKey: string;
  automationRequestKey: string;
  state: 'active' | 'paused' | 'revoked' | 'expired';
  definitionEpoch: number;
  schedule: { localTime: string; timezone: string; catchUpWindowMinutes: number };
  validity: { validFrom: string; validUntil: string };
  budgets: { maxOrgRunsPerUtcDay: number; maxPendingOrgFires: number };
  nextFireAtUtc: string | null;
  fireSummary: { pending: number; claimed: number; runCreated: number; skipped: number; deadLetter: number };
  latestFire: null | {
    id: string;
    logicalLocalDate: string;
    resolvedAtUtc: string | null;
    state: string;
    attemptCount: number;
    terminalReason: string | null;
  };
  latestRun: null | { id: string; state: string; updatedAt: string; terminalAt: string | null };
  retry: { eligible: boolean; reason: string };
};

export type AppAutomationManagement = {
  generatedAt: string;
  killSwitchEnabled: boolean;
  definitions: AppAutomationDefinition[];
};

function object(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, label);
}

function normalizeResourceRef(value: unknown): ResourceRef {
  const row = object(value, 'App automation resource reference');
  const provider = object(row.provider, 'App automation resource provider');
  if (row.schema_version !== 'deft.resource_ref.v1') throw new Error('Unsupported App automation resource reference.');
  if (provider.kind !== 'module' && provider.kind !== 'core') throw new Error('Invalid App automation resource provider.');
  return {
    schemaVersion: 'deft.resource_ref.v1',
    providerKind: provider.kind,
    providerInstanceId: stringValue(provider.provider_instance_id, 'App automation resource provider identity'),
    resourceType: stringValue(row.resource_type, 'App automation resource type'),
    resourceId: stringValue(row.resource_id, 'App automation resource identity'),
  };
}

function normalizeResourcePin(value: unknown, label: string): AppAutomationResourcePin {
  const pin = object(value, label);
  return {
    resourceRef: normalizeResourceRef(pin.resource_ref),
    revision: stringValue(pin.revision, `${label} revision`),
    contentDigest: stringValue(pin.content_digest, `${label} content digest`),
  };
}

function requestBody(input: AppAutomationScheduleInput) {
  return {
    binding_id: input.bindingId,
    automation_request_key: input.automationRequestKey,
    resource_ref: resourceRefPayload(input.placement),
    selections: [{
      input_key: input.selection.inputKey,
      resource_ref: resourceRefPayload(input.selection.resourceRef),
    }],
    local_time: input.localTime,
    timezone: input.timezone,
    validity_seconds: input.validitySeconds,
    max_org_runs_per_utc_day: input.maxOrgRunsPerUtcDay,
    max_pending_org_fires: input.maxPendingOrgFires,
  };
}

export function normalizeAppAutomationReview(value: unknown): AppAutomationReview {
  const body = object(value, 'App automation review response');
  const review = object(body.review ?? value, 'App automation review');
  const schedule = object(review.schedule, 'App automation schedule');
  const budgets = object(review.budgets, 'App automation budgets');
  return {
    reviewDigest: stringValue(review.review_digest, 'App automation review digest'),
    placement: normalizeResourcePin(review.placement, 'App automation placement'),
    selected: normalizeResourcePin(review.selected, 'App automation selection'),
    schedule: {
      localTime: stringValue(schedule.local_time, 'App automation local time'),
      timezone: stringValue(schedule.timezone, 'App automation timezone'),
      catchUpWindowMinutes: integer(schedule.catch_up_window_minutes, 'App automation catch-up window'),
    },
    validitySeconds: integer(review.validity_seconds, 'App automation validity'),
    budgets: {
      maxOrgRunsPerUtcDay: integer(budgets.max_org_runs_per_utc_day, 'App automation daily budget'),
      maxPendingOrgFires: integer(budgets.max_pending_org_fires, 'App automation pending budget'),
    },
    policyVersion: stringValue(review.policy_version, 'App automation policy'),
  };
}

export function normalizeAppAutomationManagement(value: unknown): AppAutomationManagement {
  const body = object(value, 'App automation response');
  const management = object(body.automations ?? value, 'App automation management');
  const killSwitch = object(management.kill_switch, 'App automation kill switch');
  if (!Array.isArray(management.definitions)) throw new Error('Invalid App automation definitions.');
  return {
    generatedAt: stringValue(management.generated_at, 'App automation generated time'),
    killSwitchEnabled: killSwitch.enabled === true,
    definitions: management.definitions.map((entry) => {
      const row = object(entry, 'App automation definition');
      const state = row.state;
      if (state !== 'active' && state !== 'paused' && state !== 'revoked' && state !== 'expired') {
        throw new Error('Invalid App automation state.');
      }
      const schedule = object(row.schedule, 'App automation schedule');
      const validity = object(row.validity, 'App automation validity');
      const budgets = object(row.budgets, 'App automation budgets');
      const summary = object(row.fire_summary, 'App automation fire summary');
      const retry = object(row.retry, 'App automation retry state');
      const fire = row.latest_fire == null ? null : object(row.latest_fire, 'latest App automation fire');
      const run = row.latest_run == null ? null : object(row.latest_run, 'latest App automation Run');
      return {
        id: stringValue(row.id, 'App automation identity'),
        actionKey: stringValue(row.action_key, 'App automation action'),
        automationRequestKey: stringValue(row.automation_request_key, 'App automation request'),
        state,
        definitionEpoch: integer(row.definition_epoch, 'App automation epoch'),
        schedule: {
          localTime: stringValue(schedule.local_time, 'App automation local time'),
          timezone: stringValue(schedule.timezone, 'App automation timezone'),
          catchUpWindowMinutes: integer(schedule.catch_up_window_minutes, 'App automation catch-up window'),
        },
        validity: {
          validFrom: stringValue(validity.valid_from, 'App automation start'),
          validUntil: stringValue(validity.valid_until, 'App automation expiry'),
        },
        budgets: {
          maxOrgRunsPerUtcDay: integer(budgets.max_org_runs_per_utc_day, 'App automation daily budget'),
          maxPendingOrgFires: integer(budgets.max_pending_org_fires, 'App automation pending budget'),
        },
        nextFireAtUtc: nullableString(row.next_fire_at_utc, 'App automation next fire'),
        fireSummary: {
          pending: integer(summary.pending, 'pending fire count'),
          claimed: integer(summary.claimed, 'claimed fire count'),
          runCreated: integer(summary.run_created, 'created Run count'),
          skipped: integer(summary.skipped, 'skipped fire count'),
          deadLetter: integer(summary.dead_letter, 'dead-letter fire count'),
        },
        latestFire: fire ? {
          id: stringValue(fire.id, 'App automation fire identity'),
          logicalLocalDate: stringValue(fire.logical_local_date, 'App automation local date'),
          resolvedAtUtc: nullableString(fire.resolved_at_utc, 'App automation resolved time'),
          state: stringValue(fire.state, 'App automation fire state'),
          attemptCount: integer(fire.attempt_count, 'App automation attempt count'),
          terminalReason: nullableString(fire.terminal_reason, 'App automation terminal reason'),
        } : null,
        latestRun: run ? {
          id: stringValue(run.id, 'App automation Run identity'),
          state: stringValue(run.state, 'App automation Run state'),
          updatedAt: stringValue(run.updated_at, 'App automation Run update time'),
          terminalAt: nullableString(run.terminal_at, 'App automation Run terminal time'),
        } : null,
        retry: {
          eligible: retry.eligible === true,
          reason: stringValue(retry.reason, 'App automation retry reason'),
        },
      };
    }),
  };
}

export async function prepareAppAutomation(
  installationId: string,
  input: AppAutomationScheduleInput,
): Promise<AppAutomationReview> {
  const response = await api.post(`/api/apps/${encodeURIComponent(installationId)}/automations/review`, requestBody(input));
  if (!response.ok) throw new Error(await appApiError(response, 'Unable to review this automation.'));
  return normalizeAppAutomationReview(await response.json());
}

export async function createAppAutomation(
  installationId: string,
  input: AppAutomationScheduleInput,
  reviewDigest: string,
): Promise<void> {
  const response = await api.post(`/api/apps/${encodeURIComponent(installationId)}/automations`, {
    ...requestBody(input),
    expected_review_digest: reviewDigest,
    accept_code_owned_policy: true,
  });
  if (!response.ok) throw new Error(await appApiError(response, 'Unable to create this automation.'));
}

export async function transitionAppAutomation(
  installationId: string,
  definition: Pick<AppAutomationDefinition, 'id' | 'definitionEpoch'>,
  transition: 'pause' | 'resume',
): Promise<void> {
  const response = await api.post(
    `/api/apps/${encodeURIComponent(installationId)}/automations/${encodeURIComponent(definition.id)}/${transition}`,
    { expected_definition_epoch: definition.definitionEpoch },
  );
  if (!response.ok) throw new Error(await appApiError(response, `Unable to ${transition} this automation.`));
}
