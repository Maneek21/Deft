import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { resourceRefPayload, type ResourceProjection, type ResourceRef } from '@/lib/modules';

export const APP_RUN_TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'expired'] as const;
export type AppRunState =
  | 'pending'
  | 'pending_approval'
  | 'running'
  | 'waiting_external'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unknown_outcome';

export type AppActionItem = {
  bindingId: string;
  installationId: string;
  appId: string;
  appVersionId: string;
  actionKey: string;
  label: string;
  automationRequests: Array<{ key: string; label: string }>;
};

export type AppActionInput =
  | { inputKey: string; kind: 'resource_field' }
  | {
      inputKey: string;
      kind: 'selected_relation_field';
      relationKey: string;
      relationRevision: number;
      options: ResourceProjection[];
    }
  | {
      inputKey: string;
      kind: 'user_input';
      inputType: 'email' | 'text';
      label: string;
      required: true;
    };

export type AppActionListResult = { resource: ResourceProjection; actions: AppActionItem[] };
export type AppActionResolveResult = { action: AppActionItem; resource: ResourceProjection; inputs: AppActionInput[] };

export type AppRunSafePreview = {
  title: string;
  summary: string | null;
  resourceLabels: string[];
  fields: Record<string, JsonValue>;
};

export type AppActionPrepared = {
  action: AppActionItem;
  safePreview: AppRunSafePreview;
  inputCandidate: Record<string, unknown>;
  replayIdentity: string;
};

export type AppRunView = {
  id: string;
  state: AppRunState;
  safePreview: AppRunSafePreview;
  safeOutcome: {
    success: boolean;
    providerCallAttempted: boolean;
    resultStatus: 'retained' | 'expired' | 'unavailable';
    summary: string | null;
    errorCode: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AppActionExecutionInput = {
  binding_id: string;
  resource_ref: Record<string, unknown>;
  selections: Array<{ input_key: string; resource_ref: Record<string, unknown> }>;
  user_inputs: Record<string, string>;
  idempotency_key: string;
};

type UnknownRecord = Record<string, unknown>;
const RUN_STATES = new Set<AppRunState>([
  'pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome',
]);
const FORBIDDEN_SAFE_KEYS = new Set([
  'input', 'output', 'raw_input', 'raw_output', 'params', 'idempotency_key', 'retry_key', 'ciphertext', 'ciphertext_b64',
  'nonce_b64', 'auth_tag_b64', 'credential', 'credentials', 'secret', 'password', 'access_token', 'refresh_token',
  'api_key', 'private_key', 'signature_hmac',
]);

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

function normalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw new Error('App result is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1));
  const row = object(value, 'App JSON value');
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, normalizeJson(item, depth + 1)]));
}

function normalizeSafeFields(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return {};
  const row = object(value, 'App safe preview fields');
  assertSafeKeys(row);
  const normalized = normalizeJson(row);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') throw new Error('Invalid App preview fields.');
  return normalized;
}

function assertSafeKeys(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error('App preview is too deeply nested.');
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeKeys(item, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as UnknownRecord)) {
    if (FORBIDDEN_SAFE_KEYS.has(key.toLowerCase())) throw new Error('Unsafe App preview metadata.');
    assertSafeKeys(item, depth + 1);
  }
}

function normalizeResourceRef(value: unknown): ResourceRef {
  const row = object(value, 'App resource reference');
  const provider = object(row.provider, 'App resource provider');
  if (row.schema_version !== 'deft.resource_ref.v1') throw new Error('Unsupported App resource reference.');
  if (provider.kind !== 'module' && provider.kind !== 'core') throw new Error('Invalid App resource provider.');
  return {
    schemaVersion: 'deft.resource_ref.v1',
    providerKind: provider.kind,
    providerInstanceId: stringValue(provider.provider_instance_id, 'App resource provider identity'),
    resourceType: stringValue(row.resource_type, 'App resource type'),
    resourceId: stringValue(row.resource_id, 'App resource identity'),
  };
}

