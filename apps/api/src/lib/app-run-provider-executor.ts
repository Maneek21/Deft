import type { CapabilityJsonValue } from '@deft/shared';

export type AppRunProviderExecutionRequest = Readonly<{
  org_id: string;
  provider_kind: 'mcp';
  provider_instance_id: string;
  operation_name: string;
  input: CapabilityJsonValue;
  provider_idempotency_key?: string;
  signal?: AbortSignal;
}>;

export type AppRunProviderExecutionResult =
  | Readonly<{ status: 'succeeded'; output: unknown }>
  | Readonly<{ status: 'failed'; no_effect: true }>
  | Readonly<{ status: 'indeterminate' }>;

export interface AppRunProviderExecutor {
  execute(request: AppRunProviderExecutionRequest): Promise<AppRunProviderExecutionResult>;
}
