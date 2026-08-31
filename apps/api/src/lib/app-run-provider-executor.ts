import type { CapabilityJsonValue } from '@deft/shared';
import type {
  McpCapabilityProvider,
  McpPinnedDispatchPin,
} from './capability-providers/mcp.js';

export type AppRunProviderExecutionRequest = Readonly<{
  org_id: string;
  provider_kind: 'mcp';
  provider_instance_id: string;
  operation_name: string;
  origin_kind?: 'core' | 'legacy_connector' | 'app';
  input: CapabilityJsonValue;
  provider_idempotency_key?: string;
  dispatch_pin?: McpPinnedDispatchPin;
  signal?: AbortSignal;
}>;

export type AppRunProviderExecutionResult =
  | Readonly<{
      status: 'not_attempted';
      error_code?: 'APP_RUN_PROVIDER_UNAVAILABLE' | 'APP_RUN_PROVIDER_TIMEOUT';
    }>
  | Readonly<{
      status: 'returned';
      provider_succeeded: boolean;
      output: unknown;
      error?: string;
      duration_ms?: number;
    }>
  | Readonly<{ status: 'indeterminate' }>;

export interface AppRunProviderExecutor {
  execute(request: AppRunProviderExecutionRequest): Promise<AppRunProviderExecutionResult>;
}

interface PinnedCapabilityPort {
  executePinned(request: Readonly<{
    org_id: string;
    provider_instance_id: string;
    operation_name: string;
    input: Record<string, unknown>;
    dispatch_pin?: McpPinnedDispatchPin;
    signal?: AbortSignal;
  }>): Promise<Awaited<ReturnType<McpCapabilityProvider['executePinned']>>>;
}

const lazyPinnedCapability: PinnedCapabilityPort = Object.freeze({
  async executePinned(request: Parameters<PinnedCapabilityPort['executePinned']>[0]) {
    const { capabilityService } = await import('./capability-service.js');
    return capabilityService.invokePinned(request);
  },
});

export const MCP_APP_RUN_RESULT_VERSION = 'deft.app_run.mcp_result.v1';

function isInputObject(
  value: CapabilityJsonValue,
): value is { [key: string]: CapabilityJsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The sole App Run-to-provider bridge. Generic MCP has no portable
 * out-of-band idempotency-key channel, so key-dependent attempts remain
 * fail-closed until an explicit provider binding can prove the key is used. */
export class PinnedMcpAppRunProviderExecutor implements AppRunProviderExecutor {
  constructor(private readonly provider: PinnedCapabilityPort = lazyPinnedCapability) {}

  async execute(request: AppRunProviderExecutionRequest): Promise<AppRunProviderExecutionResult> {
    if (
      request.provider_kind !== 'mcp'
      || !isInputObject(request.input)
    ) {
      return { status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' };
    }
    let providerInput = request.input;
    if (request.origin_kind === 'app') {
      if (
        !request.provider_idempotency_key
        || !request.dispatch_pin
        || typeof request.input.idempotency_key !== 'string'
      ) return { status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' };
      providerInput = { ...request.input, idempotency_key: request.provider_idempotency_key };
    } else if (
      request.provider_idempotency_key !== undefined
      || request.dispatch_pin !== undefined
    ) {
      return { status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' };
    }
    if (request.signal?.aborted) {
      return { status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_TIMEOUT' };
    }
    const result = await this.provider.executePinned({
      org_id: request.org_id,
      provider_instance_id: request.provider_instance_id,
      operation_name: request.operation_name,
      input: providerInput,
      ...(request.dispatch_pin ? { dispatch_pin: request.dispatch_pin } : {}),
      signal: request.signal,
    });
    if (result.status === 'not_attempted') {
      return {
        status: 'not_attempted',
        error_code: request.signal?.aborted
          ? 'APP_RUN_PROVIDER_TIMEOUT'
          : 'APP_RUN_PROVIDER_UNAVAILABLE',
      };
    }
    if (result.status === 'indeterminate') return result;
    return {
      status: 'returned',
      provider_succeeded: result.provider_succeeded,
      output: {
        schema_version: MCP_APP_RUN_RESULT_VERSION,
        legacy_output: result.output,
        duration_ms: result.duration_ms,
        ...(result.error ? { error: result.error } : {}),
      },
      ...(result.error ? { error: result.error } : {}),
      duration_ms: result.duration_ms,
    };
  }
}