function normalizeResource(value: unknown): ResourceProjection {
  const row = object(value, 'App resource');
  if (row.schema_version !== 'deft.resource_safe_projection.v1') throw new Error('Unsupported App resource projection.');
  const href = row.href;
  if (href !== undefined && (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//'))) throw new Error('Invalid App resource link.');
  return {
    ref: normalizeResourceRef(row.ref),
    label: stringValue(row.label, 'App resource label'),
    href: typeof href === 'string' ? href : null,
    revision: typeof row.revision === 'string' ? row.revision : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

function normalizeAction(value: unknown): AppActionItem {
  const row = object(value, 'App action');
  const automationRequests = Array.isArray(row.automation_requests)
    ? row.automation_requests.map((entry) => {
      const request = object(entry, 'App automation request');
      return {
        key: stringValue(request.key, 'App automation request key'),
        label: stringValue(request.label, 'App automation request label'),
      };
    })
    : [];
  return {
    bindingId: stringValue(row.binding_id, 'App action binding'),
    installationId: stringValue(row.installation_id, 'App installation'),
    appId: stringValue(row.app_id, 'App identity'),
    appVersionId: stringValue(row.app_version_id, 'App version'),
    actionKey: stringValue(row.action_key, 'App action key'),
    label: stringValue(row.label, 'App action label'),
    automationRequests,
  };
}

function normalizePreview(value: unknown): AppRunSafePreview {
  const row = object(value, 'App action preview');
  if (row.schema_version !== 'deft.app_run.v1') throw new Error('Unsupported App Run preview.');
  const refs = Array.isArray(row.resource_refs) ? row.resource_refs : [];
  return {
    title: stringValue(row.title, 'App action preview title'),
    summary: typeof row.summary === 'string' ? row.summary : null,
    resourceLabels: refs.flatMap((entry) => {
      const ref = object(entry, 'App action preview resource');
      return typeof ref.label === 'string' && ref.label.trim() ? [ref.label] : [];
    }),
    fields: normalizeSafeFields(row.fields),
  };
}

export function normalizeAppActionList(value: unknown): AppActionListResult {
  const body = object(value, 'App action list response');
  const row = object(body.result ?? value, 'App action list');
  if (!Array.isArray(row.actions)) throw new Error('Invalid App actions.');
  return { resource: normalizeResource(row.resource), actions: row.actions.map(normalizeAction) };
}

export function normalizeAppActionResolve(value: unknown): AppActionResolveResult {
  const body = object(value, 'App action resolve response');
  const row = object(body.result ?? value, 'App action resolution');
  if (!Array.isArray(row.inputs)) throw new Error('Invalid App action inputs.');
  const inputs = row.inputs.map((entry): AppActionInput => {
    const input = object(entry, 'App action input');
    const inputKey = stringValue(input.input_key, 'App action input key');
    if (input.kind === 'resource_field') return { inputKey, kind: 'resource_field' };
    if (input.kind === 'selected_relation_field') {
      if (!Array.isArray(input.options)) throw new Error('Invalid App relation choices.');
      return {
        inputKey,
        kind: 'selected_relation_field',
        relationKey: stringValue(input.relation_key, 'App relation key'),
        relationRevision: integer(input.relation_revision, 'App relation revision'),
        options: input.options.map(normalizeResource),
      };
    }
    if (input.kind === 'user_input' && (input.input_type === 'email' || input.input_type === 'text') && input.required === true) {
      return { inputKey, kind: 'user_input', inputType: input.input_type, label: stringValue(input.label, 'App input label'), required: true };
    }
    throw new Error('Unsupported App action input.');
  });
  return { action: normalizeAction(row.action), resource: normalizeResource(row.resource), inputs };
}

export function normalizeAppActionPrepare(value: unknown): AppActionPrepared {
  const body = object(value, 'App action preparation response');
  const row = object(body.result ?? value, 'App action preparation');
  return {
    action: normalizeAction(row.action),
    safePreview: normalizePreview(row.safe_preview),
    inputCandidate: object(row.input_candidate, 'sealed App action candidate'),
    replayIdentity: stringValue(row.replay_identity, 'App action replay identity'),
  };
}

export function normalizeAppRun(value: unknown): AppRunView {
  const body = object(value, 'App Run response');
  const row = object(body.run ?? value, 'App Run');
  if (typeof row.state !== 'string' || !RUN_STATES.has(row.state as AppRunState)) throw new Error('Invalid App Run state.');
  const outcome = row.safe_outcome === null || row.safe_outcome === undefined ? null : object(row.safe_outcome, 'App Run outcome');
  if (outcome && (outcome.result_status !== 'retained' && outcome.result_status !== 'expired' && outcome.result_status !== 'unavailable')) throw new Error('Invalid App Run result status.');
  return {
    id: stringValue(row.id, 'App Run identity'),
    state: row.state as AppRunState,
    safePreview: normalizePreview(row.safe_preview),
    safeOutcome: outcome ? {
      success: outcome.success === true,
      providerCallAttempted: outcome.provider_call_attempted === true,
      resultStatus: outcome.result_status as 'retained' | 'expired' | 'unavailable',
      summary: typeof outcome.summary === 'string' ? outcome.summary : null,
      errorCode: typeof outcome.error_code === 'string' ? outcome.error_code : null,
    } : null,
    createdAt: stringValue(row.created_at, 'App Run created time'),
    updatedAt: stringValue(row.updated_at, 'App Run updated time'),
    terminalAt: typeof row.terminal_at === 'string' ? row.terminal_at : null,
  };
}

export function normalizeAppRunResult(value: unknown): { run: AppRunView; value: JsonValue } {
  const body = object(value, 'App Run result response');
  return { run: normalizeAppRun(body.run), value: normalizeJson(body.value) };
}

async function post(path: string, body: unknown, fallback: string): Promise<unknown> {
  const response = await api.post(path, body);
  if (!response.ok) throw new Error(await appApiError(response, fallback));
  return response.json();
}

export async function listAppActions(resourceRef: ResourceRef): Promise<AppActionListResult> {
  return normalizeAppActionList(await post('/api/app-actions/list', { resource_ref: resourceRefPayload(resourceRef) }, 'Unable to discover App actions.'));
}

export async function resolveAppAction(bindingId: string, resourceRef: ResourceRef): Promise<AppActionResolveResult> {
  return normalizeAppActionResolve(await post('/api/app-actions/resolve', {
    binding_id: bindingId,
    resource_ref: resourceRefPayload(resourceRef),
  }, 'Unable to resolve this App action.'));
}

export async function prepareAppAction(input: AppActionExecutionInput): Promise<AppActionPrepared> {
  return normalizeAppActionPrepare(await post('/api/app-actions/prepare', input, 'Unable to prepare this App action.'));
}

export async function invokeAppAction(input: AppActionExecutionInput, inputCandidate: Record<string, unknown>): Promise<AppRunView> {
  return normalizeAppRun(await post('/api/app-actions/invoke', { ...input, input_candidate: inputCandidate }, 'Unable to start this App action.'));
}

export async function inspectAppRun(runId: string): Promise<AppRunView> {
  const response = await api.get(`/api/app-runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(await appApiError(response, 'Unable to inspect this App Run.'));
  return normalizeAppRun(await response.json());
}

export async function getAppRunResult(runId: string): Promise<{ run: AppRunView; value: JsonValue }> {
  const response = await api.get(`/api/app-runs/${encodeURIComponent(runId)}/result`);
  if (!response.ok) throw new Error(await appApiError(response, 'The App Run result is unavailable.'));
  return normalizeAppRunResult(await response.json());
}

export function isTerminalAppRun(state: AppRunState): boolean {
  return (APP_RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

export function createAppActionIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `app-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
