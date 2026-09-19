import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { oauthAuditEvents } from '@deft/db/schema';
import {
  MODULE_OPERATION_REQUEST_SCHEMAS, MODULE_OPERATION_RESULT_SCHEMAS,
  moduleTaskOperationRequiredScopes, parseModuleRecordResourceId, type ModuleActor,
} from '@deft/shared/modules';
import { db } from './db.js';
import { resolveTaskIdentifier } from './agent-actions.js';
import { ModuleError } from './module-errors.js';
import { linkModuleRecordToTask, unlinkModuleRecordFromTask, preflightModuleRecordTaskMutationWithExecutor, ModuleTaskLinkError } from './module-task-links.js';

export type ModuleTaskWriteOperation = 'module_record_task_link' | 'module_record_task_unlink';
export function isModuleTaskWriteOperation(operation: string): operation is ModuleTaskWriteOperation {
  return operation === 'module_record_task_link' || operation === 'module_record_task_unlink';
}

/** Human MCP keeps human authority. The edge, audit and retry result commit together. */
export async function executeHumanModuleTaskWrite(
  operation: ModuleTaskWriteOperation,
  actor: ModuleActor,
  value: unknown,
  clientId: string,
) {
  if (actor.kind !== 'human' || actor.source !== 'mcp') {
    throw new ModuleError('A human MCP principal is required', 'MODULE_ACCESS_DENIED', 403);
  }
  const missing = moduleTaskOperationRequiredScopes(operation)!.find((scope) => !actor.scopes.includes(scope));
  if (missing) throw new ModuleError(`Missing MCP scope: ${missing}`, 'MODULE_SCOPE_REQUIRED', 403);
  const input = MODULE_OPERATION_REQUEST_SCHEMAS[operation].parse(value);
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const keyDigest = digest([actor.org_id, actor.actor_id, clientId, operation, input.idempotency_key]);
  const inputDigest = digest([input.resource_id, input.task_identifier]);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`human-module-task:${keyDigest}`}, 0))`);
    const [prior] = await tx.select({ metadata: oauthAuditEvents.metadata }).from(oauthAuditEvents).where(and(
      eq(oauthAuditEvents.org_id, actor.org_id), eq(oauthAuditEvents.user_id, actor.actor_id),
      eq(oauthAuditEvents.client_id, clientId), eq(oauthAuditEvents.event, 'mcp_idempotency_result'),
      sql`${oauthAuditEvents.metadata}->>'tool_name' = ${operation}`,
      sql`${oauthAuditEvents.metadata}->>'idempotency_digest' = ${keyDigest}`,
    )).orderBy(desc(oauthAuditEvents.created_at)).limit(1);
    if (prior) {
      if (prior.metadata?.input_digest !== inputDigest) {
        throw new ModuleError('Idempotency key was already used for a different task-link mutation', 'MODULE_IDEMPOTENCY_CONFLICT', 409);
      }
      const result = MODULE_OPERATION_RESULT_SCHEMAS[operation].parse(prior.metadata?.mutation_result);
      // Symbolic task identifiers can be reassigned. Reauthorize the canonical
      // task that produced the stored result before disclosing a replay.
      await preflightModuleRecordTaskMutationWithExecutor(
        tx, actor, result.task_id, input.resource_id, operation,
      );
      return result;
    }
    const taskId = await resolveTaskIdentifier(input.task_identifier, actor.org_id, tx);
    if (!taskId) throw new ModuleTaskLinkError('Task not found', 'TASK_NOT_FOUND');
    await preflightModuleRecordTaskMutationWithExecutor(tx, actor, taskId, input.resource_id, operation);
    const mutation = operation === 'module_record_task_link'
      ? await linkModuleRecordToTask(actor, taskId, input.resource_id, tx).then((linked) => ({
        resource_id: input.resource_id, task_id: taskId, edge_id: linked.link.edge_id, created: linked.created,
      }))
      : { resource_id: input.resource_id, task_id: taskId,
        ...await unlinkModuleRecordFromTask(actor, taskId, parseModuleRecordResourceId(input.resource_id), tx) };
    const result = MODULE_OPERATION_RESULT_SCHEMAS[operation].parse(mutation);
    await tx.insert(oauthAuditEvents).values({
      org_id: actor.org_id, user_id: actor.actor_id, client_id: clientId, event: 'mcp_idempotency_result',
      metadata: { tool_name: operation, idempotency_digest: keyDigest, input_digest: inputDigest,
        principal_kind: 'human', mutation_result: result },
    });
    return result;
  });
}
