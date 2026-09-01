import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunRetainedProviderResultSchema,
  canonicalCapabilityJson,
  type AppRunPolicySnapshot,
} from '@deft/shared';
import { setTimeout as delay } from 'node:timers/promises';
import {
  agentActions,
  mcpToolOverrides,
} from '@deft/db/schema';
import type { MCPTool, MCPToolOverride } from '@deft/mcp';
import { and, eq } from 'drizzle-orm';
import type {
  McpCapabilityInvocationAdapterResult,
  McpCapabilityInvocationRequest,
  McpCapabilityProvider,
} from './capability-providers/mcp.js';
import { mcpCapabilityProvider } from './capability-providers/mcp.js';
import {
  MCP_APP_RUN_RESULT_VERSION,
  type AppRunProviderExecutionResult,
} from './app-run-provider-executor.js';
import type { AppRunRuntime } from './app-run-runtime.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { canonicalMcpToolName } from './mcp-runtime.js';
import { db } from './db.js';
import { persistCapabilityProviderSnapshot } from './capability-provider-snapshot-repository.js';

export type GovernedCapabilityInvocationOptions = Readonly<{
  /** Trusted host evidence, never parsed from provider or model input. */
  legacy_action_id?: string;
  /** Stable host occurrence identity for compatibility retries. */
  idempotency_key?: string;
}>;

type ApprovalTier = MCPTool['approvalTier'];

const APPROVAL_TIER_RANK: Record<ApprovalTier, number> = {
  'auto-execute': 0,
  'quick-approve': 1,
  'full-review': 2,
};

function mappedTier(value: 'auto' | 'quick' | 'full'): ApprovalTier {
  return value === 'auto'
    ? 'auto-execute'
    : value === 'quick'
      ? 'quick-approve'
      : 'full-review';
}

function stricterTier(left: ApprovalTier, right: ApprovalTier): ApprovalTier {
  return APPROVAL_TIER_RANK[left] >= APPROVAL_TIER_RANK[right] ? left : right;
}

function unavailable(
  request: McpCapabilityInvocationRequest,
  error: string,
  errorCode: 'CAPABILITY_PROVIDER_UNAVAILABLE' | 'CAPABILITY_OPERATION_UNAVAILABLE',
): McpCapabilityInvocationAdapterResult {
  return {
    provider: {
      provider_kind: 'mcp',
      requested_provider_key: request.provider.connection_slug,
    },
    operation_name: request.provider.operation_name,
    provider_call_attempted: false,
    provider_succeeded: false,
    legacy_output: { error },
    error,
    error_code: errorCode,
    duration_ms: 0,
  };
}

function providerErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const error = (output as Record<string, unknown>).error;
  return typeof error === 'string' && error ? error : undefined;
}

