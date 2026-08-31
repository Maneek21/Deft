import { SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import type { DeftAppManifestV1 } from '@deft/app-kit';
import type { MCPTool, MCPToolOverride } from '@deft/mcp';
import {
  canonicalCapabilityJson,
  type CapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import { canonicalMcpToolName } from './mcp-tool-identity.js';

export const CONNECTED_APP_ACTION_BINDING_VERSION = 'deft.app_action_binding.v1' as const;
export const CONNECTED_APP_SANDBOX_OPERATION_NAME = 'send_email' as const;

type StoredMcpOverride = Readonly<{
  tool_name: string;
  trust_tier_override: 'auto' | 'quick' | 'full' | null;
  is_disabled: boolean;
}>;

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

export function sandboxEmailOperationMatches(
  operation: CapabilityProviderDiscoverySnapshot['operations'][number],
): boolean {
  return canonicalCapabilityJson({
    input_schema: operation.input_schema,
    output_schema: operation.output_schema,
  }) === canonicalCapabilityJson({
    input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
    output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
  });
}

export function sandboxEmailToolMatches(tool: MCPTool): boolean {
  return tool.originalName === CONNECTED_APP_SANDBOX_OPERATION_NAME
    && canonicalCapabilityJson({
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema,
    }) === canonicalCapabilityJson({
      input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    });
}

/** The first connected proof intentionally supports one closed resource mapping,
 * not the full Protocol-v1 input-source grammar. Keeping this check shared makes
 * review and preparation reject the same unsupported shapes. */
export function sandboxEmailActionBindingMatches(
  action: DeftAppManifestV1['actions'][number],
): boolean {
  if (action.input_bindings.length !== 3) return false;
  const byKey = new Map(action.input_bindings.map((binding) => [binding.input_key, binding.source]));
  const to = byKey.get('to');
  const subject = byKey.get('subject');
  const body = byKey.get('body_text');
  const placementKey = action.placement.resource_requirement_key;
  return byKey.size === 3
    && to?.kind === 'selected_relation_field'
    && to.source_resource_requirement_key === placementKey
    && to.selection === 'one'
    && subject?.kind === 'resource_field'
    && subject.resource_requirement_key === placementKey
    && body?.kind === 'resource_field'
    && body.resource_requirement_key === placementKey
    && subject.field_key !== body.field_key;
}
