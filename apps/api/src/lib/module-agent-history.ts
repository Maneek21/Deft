import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
  type ModuleOperationName,
} from '@deft/shared/modules';
import { sanitizeModuleActionParamsForHistory } from './module-service.js';

const MODULE_OPERATION_SET = new Set<string>(MODULE_OPERATION_NAMES);
const MODULE_TASK_LINK_TOOL_SET = new Set([
  'module_record_task_links',
  'module_record_task_link',
  'module_record_task_unlink',
]);

type ToolNameRegistry = Map<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isModuleOperationName(value: unknown): value is ModuleOperationName {
  return typeof value === 'string' && MODULE_OPERATION_SET.has(value);
}

function isGovernedModuleToolName(value: unknown): value is string {
  return isModuleOperationName(value)
    || (typeof value === 'string' && MODULE_TASK_LINK_TOOL_SET.has(value));
}

function sanitizeModuleTaskLinkToolInput(value: unknown): Record<string, unknown> {
  const input = isRecord(value) ? value : {};
  const safe: Record<string, unknown> = {};
  for (const key of ['resource_id', 'task_identifier']) {
    if (typeof input[key] === 'string') safe[key] = input[key];
  }
  return safe;
}

function sanitizeGovernedModuleToolInput(
  toolName: string,
  value: unknown,
): Record<string, unknown> {
  return isModuleOperationName(toolName)
    ? sanitizeModuleToolInput(toolName, value)
    : sanitizeModuleTaskLinkToolInput(value);
}

/**
 * Persist only the identity/concurrency shape of a module call. Record values,
 * search terms, filter values, and idempotency keys must remain in the current
 * in-memory turn and never become durable agent history.
 */
export function sanitizeModuleToolInput(
  operation: ModuleOperationName,
  value: unknown,
): Record<string, unknown> {
  if (MODULE_OPERATION_DEFINITIONS[operation].mode === 'write') {
    return sanitizeModuleActionParamsForHistory(operation, value);
  }

  const input = isRecord(value) ? value : {};
  const safe: Record<string, unknown> = {};
  for (const key of ['module_id', 'collection_key', 'record_id']) {
    if (typeof input[key] === 'string') safe[key] = input[key];
  }
  if (typeof input.limit === 'number') safe.limit = input.limit;
  if (Array.isArray(input.filters)) {
    safe.filter_fields = input.filters
      .filter(isRecord)
      .map((filter) => ({
        ...(typeof filter.field === 'string' ? { field: filter.field } : {}),
        ...(typeof filter.operator === 'string' ? { operator: filter.operator } : {}),
      }));
  }
  return safe;
}

function redactedModuleToolResult(operation: string): string {
  return JSON.stringify({
    status: 'module_result_redacted',
    operation,
    message: 'Module data is not retained in agent history. Run the tool again for current data.',
  });
}

/**
 * Sanitize Anthropic-shaped tool blocks while preserving valid tool_use /
 * tool_result pairs. Pass the same registry across ordered message rows so a
 * result can be matched to the tool call that produced it.
 */
export function sanitizeAgentBlocksForStorage(
  value: unknown,
  toolNames: ToolNameRegistry = new Map(),
): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((block) => {
    if (!isRecord(block)) return block;
    if (
      block.type === 'tool_use'
      && typeof block.id === 'string'
      && typeof block.name === 'string'
    ) {
      toolNames.set(block.id, block.name);
      if (!isGovernedModuleToolName(block.name)) return block;
      return {
        ...block,
        input: sanitizeGovernedModuleToolInput(block.name, block.input),
      };
    }

    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const operation = toolNames.get(block.tool_use_id);
      if (!isGovernedModuleToolName(operation)) return block;
      return {
        ...block,
        content: redactedModuleToolResult(operation),
      };
    }
    return block;
  });
}

export function sanitizeAgentToolCallsForStorage(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((call) => {
    if (!isRecord(call) || !isGovernedModuleToolName(call.tool)) return call;
    return {
      ...call,
      params: sanitizeGovernedModuleToolInput(call.tool, call.params),
    };
  });
}

export function sanitizeAgentMetadataForStorage(
  value: unknown,
  toolNames: ToolNameRegistry = new Map(),
): Record<string, unknown> {
  const metadata = isRecord(value) ? value : {};
  return {
    ...metadata,
    ...(Object.hasOwn(metadata, 'agent_blocks')
      ? { agent_blocks: sanitizeAgentBlocksForStorage(metadata.agent_blocks, toolNames) }
      : {}),
    ...(Object.hasOwn(metadata, 'tool_calls')
      ? { tool_calls: sanitizeAgentToolCallsForStorage(metadata.tool_calls) }
      : {}),
  };
}