export class PostgresGovernedCapabilityExecutor {
  constructor(
    private readonly provider: McpCapabilityProvider = mcpCapabilityProvider,
    private readonly runtime: () => Promise<AppRunRuntime> = getAppRunRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async invoke(
    request: McpCapabilityInvocationRequest,
    options: GovernedCapabilityInvocationOptions = {},
  ): Promise<McpCapabilityInvocationAdapterResult> {
    const startedAt = this.now().getTime();
    const resolved = await this.provider.resolveGoverned(request);
    if (!resolved.connection) {
      return unavailable(
        request,
        resolved.error,
        resolved.reason === 'operation_unavailable'
          ? 'CAPABILITY_OPERATION_UNAVAILABLE'
          : 'CAPABILITY_PROVIDER_UNAVAILABLE',
      );
    }
    const connection = resolved.connection;
    const overrideRows = await db.select().from(mcpToolOverrides).where(and(
      eq(mcpToolOverrides.org_id, request.org_id),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
    const operationRows = overrideRows.filter(
      (row) => canonicalMcpToolName(row.tool_name) === request.provider.operation_name,
    );
    const overrides = operationRows.map((row): MCPToolOverride => ({
      toolName: canonicalMcpToolName(row.tool_name),
      approvalTier: row.trust_tier_override ? mappedTier(row.trust_tier_override) : undefined,
      disabled: row.is_disabled,
    }));
    const discovery = await this.provider.discover({
      provider_kind: 'mcp',
      mode: 'cached',
      org_id: request.org_id,
      provider_instance_id: connection.id,
      overrides,
    });
    if (!discovery.snapshot) {
      return unavailable(request, 'MCP capability snapshot is unavailable', 'CAPABILITY_PROVIDER_UNAVAILABLE');
    }
    const tool = discovery.tools.find(
      (candidate) => candidate.originalName === request.provider.operation_name,
    );
    if (!tool || operationRows.some((row) => row.is_disabled)) {
      return unavailable(
        request,
        `MCP tool '${request.provider.operation_name}' is unavailable`,
        'CAPABILITY_OPERATION_UNAVAILABLE',
      );
    }

    const explicitOverride = operationRows
      .map((row) => row.trust_tier_override ? mappedTier(row.trust_tier_override) : null)
      .filter((tier): tier is ApprovalTier => tier !== null)
      .reduce<ApprovalTier | null>(
        (current, tier) => current ? stricterTier(current, tier) : tier,
        null,
      );
    const configuredTier = mappedTier(connection.default_trust_tier);
    const effectiveTier = explicitOverride ?? stricterTier(configuredTier, tool.approvalTier);
    const providerDeclaredSafe = !tool.isWrite && tool.approvalTier === 'auto-execute';
    const policy: AppRunPolicySnapshot = {
      risk_class: providerDeclaredSafe ? 'read' : 'external_write',
      review_requirement: 'policy',
      review_scope: 'per_invocation',
      retry_class: providerDeclaredSafe ? 'safe' : 'unsafe_or_unknown',
    };

    const legacyAction = options.legacy_action_id
      ? await this.#approvedLegacyAction(request, options.legacy_action_id)
      : null;
    if (effectiveTier !== 'auto-execute' || !providerDeclaredSafe) {
      if (!legacyAction) {
        return unavailable(
          request,
          'MCP operation requires approved legacy action evidence',
          'CAPABILITY_OPERATION_UNAVAILABLE',
        );
      }
    } else if (options.legacy_action_id && !legacyAction) {
      return unavailable(
        request,
        'MCP legacy action evidence is invalid',
        'CAPABILITY_OPERATION_UNAVAILABLE',
      );
    }

    const snapshotId = await persistCapabilityProviderSnapshot(discovery.snapshot);
    const runtime = await this.runtime();
    const initiatingActor = { actor_type: 'human' as const, user_id: request.actor.user_id };
    const executionActor = request.actor.agent_employee_id
      ? { actor_type: 'agent_employee' as const, agent_employee_id: request.actor.agent_employee_id }
      : initiatingActor;
    const authorizationSnapshot = await runtime.liveAuthorization.capture({
      org_id: request.org_id,
      authenticated_subject: initiatingActor,
      execution_actor: executionActor,
      provider_instance_id: connection.id,
      provider_snapshot_id: snapshotId,
      operation_name: request.provider.operation_name,
      policy,
    });
    const idempotencyIdentity = options.idempotency_key
      ?? options.legacy_action_id
      ?? crypto.randomUUID();
    const run = await runtime.service.submit({
      org_id: request.org_id,
      initiating_actor: initiatingActor,
      execution_actor: executionActor,
    }, {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: request.org_id,
      initiating_actor: initiatingActor,
      execution_actor: executionActor,
      origin: { origin_kind: 'legacy_connector', connection_id: connection.id },
      operation: {
        provider: {
          org_id: request.org_id,
          provider_kind: 'mcp',
          provider_instance_id: connection.id,
        },
        operation_name: request.provider.operation_name,
      },
      provider_snapshot_digest: discovery.snapshot.snapshot_digest,
      policy,
      retention_class: 'standard',
      idempotency_key: `legacy-capability:${idempotencyIdentity}`,
      input: request.input,
      authorization_snapshot: authorizationSnapshot,
      safe_preview: {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: `${connection.name}: ${request.provider.operation_name}`.slice(0, 200),
        resource_refs: [],
        fields: {
          compatibility_approval_tier: effectiveTier,
          ...(options.legacy_action_id ? { legacy_action_id: options.legacy_action_id } : {}),
        },
      },
    });

    let providerResult: AppRunProviderExecutionResult | undefined;
    const attemptId = await runtime.attemptRunner.prepareAttempt(request.org_id, run.id);
    if (attemptId) {
      const immediate = await runtime.attemptRunner.runImmediate(
        request.org_id,
        run.id,
        attemptId,
        `capability:${crypto.randomUUID()}`,
      );
      providerResult = immediate.provider_result;
    }
    const visibleRun = await runtime.service.requiredRun(request.org_id, run.id);
    await runtime.service.assertAuthorized('result', request.org_id, initiatingActor, visibleRun);
    return this.#result(
      request,
      connection.id,
      connection.name,
      run.id,
      initiatingActor,
      providerResult,
      Math.max(0, this.now().getTime() - startedAt),
      runtime,
    );
  }

  async #approvedLegacyAction(
    request: McpCapabilityInvocationRequest,
    actionId: string,
  ): Promise<typeof agentActions.$inferSelect | null> {
    const [action] = await db.select().from(agentActions).where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, request.org_id),
      eq(agentActions.user_id, request.actor.user_id),
    )).limit(1);
    const expectedAction = `mcp__${request.provider.connection_slug}__${request.provider.operation_name}`;
    if (
      !action
      || action.action !== expectedAction
      || action.approval_status !== 'approved'
      || (action.agent_employee_id ?? undefined) !== request.actor.agent_employee_id
    ) return null;
    try {
      if (canonicalCapabilityJson(action.params) !== canonicalCapabilityJson(request.input)) return null;
    } catch {
      return null;
    }
    return action;
  }

  async #result(
    request: McpCapabilityInvocationRequest,
    providerId: string,
    providerName: string,
    runId: string,
    actor: Readonly<{ actor_type: 'human'; user_id: string }>,
    transient: AppRunProviderExecutionResult | undefined,
    elapsedMs: number,
    runtime: AppRunRuntime,
  ): Promise<McpCapabilityInvocationAdapterResult> {
    if (transient?.status === 'indeterminate') {
      return this.#attemptedError(request, providerId, providerName, {
        error: 'MCP tool outcome is unknown',
      }, 'MCP tool outcome is unknown', elapsedMs);
    }
    if (transient?.status === 'not_attempted') {
      return unavailable(request, 'MCP connection is unavailable', 'CAPABILITY_PROVIDER_UNAVAILABLE');
    }

    let providerSucceeded: boolean;
    let retainedOutput: unknown;
    if (transient?.status === 'returned') {
      providerSucceeded = transient.provider_succeeded;
      retainedOutput = transient.output;
    } else {
      const deadline = Date.now() + 30_000;
      let visible = await runtime.repository.inspect(request.org_id, runId);
      while (
        visible
        && !['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(visible.state)
        && Date.now() < deadline
      ) {
        await delay(20);
        visible = await runtime.repository.inspect(request.org_id, runId);
      }
      if (visible?.state === 'unknown_outcome') {
        return this.#attemptedError(request, providerId, providerName, {
          error: 'MCP tool outcome is unknown',
        }, 'MCP tool outcome is unknown', elapsedMs);
      }
      try {
        const exact = await runtime.service.result(request.org_id, runId, actor, null);
        const retained = AppRunRetainedProviderResultSchema.parse(exact.value);
        providerSucceeded = retained.provider_succeeded;
        retainedOutput = retained.output;
      } catch {
        return unavailable(request, 'MCP result is no longer available', 'CAPABILITY_PROVIDER_UNAVAILABLE');
      }
    }
    if (
      !retainedOutput
      || typeof retainedOutput !== 'object'
      || Array.isArray(retainedOutput)
      || (retainedOutput as Record<string, unknown>).schema_version !== MCP_APP_RUN_RESULT_VERSION
    ) {
      return this.#attemptedError(
        request,
        providerId,
        providerName,
        retainedOutput,
        'MCP tool result is unavailable',
        elapsedMs,
      );
    }
    const envelope = retainedOutput as Record<string, unknown>;
    const legacyOutput = envelope.legacy_output;
    const durationMs = typeof envelope.duration_ms === 'number'
      && Number.isInteger(envelope.duration_ms)
      && envelope.duration_ms >= 0
      ? envelope.duration_ms
      : elapsedMs;
    const error = typeof envelope.error === 'string' && envelope.error
      ? envelope.error
      : providerErrorMessage(legacyOutput) ?? 'MCP tool error';
    if (!providerSucceeded) {
      return this.#attemptedError(
        request,
        providerId,
        providerName,
        legacyOutput,
        error,
        durationMs,
      );
    }
    return {
      provider: {
        provider_kind: 'mcp',
        requested_provider_key: request.provider.connection_slug,
        resolved_provider: {
          org_id: request.org_id,
          provider_kind: 'mcp',
          provider_instance_id: providerId,
        },
      },
      provider_display_name: providerName,
      operation_name: request.provider.operation_name,
      provider_call_attempted: true,
      provider_succeeded: true,
      legacy_output: legacyOutput,
      duration_ms: durationMs,
    };
  }

  #attemptedError(
    request: McpCapabilityInvocationRequest,
    providerId: string,
    providerName: string,
    output: unknown,
    error: string,
    durationMs: number,
  ): McpCapabilityInvocationAdapterResult {
    return {
      provider: {
        provider_kind: 'mcp',
        requested_provider_key: request.provider.connection_slug,
        resolved_provider: {
          org_id: request.org_id,
          provider_kind: 'mcp',
          provider_instance_id: providerId,
        },
      },
      provider_display_name: providerName,
      operation_name: request.provider.operation_name,
      provider_call_attempted: true,
      provider_succeeded: false,
      legacy_output: output,
      error,
      error_code: 'CAPABILITY_PROVIDER_ERROR',
      duration_ms: durationMs,
    };
  }
}

export const postgresGovernedCapabilityExecutor = new PostgresGovernedCapabilityExecutor();
