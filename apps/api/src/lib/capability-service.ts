import {
  CAPABILITY_LIMITS,
  CapabilityInvocationOutcomeSchema,
  CapabilityInvocationRequestSchema,
  assertCapabilityJsonWithinBudget,
  type CapabilityInvocationOutcome,
} from '@deft/shared';
import {
  mcpCapabilityProvider,
  type McpCapabilityDiscoveryRequest,
  type McpCapabilityDiscoveryResult,
  type McpCapabilityInvocationAdapterResult,
  type McpCapabilityInvocationRequest,
} from './capability-providers/mcp.js';

export type CapabilityDiscoveryRequest = McpCapabilityDiscoveryRequest;
export type CapabilityDiscoveryResult = McpCapabilityDiscoveryResult;

export type CapabilitySafeOutcomeProjection =
  | { status: 'available'; outcome: CapabilityInvocationOutcome }
  | {
      status: 'unrepresentable';
      outcome: null;
      warning_code: 'CAPABILITY_OUTCOME_UNREPRESENTABLE';
    };

export interface CapabilityInvocationResult extends McpCapabilityInvocationAdapterResult {
  safe_projection: CapabilitySafeOutcomeProjection;
}

interface McpCapabilityProviderPort {
  discover(request: McpCapabilityDiscoveryRequest): Promise<McpCapabilityDiscoveryResult>;
  invoke(request: McpCapabilityInvocationRequest): Promise<McpCapabilityInvocationAdapterResult>;
}

/**
 * Provider-neutral internal seam for discovery now and invocation in the next
 * cutover loops. The provider union is intentionally closed.
 */
export class CapabilityService {
  constructor(
    private readonly mcpProvider: McpCapabilityProviderPort = mcpCapabilityProvider,
  ) {}

  async discover(request: CapabilityDiscoveryRequest): Promise<CapabilityDiscoveryResult> {
    switch (request.provider_kind) {
      case 'mcp':
        return this.mcpProvider.discover(request);
    }

    throw new Error('Unsupported capability provider kind');
  }

  async invoke(value: unknown): Promise<CapabilityInvocationResult> {
    // Invocation inputs cross an execution boundary, so reject unsupported
    // non-JSON/authority-bearing fields before resolution or any provider call.
    const request = CapabilityInvocationRequestSchema.parse(value);
    let adapterResult: McpCapabilityInvocationAdapterResult;
    switch (request.provider.provider_kind) {
      case 'mcp':
        adapterResult = await this.mcpProvider.invoke(request);
        break;
      default:
        throw new Error('Unsupported capability provider kind');
    }

    const candidate = {
      provider: adapterResult.provider,
      ...(adapterResult.provider_display_name !== undefined
        ? { provider_display_name: adapterResult.provider_display_name }
        : {}),
      operation_name: adapterResult.operation_name,
      success: adapterResult.provider_succeeded,
      output: adapterResult.legacy_output,
      ...(adapterResult.error !== undefined ? { error: adapterResult.error } : {}),
      ...(adapterResult.error_code !== undefined ? { error_code: adapterResult.error_code } : {}),
      duration_ms: adapterResult.duration_ms,
    };

    // Provider calls may already have caused an effect. A non-JSON SDK edge
    // payload must never convert that attempt into a throw, retry, or altered
    // legacy result. Preserve it verbatim and mark only the safe projection as
    // unavailable for future Run consumers.
    let safe_projection: CapabilitySafeOutcomeProjection;
    try {
      assertCapabilityJsonWithinBudget(
        candidate,
        CAPABILITY_LIMITS.outcome_projection_bytes,
      );
      const parsed = CapabilityInvocationOutcomeSchema.safeParse(candidate);
      safe_projection = parsed.success
        ? { status: 'available', outcome: parsed.data }
        : {
            status: 'unrepresentable',
            outcome: null,
            warning_code: 'CAPABILITY_OUTCOME_UNREPRESENTABLE',
          };
    } catch {
      safe_projection = {
        status: 'unrepresentable',
        outcome: null,
        warning_code: 'CAPABILITY_OUTCOME_UNREPRESENTABLE',
      };
    }

    return {
      ...adapterResult,
      safe_projection,
    };
  }
}

export const capabilityService = new CapabilityService();
