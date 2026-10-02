import type { ResolvedMcpPrincipal } from './mcp-token.js';
import { createPrivateMcpInvocation, firstClassMcpAuthentication } from './mcp-token.js';
import { privateMcpEnabled } from './app-private-mcp-authority.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { AppPrivateMcpService } from './app-private-mcp-service.js';
import { PRIVATE_MCP_TOOL_NAMES, PRIVATE_MCP_WIRE_LIMITS, PrivateMcpReadInput, PrivateMcpCiteInput } from './app-private-mcp-contract.js';
import type { ToolResult } from './mcp-tools/types.js';
import { PrivateResourceAccessError } from './app-resource-access-contract.js';

export function isPrivateMcpTool(name: string): name is typeof PRIVATE_MCP_TOOL_NAMES[number] {
  return (PRIVATE_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

export function privateMcpCatalog(principal: ResolvedMcpPrincipal) {
  const stamp = firstClassMcpAuthentication(principal);
  if (!privateMcpEnabled() || !stamp?.scopes.includes('read:app-private-resources')) return [];
  return PRIVATE_MCP_TOOL_NAMES.map(name => ({
    name, description: 'Read explicitly approved exact private App context for this exact MCP credential. Human sharing and actions are separate.',
    inputSchema: name === 'app_private_resource_read' ? {
      type: 'object', additionalProperties: false,
      properties: { schema_version: { const: 'deft.app_private_mcp_read.v1', type: 'string' }, grant_id: { type: 'string', format: 'uuid' }, citation_token: { type: 'string', maxLength: 2048 } },
      required: ['schema_version'], oneOf: [{ required: ['grant_id'] }, { required: ['citation_token'] }],
    } : name === 'app_private_resource_cite' ? {
      type: 'object', additionalProperties: false,
      properties: { schema_version: { const: 'deft.app_private_mcp_cite.v1', type: 'string' }, grant_id: { type: 'string', format: 'uuid' } }, required: ['schema_version', 'grant_id'],
    } : {
      type: 'object', additionalProperties: false,
      properties: { schema_version: { const: 'deft.app_private_mcp_search.v1', type: 'string' }, grant_id: { type: 'string', format: 'uuid' }, query: { type: 'string', minLength: 1, maxLength: 200 }, field_keys: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 48 } }, cursor: { type: 'string', maxLength: 2048 } }, required: ['schema_version', 'grant_id', 'query', 'field_keys'],
    },
  })).filter(tool => principal.kind !== 'agent' || principal.gateway_employees.every(employee => !employee.unhealthy && !(employee.disabled_tools ?? []).includes(tool.name)));
}

/** Private branch returns after its own in-transaction audit/final authority.
 * Generic dispatch must not add an audit await after this result. */
export async function dispatchPrivateMcpTool(principal: ResolvedMcpPrincipal, name: typeof PRIVATE_MCP_TOOL_NAMES[number], raw: unknown, signal: AbortSignal): Promise<ToolResult> {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > PRIVATE_MCP_WIRE_LIMITS.input_bytes) throw new Error('Invalid private MCP arguments');
    const invocation = createPrivateMcpInvocation(principal, signal);
    if (!invocation || !privateMcpEnabled()) throw new Error('Private MCP authority unavailable');
    const runtime = await getAppRunRuntime();
    const service = new AppPrivateMcpService(runtime.keys);
    if (name === 'app_private_resource_read') {
      const input = PrivateMcpReadInput.parse(raw);
      if ('citation_token' in input) return await service.readCitation(invocation, input.citation_token);
      return await service.read(invocation, input.grant_id);
    }
    if (name === 'app_private_resource_cite') return await service.read(invocation, PrivateMcpCiteInput.parse(raw).grant_id, 'cite');
    return await service.search(invocation, raw);
  } catch (error) {
    if (error instanceof PrivateResourceAccessError && error.code === 'APP_RESOURCE_ACCESS_STALE') {
      return { isError: true, content: [{ type: 'text', text: 'Private App search changed. Restart the search with current approved context.' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'Private App context is unavailable for this credential.' }] };
  }
}
