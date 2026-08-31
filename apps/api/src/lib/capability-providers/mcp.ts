import {
  CAPABILITY_CONTRACT_VERSIONS,
  CAPABILITY_LIMITS,
  assertCapabilityJsonWithinBudget,
  createCapabilityProviderDiscoverySnapshot,
  type CapabilityInvocationErrorCode,
  type CapabilityInvocationProviderRef,
  type CapabilityInvocationRequest,
  type CapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import { mcpConnections } from '@deft/db/schema';
import {
  mcpClientManager,
  type MCPConnectionConfig,
  type MCPResult,
  type MCPToolDiscovery,
  type MCPTool,
  type MCPToolOverride,
} from '@deft/mcp';
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import {
  getExecutableMcpConnection,
  getExecutableMcpConnectionById,
  mcpResultPayload,
  toConnectionConfig,
  type ExecutableMcpConnectionResult,
} from '../mcp-runtime.js';
import {
  mcpSnapshotProviderDescription,
  mcpSnapshotProviderTitle,
  sanitizeMcpSnapshotSchema,
} from '../mcp-snapshot-safety.js';

export type McpCapabilityDiscoveryMode = 'cached' | 'refresh' | 'test';

export interface McpCapabilityDiscoveryRequest {
  provider_kind: 'mcp';
  mode: McpCapabilityDiscoveryMode;
  org_id: string;
  provider_instance_id: string;
  overrides?: MCPToolOverride[];
}

export interface McpCapabilityDiscoveryResult {
  provider_kind: 'mcp';
  /** The exact array returned by the existing MCP manager. */
  tools: MCPTool[];
  /** Observational only in Phase 2; never persisted or used as authority. */
  snapshot: Readonly<CapabilityProviderDiscoverySnapshot> | null;
}

export type McpCapabilityInvocationRequest = CapabilityInvocationRequest & {
  provider: Extract<CapabilityInvocationRequest['provider'], { provider_kind: 'mcp' }>;
};

/** Provider-neutral execution facts plus the untouched compatibility payload.
 * Capability Service derives a strict safe projection without allowing that
 * projection to change or retry the already-attempted legacy call. */
export interface McpCapabilityInvocationAdapterResult {
  provider: CapabilityInvocationProviderRef & { provider_kind: 'mcp' };
  provider_display_name?: string;
  operation_name: string;
  provider_call_attempted: boolean;
  provider_succeeded: boolean;
  legacy_output: unknown;
  error?: string;
  error_code?: CapabilityInvocationErrorCode;
  duration_ms: number;
}

export interface McpDiscoveryClient {
  getCachedToolDiscovery(
    config: ReturnType<typeof toConnectionConfig>,
    overrides?: MCPToolOverride[],
  ): Promise<MCPToolDiscovery>;
  discoverToolDiscovery(
    config: ReturnType<typeof toConnectionConfig>,
    overrides?: MCPToolOverride[],
  ): Promise<MCPToolDiscovery>;
  testToolDiscovery(config: ReturnType<typeof toConnectionConfig>): Promise<MCPToolDiscovery>;
}

export type McpConnectionRow = typeof mcpConnections.$inferSelect;

export interface McpConnectionSource {
  findById(orgId: string, connectionId: string): Promise<McpConnectionRow | null>;
}

export interface McpCapabilityRuntime {
  resolveExecutable(
    orgId: string,
    connectionSlug: string,
    operationName: string,
    agentEmployeeId?: string | null,
  ): Promise<ExecutableMcpConnectionResult>;
  executeTool(
    config: MCPConnectionConfig,
    operationName: string,
    input: Record<string, unknown>,
  ): Promise<MCPResult>;
  resolvePinnedExecutable?(
    orgId: string,
    connectionId: string,
    operationName: string,
    expectedAuthorizationVersion?: number,
  ): Promise<ExecutableMcpConnectionResult>;
}

export type McpPinnedDispatchPin = Readonly<{
  connector_authorization_version: number;
  provider_snapshot_digest: string;
  operation_schema_digest: string;
}>;

export type McpPinnedExecutionResult =
  | Readonly<{ status: 'not_attempted' }>
  | Readonly<{
      status: 'returned';
      provider_succeeded: boolean;
      output: unknown;
      error?: string;
      duration_ms: number;
    }>
  | Readonly<{ status: 'indeterminate' }>;

export interface CapabilitySnapshotWarning {
  code: 'CAPABILITY_SNAPSHOT_UNAVAILABLE';
  provider_kind: 'mcp';
  org_id: string;
  provider_instance_id: string;
}

type SnapshotWarningSink = (warning: CapabilitySnapshotWarning) => void;
type Clock = () => string;

const databaseMcpConnectionSource: McpConnectionSource = {
  async findById(orgId, connectionId) {
    const [connection] = await db
      .select()
      .from(mcpConnections)
      .where(and(
        eq(mcpConnections.org_id, orgId),
        eq(mcpConnections.id, connectionId),
      ))
      .limit(1);
    return connection ?? null;
  },
};

const databaseMcpCapabilityRuntime: McpCapabilityRuntime = {
  resolveExecutable: getExecutableMcpConnection,
  resolvePinnedExecutable: getExecutableMcpConnectionById,
  executeTool: (config, operationName, input) => (
    mcpClientManager.executeTool(config, operationName, input)
  ),
};

function defaultSnapshotWarningSink(warning: CapabilitySnapshotWarning): void {
  console.warn(
    `[capability-service] ${warning.code} for ${warning.provider_kind} provider ${warning.provider_instance_id} in org ${warning.org_id}`,
  );
}

export class McpCapabilityProvider {
  private readonly snapshotCache = new WeakMap<
    MCPToolDiscovery['providerTools'],
    Map<string, Readonly<CapabilityProviderDiscoverySnapshot> | null>
  >();

  constructor(
    private readonly client: McpDiscoveryClient = mcpClientManager,
    private readonly connections: McpConnectionSource = databaseMcpConnectionSource,
    private readonly clock: Clock = () => new Date().toISOString(),
    private readonly warn: SnapshotWarningSink = defaultSnapshotWarningSink,
    private readonly runtime: McpCapabilityRuntime = databaseMcpCapabilityRuntime,
  ) {}

  async discover(request: McpCapabilityDiscoveryRequest): Promise<McpCapabilityDiscoveryResult> {
    const connection = await this.connections.findById(request.org_id, request.provider_instance_id);
    if (!connection) throw new Error('MCP connection is unavailable');

    // Target validation and credential materialization stay inside the MCP
    // provider boundary; callers pass only tenant/provider identity.
    const config = toConnectionConfig(connection);
    const overrides = request.overrides ?? [];
    let discovery: MCPToolDiscovery;
    switch (request.mode) {
      case 'cached':
        discovery = await this.client.getCachedToolDiscovery(config, overrides);
        break;
      case 'refresh':
        discovery = await this.client.discoverToolDiscovery(config, overrides);
        break;
      case 'test':
        discovery = await this.client.testToolDiscovery(config);
        break;
      default:
        throw new Error('Unsupported MCP capability discovery mode');
    }

    const snapshot = await this.snapshotFor(connection, discovery.providerTools);

    return {
      provider_kind: 'mcp',
      tools: discovery.tools,
      snapshot,
    };
  }

  async invoke(
    request: McpCapabilityInvocationRequest,
  ): Promise<McpCapabilityInvocationAdapterResult> {
    const requestedProvider = {
      provider_kind: 'mcp' as const,
      requested_provider_key: request.provider.connection_slug,
    };
    const resolved = await this.runtime.resolveExecutable(
      request.org_id,
      request.provider.connection_slug,
      request.provider.operation_name,
      request.actor.agent_employee_id,
    );
    if (!resolved.connection) {
      return {
        provider: requestedProvider,
        operation_name: request.provider.operation_name,
        provider_call_attempted: false,
        provider_succeeded: false,
        legacy_output: { error: resolved.error },
        error: resolved.error,
        error_code: resolved.reason === 'operation_unavailable'
          ? 'CAPABILITY_OPERATION_UNAVAILABLE'
          : 'CAPABILITY_PROVIDER_UNAVAILABLE',
        duration_ms: 0,
      };
    }

    // Target validation and credential materialization remain before the one
    // external call and preserve their historical throw behavior.
    const config = toConnectionConfig(resolved.connection);
    const mcpResult = await this.runtime.executeTool(
      config,
      request.provider.operation_name,
      request.input,
    );
    const legacyOutput = mcpResultPayload(mcpResult);
    const provider = {
      ...requestedProvider,
      resolved_provider: {
        org_id: resolved.connection.org_id,
        provider_kind: 'mcp' as const,
        provider_instance_id: resolved.connection.id,
      },
    };
    const common = {
      provider,
      provider_display_name: resolved.connection.name,
      operation_name: request.provider.operation_name,
      provider_call_attempted: true,
      legacy_output: legacyOutput,
      duration_ms: mcpResult.durationMs,
    };
    if (mcpResult.success) {
      return {
        ...common,
        provider_succeeded: true,
      };
    }
    return {
      ...common,
      provider_succeeded: false,
      error: mcpResult.error || 'MCP tool error',
      error_code: 'CAPABILITY_PROVIDER_ERROR',
    };
  }

  async resolveGoverned(
    request: McpCapabilityInvocationRequest,
  ): Promise<ExecutableMcpConnectionResult> {
    return this.runtime.resolveExecutable(
      request.org_id,
      request.provider.connection_slug,
      request.provider.operation_name,
      request.actor.agent_employee_id,
    );
  }

  /** Execute one App Run attempt against the immutable provider identity.
   * Resolution and target materialization happen before the low-level call;
   * once that call is launched, an abort or transport-only failure is
   * conservatively indeterminate. */
  async executePinned(request: Readonly<{
    org_id: string;
    provider_instance_id: string;
    operation_name: string;
    input: Record<string, unknown>;
    dispatch_pin?: McpPinnedDispatchPin;
    signal?: AbortSignal;
  }>): Promise<McpPinnedExecutionResult> {
    if (request.signal?.aborted) return { status: 'not_attempted' };
    const resolvePinned = this.runtime.resolvePinnedExecutable;
    if (!resolvePinned) return { status: 'not_attempted' };
    const resolved = request.dispatch_pin
      ? await resolvePinned(
        request.org_id,
        request.provider_instance_id,
        request.operation_name,
        request.dispatch_pin.connector_authorization_version,
      )
      : await resolvePinned(
        request.org_id,
        request.provider_instance_id,
        request.operation_name,
      );
    if (!resolved.connection) return { status: 'not_attempted' };
    if (
      request.dispatch_pin
      && resolved.connection.app_run_authorization_version
        !== request.dispatch_pin.connector_authorization_version
    ) return { status: 'not_attempted' };

    let config: MCPConnectionConfig;
    try {
      config = toConnectionConfig(resolved.connection);
    } catch {
      return { status: 'not_attempted' };
    }
    if (request.signal?.aborted) return { status: 'not_attempted' };

    if (request.dispatch_pin) {
      let snapshot: Readonly<CapabilityProviderDiscoverySnapshot> | null;
      try {
        const discovery = await this.client.discoverToolDiscovery(config);
        // Dispatch must recompute from the just-refreshed response even when a
        // client reuses and mutates the same provider-tools array instance.
        this.snapshotCache.delete(discovery.providerTools);
        snapshot = await this.snapshotFor(resolved.connection, discovery.providerTools);
      } catch {
        return { status: 'not_attempted' };
      }
      const operation = snapshot?.operations.find(
        (candidate) => candidate.identity.operation_name === request.operation_name,
      );
      if (
        !snapshot
        || snapshot.snapshot_digest !== request.dispatch_pin.provider_snapshot_digest
        || !operation
        || operation.schema_digest !== request.dispatch_pin.operation_schema_digest
      ) return { status: 'not_attempted' };
    }
    if (request.signal?.aborted) return { status: 'not_attempted' };

    const call = Promise.resolve()
      .then(() => this.runtime.executeTool(config, request.operation_name, request.input))
      .then(
        (result) => ({ kind: 'result' as const, result }),
        () => ({ kind: 'failed' as const }),
      );
    let removeAbortListener = () => {};
    const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
      const listener = () => resolve({ kind: 'aborted' });
      request.signal?.addEventListener('abort', listener, { once: true });
      removeAbortListener = () => request.signal?.removeEventListener('abort', listener);
    });
    try {
      const settled = request.signal ? await Promise.race([call, aborted]) : await call;
      if (settled.kind !== 'result') return { status: 'indeterminate' };
      if (!settled.result.success && settled.result.rawResult === undefined) {
        return { status: 'indeterminate' };
      }
      return {
        status: 'returned',
        provider_succeeded: settled.result.success,
        output: mcpResultPayload(settled.result),
        ...(settled.result.error ? { error: settled.result.error } : {}),
        duration_ms: settled.result.durationMs,
      };
    } finally {
      removeAbortListener();
    }
  }

  private async snapshotFor(
    connection: McpConnectionRow,
    providerTools: MCPToolDiscovery['providerTools'],
  ): Promise<Readonly<CapabilityProviderDiscoverySnapshot> | null> {
    const cacheKey = [
      CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
      connection.org_id,
      connection.id,
    ].join('\u0000');
    const cachedByProvider = this.snapshotCache.get(providerTools);
    if (cachedByProvider?.has(cacheKey)) return cachedByProvider.get(cacheKey) ?? null;

    let snapshot: Readonly<CapabilityProviderDiscoverySnapshot> | null = null;
    try {
      if (providerTools.length > CAPABILITY_LIMITS.operations_per_snapshot) {
        throw new TypeError('MCP provider exposes too many tools for a discovery snapshot');
      }
      assertCapabilityJsonWithinBudget(
        { providerTools },
        CAPABILITY_LIMITS.snapshot_bytes,
      );
      const provider = {
        org_id: connection.org_id,
        provider_kind: 'mcp' as const,
        provider_instance_id: connection.id,
      };
      snapshot = await createCapabilityProviderDiscoverySnapshot({
        adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
        provider,
        captured_at: this.clock(),
        operations: providerTools.map((tool) => {
          const title = mcpSnapshotProviderTitle(tool.title);
          return {
            identity: {
              provider,
              operation_name: tool.name,
            },
            description: mcpSnapshotProviderDescription(tool.description),
            ...(title !== undefined ? { title } : {}),
            input_schema: sanitizeMcpSnapshotSchema(tool.inputSchema),
            ...(tool.outputSchema !== undefined
              ? { output_schema: sanitizeMcpSnapshotSchema(tool.outputSchema) }
              : {}),
          };
        }),
      });
    } catch {
      // Snapshot evidence is deliberately non-authoritative in Phase 2. A
      // malformed/oversized provider schema must not alter legacy discovery,
      // tool filtering, policy, or trigger another provider request.
      this.warn({
        code: 'CAPABILITY_SNAPSHOT_UNAVAILABLE',
        provider_kind: 'mcp',
        org_id: connection.org_id,
        provider_instance_id: connection.id,
      });
    }

    const nextCache = cachedByProvider ?? new Map<string, Readonly<CapabilityProviderDiscoverySnapshot> | null>();
    nextCache.set(cacheKey, snapshot);
    if (!cachedByProvider) this.snapshotCache.set(providerTools, nextCache);
    return snapshot;
  }
}

export const mcpCapabilityProvider = new McpCapabilityProvider();
