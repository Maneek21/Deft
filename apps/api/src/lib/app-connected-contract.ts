import {
  DEFT_APP_PROTOCOL_SUPPORT,
  SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
  SandboxEmailSendInputSchema,
  type DeftAppManifestV1,
  type DeftAppManifestV2,
  type DeftAppPackageV1,
  type DeftAppPackageV2,
  type DeftAppPrivateInterfaceDescriptorV1,
} from '@deft/app-kit';
import type { MCPTool, MCPToolOverride } from '@deft/mcp';
import {
  canonicalCapabilityJson,
  type CapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import { canonicalMcpToolName } from './mcp-tool-identity.js';

export const CONNECTED_APP_ACTION_BINDING_VERSION = 'deft.app_action_binding.v1' as const;

export type ConnectedAppProtocolVersion = '1' | '2';
export type ConnectedDeftAppManifest = DeftAppManifestV1 | DeftAppManifestV2;
export type ConnectedDeftAppPackage = DeftAppPackageV1 | DeftAppPackageV2;

export function isConnectedAppProtocolVersion(value: string): value is ConnectedAppProtocolVersion {
  return value === '1' || value === '2';
}

type StoredMcpOverride = Readonly<{
  tool_name: string;
  trust_tier_override: 'auto' | 'quick' | 'full' | null;
  is_disabled: boolean;
}>;

type PrivateInterfaceReference = Readonly<{
  key: string;
  version: string;
}>;

type ProviderInputParseResult = ReturnType<typeof SandboxEmailSendInputSchema.safeParse>;
type ProviderInputSchema = Readonly<{
  safeParse(value: unknown): ProviderInputParseResult;
}>;

export function connectedAppPrivateInterfaceRegistryKey(
  value: PrivateInterfaceReference,
): string {
  return `${value.key}:v${value.version}`;
}

const CONNECTED_APP_PROVIDER_INPUT_SCHEMAS: Readonly<Record<string, ProviderInputSchema>> = Object.freeze({
  [connectedAppPrivateInterfaceRegistryKey(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE)]:
    SandboxEmailSendInputSchema,
});

/** One canonical interpretation of historical/current MCP override names for
 * connected-App review, health, preparation, and later execution checks. */
export function normalizeConnectedMcpOverrides(
  rows: readonly StoredMcpOverride[],
): MCPToolOverride[] {
  const byName = new Map<string, MCPToolOverride>();
  const rank = { 'auto-execute': 0, 'quick-approve': 1, 'full-review': 2 } as const;
  for (const row of rows) {
    const toolName = canonicalMcpToolName(row.tool_name);
    const approvalTier = row.trust_tier_override === 'auto'
      ? 'auto-execute' as const
      : row.trust_tier_override === 'quick'
        ? 'quick-approve' as const
        : row.trust_tier_override === 'full'
          ? 'full-review' as const
          : undefined;
    const existing = byName.get(toolName);
    const strictestTier = existing?.approvalTier && approvalTier
      ? (rank[existing.approvalTier] >= rank[approvalTier] ? existing.approvalTier : approvalTier)
      : existing?.approvalTier ?? approvalTier;
    byName.set(toolName, {
      toolName,
      ...(strictestTier ? { approvalTier: strictestTier } : {}),
      disabled: Boolean(existing?.disabled || row.is_disabled),
    });
  }
  return [...byName.values()].sort((left, right) => left.toolName.localeCompare(right.toolName));
}

/** Resolve only the frozen code-owned private interfaces shared by connected
 * App Protocols v1 and v2. Unknown identities return null so every caller can
 * fail closed with its own structured error. */
export function getConnectedAppPrivateInterface(
  value: PrivateInterfaceReference | null | undefined,
): DeftAppPrivateInterfaceDescriptorV1 | null {
  if (!value || typeof value.key !== 'string' || typeof value.version !== 'string') return null;
  return DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.find((candidate) => (
    candidate.key === value.key && candidate.version === value.version
  )) ?? null;
}

export function connectedAppOperationMatches(
  privateInterface: DeftAppPrivateInterfaceDescriptorV1,
  operation: CapabilityProviderDiscoverySnapshot['operations'][number],
): boolean {
  return operation.identity.operation_name === privateInterface.operation_name
    && canonicalCapabilityJson({
      input_schema: operation.input_schema,
      output_schema: operation.output_schema,
    }) === canonicalCapabilityJson({
      input_schema: privateInterface.input_schema,
      output_schema: privateInterface.output_schema,
    });
}

export function connectedAppToolMatches(
  privateInterface: DeftAppPrivateInterfaceDescriptorV1,
  tool: MCPTool,
): boolean {
  return tool.originalName === privateInterface.operation_name
    && canonicalCapabilityJson({
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema,
    }) === canonicalCapabilityJson({
      input_schema: privateInterface.input_schema,
      output_schema: privateInterface.output_schema,
    });
}

/** Evaluate the closed binding grammar as inert registry data. No App-provided
 * callback, expression, or schema is executed. */
export function connectedAppActionBindingMatches(
  privateInterface: DeftAppPrivateInterfaceDescriptorV1,
  action: ConnectedDeftAppManifest['actions'][number],
): boolean {
  const constraints = privateInterface.action_binding.inputs;
  if (action.input_bindings.length !== constraints.length) return false;
  const byKey = new Map(action.input_bindings.map((binding) => [binding.input_key, binding.source]));
  if (byKey.size !== constraints.length) return false;

  for (const constraint of constraints) {
    const source = byKey.get(constraint.input_key);
    if (!source || source.kind !== constraint.source_kind) return false;
    if (constraint.source_kind === 'resource_field') {
      if (
        source.kind !== 'resource_field'
        || constraint.resource_requirement !== 'placement'
        || source.resource_requirement_key !== action.placement.resource_requirement_key
      ) return false;
    } else if (
      source.kind !== 'selected_relation_field'
      || constraint.source_resource_requirement !== 'placement'
      || source.source_resource_requirement_key !== action.placement.resource_requirement_key
      || source.selection !== constraint.selection
    ) return false;
  }

  for (const [leftKey, rightKey] of privateInterface.action_binding.distinct_resource_field_inputs) {
    const left = byKey.get(leftKey);
    const right = byKey.get(rightKey);
    if (
      !left
      || left.kind !== 'resource_field'
      || !right
      || right.kind !== 'resource_field'
      || left.field_key === right.field_key
    ) return false;
  }
  return true;
}

export function parseConnectedAppProviderInput(
  privateInterface: DeftAppPrivateInterfaceDescriptorV1,
  value: unknown,
): ProviderInputParseResult {
  const schema = CONNECTED_APP_PROVIDER_INPUT_SCHEMAS[
    connectedAppPrivateInterfaceRegistryKey(privateInterface)
  ];
  if (!schema) throw new TypeError('Connected App private interface input parser is not registered');
  return schema.safeParse(value);
}
