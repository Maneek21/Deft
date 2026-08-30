import {
  CAPABILITY_CONTRACT_VERSIONS,
  CAPABILITY_LIMITS,
  assertCapabilityJsonWithinBudget,
  createCapabilityProviderDiscoverySnapshot,
  type CapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import { mcpConnections } from '@deft/db/schema';
import {
  mcpClientManager,
  type MCPToolDiscovery,
  type MCPTool,
  type MCPToolOverride,
} from '@deft/mcp';
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { toConnectionConfig } from '../mcp-runtime.js';
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
