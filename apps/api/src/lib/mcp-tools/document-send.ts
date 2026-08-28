import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentActions, agentEmployees } from '@deft/db/schema';
import { db } from '../db.js';
import {
  DOCUMENT_SEND_ACTION,
  prepareDocumentSend,
  sanitizeDocumentSendParams,
} from '../document-send.js';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

export type DocumentSendArgs = {
  caller_employee_slug: string;
  source_message_id: string;
  filename: string;
  mime_type: 'text/markdown' | 'text/plain' | 'text/csv';
  content: string;
  caption?: string;
  target?: { space_id: string } | { thread_id: string } | { user_id: string };
  space_id?: string;
  thread_id?: string;
  user_id?: string;
  idempotency_key?: string;
};

export async function documentSend(args: DocumentSendArgs, ctx: ToolContext): Promise<ToolResult> {
  try {
    const [employee] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, ctx.employee_id),
        eq(agentEmployees.org_id, ctx.org_id),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!employee) return errorResult('document_send: employee is inactive or unavailable');

    const prepared = await prepareDocumentSend({
      input: args,
      orgId: ctx.org_id,
      actorUserId: employee.user_id,
      employeeId: ctx.employee_id,
    });
    const queued = await db.transaction(async (tx) => {
      const lockKey = `${ctx.org_id}:${ctx.employee_id}:${prepared.idempotency_key}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx.select({
        id: agentActions.id,
        approval_status: agentActions.approval_status,
        params: agentActions.params,
      }).from(agentActions).where(and(
        eq(agentActions.org_id, ctx.org_id),
        eq(agentActions.agent_employee_id, ctx.employee_id),
        eq(agentActions.action, DOCUMENT_SEND_ACTION),
        inArray(agentActions.approval_status, ['pending', 'approved']),
        sql`${agentActions.params}->>'idempotency_key' = ${prepared.idempotency_key}`,
      )).limit(1);
      if (existing) {
        const existingDigest = existing.params && typeof existing.params === 'object' && !Array.isArray(existing.params)
          ? (existing.params as Record<string, unknown>).preview_digest
          : undefined;
        if (existingDigest !== prepared.preview_digest) {
          throw new Error('idempotency_key was already used for a different document');
        }
        return { ...existing, idempotent: true };
      }

      const [created] = await tx.insert(agentActions).values({
        org_id: ctx.org_id,
        user_id: employee.user_id,
        agent_employee_id: ctx.employee_id,
        channel_event_id: ctx.channel_event_id,
        runtime_request_key: ctx.runtime_request_key,
        conversation_id: prepared.source_space_id,
        source: 'mcp',
        action: DOCUMENT_SEND_ACTION,
        params: prepared,
        approval_tier: 'full',
        approval_status: 'pending',
      }).returning({
        id: agentActions.id,
        approval_status: agentActions.approval_status,
        params: agentActions.params,
      });
      if (!created) throw new Error('pending action insert returned no row');
      return { ...created, idempotent: false };
    });

    return textResult({
      status: queued.approval_status,
      action_id: queued.id,
      idempotent: queued.idempotent,
      message: queued.approval_status === 'approved'
        ? 'This exact document send was already approved.'
        : 'Document send is pending full human review. No file or message has been created yet.',
      preview: sanitizeDocumentSendParams(queued.params),
    });
  } catch (error) {
    return errorResult(`document_send: ${error instanceof Error ? error.message : String(error)}`);
  }
}
