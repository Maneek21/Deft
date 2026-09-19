import { ZodError } from 'zod';
import { z } from 'zod';
import { MODULE_OPERATION_RESULT_SCHEMAS } from '@deft/shared/modules';

const DurableModuleMutationResultSchema = z.strictObject({
  status: z.literal('completed'),
  operation: z.enum([
    'module_record_create',
    'module_record_update',
  ]),
  resource_id: z.string().min(1).max(512),
  record_id: z.string().min(1).max(255),
  installation_id: z.string().min(1).max(255),
  module_id: z.string().min(1).max(255),
  collection_key: z.string().min(1).max(255),
  revision: z.number().int().nonnegative(),
  archived: z.boolean(),
  changed_fields: z.array(z.string().min(1).max(255)).max(256),
  replayed: z.boolean(),
});

export const DurableAgentActionResultSchema = DurableModuleMutationResultSchema;

export type DurableAgentActionResult = z.infer<typeof DurableAgentActionResultSchema>;

function parseResultContent(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Keep only schema-validated mutation identity/status facts for a later agent
 * turn. Record values, raw inputs, idempotency material, and provider output
 * never enter this projection.
 */
export function durableAgentActionResult(
  operation: string,
  value: unknown,
): DurableAgentActionResult | null {
  const candidate = parseResultContent(value);
  if (
    operation !== 'module_record_create'
    && operation !== 'module_record_update'
  ) return null;

  const parsed = MODULE_OPERATION_RESULT_SCHEMAS[operation].safeParse(candidate);
  if (!parsed.success) return null;
  return DurableModuleMutationResultSchema.parse({
    status: 'completed',
    operation,
    resource_id: parsed.data.resource_id,
    record_id: parsed.data.record_id,
    installation_id: parsed.data.installation_id,
    module_id: parsed.data.module_id,
    collection_key: parsed.data.collection_key,
    revision: parsed.data.revision,
    archived: parsed.data.archived,
    changed_fields: parsed.data.changed_fields,
    replayed: parsed.data.replayed,
  });
}

export function durableAgentActionResultFromMetadata(value: unknown): DurableAgentActionResult | null {
  const parsed = DurableAgentActionResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function durableAgentActionResultHistoryText(result: DurableAgentActionResult): string {
  return `The ${result.operation} operation completed with durable result identifiers: ${JSON.stringify(result)}. Reuse these identifiers for later steps, and check the latest record revision before an update.`;
}

export function agentToolResultContent(
  result: unknown,
  sources: unknown[],
  nextReads?: unknown,
  relationshipContext?: unknown,
): string {
  return JSON.stringify({
    result,
    sources,
    ...(nextReads ? { next_reads: nextReads } : {}),
    ...(relationshipContext ? { relationship_context: relationshipContext } : {}),
  });
}

/** Safe, recoverable evidence for the model; no raw input or exception details. */
export function agentToolFailure(error: unknown) {
  if (error instanceof ZodError) {
    return {
      code: 'VALIDATION_ERROR',
      error: 'Invalid tool arguments. Read the tool schema and retry with corrected arguments.',
      fields: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    };
  }
  return { code: 'TOOL_FAILED', error: 'The tool could not complete this lookup. Report the failure; do not interpret it as missing records.' };
}
