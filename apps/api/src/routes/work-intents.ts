import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentActions, agentEmployees, messages, spaces, users, workIntents } from '@deft/db/schema';
import { getApprovalTier } from '../lib/agent-approval.js';
import { ensureDeftyEmployee } from '../lib/ensure-defty-membership.js';

export const workIntentRoutes = new Hono();

const VALID_STATUSES = ['proposed', 'converted', 'dismissed', 'expired', 'failed'] as const;
const VALID_KINDS = [
  'task_candidate',
  'blocker_candidate',
  'decision_candidate',
  'resource_candidate',
  'note_candidate',
  'question_candidate',
] as const;

type AuthedUser = { id: string; org_id: string };

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function visibleWorkIntentSourceSql(user: AuthedUser) {
  return sql`(
    (${workIntents.space_id} IS NULL AND ${workIntents.source_message_id} IS NULL)
    OR (
      ${workIntents.source_message_id} IS NULL
      AND ${workIntents.space_id} IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM space_members wi_sm
        INNER JOIN spaces wi_s ON wi_s.id = wi_sm.space_id
        WHERE wi_sm.space_id = ${workIntents.space_id}
          AND wi_sm.user_id = ${user.id}
          AND wi_s.org_id = ${user.org_id}
          AND wi_s.is_archived = false
      )
    )
    OR (
      ${workIntents.source_message_id} IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM messages wi_m
        INNER JOIN space_members wi_sm ON wi_sm.space_id = wi_m.space_id
        INNER JOIN spaces wi_s ON wi_s.id = wi_m.space_id
        WHERE wi_m.id = ${workIntents.source_message_id}
          AND wi_m.org_id = ${user.org_id}
          AND wi_m.is_deleted = false
          AND wi_sm.user_id = ${user.id}
          AND wi_s.org_id = ${user.org_id}
          AND wi_s.is_archived = false
          AND (${workIntents.space_id} IS NULL OR wi_m.space_id = ${workIntents.space_id})
      )
    )
  )`;
}

function visibleSourceMessageJoinSql(user: AuthedUser) {
  return and(
    eq(workIntents.source_message_id, messages.id),
    eq(messages.org_id, user.org_id),
    eq(messages.is_deleted, false),
    sql`(${workIntents.space_id} IS NULL OR ${messages.space_id} = ${workIntents.space_id})`,
    sql`EXISTS (
      SELECT 1
      FROM space_members wi_msg_sm
      INNER JOIN spaces wi_msg_s ON wi_msg_s.id = wi_msg_sm.space_id
      WHERE wi_msg_sm.space_id = ${messages.space_id}
        AND wi_msg_sm.user_id = ${user.id}
        AND wi_msg_s.org_id = ${user.org_id}
        AND wi_msg_s.is_archived = false
    )`,
  );
}

function visibleSourceUserJoinSql(user: AuthedUser) {
  return and(
    eq(workIntents.source_user_id, users.id),
    sql`EXISTS (
      SELECT 1
      FROM org_members wi_om
      WHERE wi_om.org_id = ${user.org_id}
        AND wi_om.user_id = ${users.id}
        AND wi_om.is_active = true
    )`,
  );
}

workIntentRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthedUser;
  const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
  const status = c.req.query('status');
  const kind = c.req.query('kind');

  const filters = [eq(workIntents.org_id, user.org_id), visibleWorkIntentSourceSql(user)];
  if (status && (VALID_STATUSES as readonly string[]).includes(status)) {
    filters.push(eq(workIntents.status, status as typeof VALID_STATUSES[number]));
  }
  if (kind && (VALID_KINDS as readonly string[]).includes(kind)) {
    filters.push(eq(workIntents.kind, kind as typeof VALID_KINDS[number]));
  }

  const rows = await db
    .select({
      id: workIntents.id,
      kind: workIntents.kind,
      status: workIntents.status,
      title: workIntents.title,
      summary: workIntents.summary,
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      source_message_id: workIntents.source_message_id,
      source_message_content: messages.content,
      space_id: workIntents.space_id,
      space_name: spaces.name,
      source_user_id: workIntents.source_user_id,
      source_user_name: users.name,
      agent_employee_id: workIntents.agent_employee_id,
      agent_employee_name: agentEmployees.name,
      converted_action_id: workIntents.converted_action_id,
      converted_task_id: workIntents.converted_task_id,
      converted_at: workIntents.converted_at,
      dismissed_at: workIntents.dismissed_at,
      failure_reason: workIntents.failure_reason,
      created_at: workIntents.created_at,
      updated_at: workIntents.updated_at,
    })
    .from(workIntents)
    .leftJoin(messages, visibleSourceMessageJoinSql(user))
    .leftJoin(spaces, and(
      eq(workIntents.space_id, spaces.id),
      eq(spaces.org_id, user.org_id),
    ))
    .leftJoin(users, visibleSourceUserJoinSql(user))
    .leftJoin(agentEmployees, and(
      eq(workIntents.agent_employee_id, agentEmployees.id),
      eq(agentEmployees.org_id, user.org_id),
    ))
    .where(and(...filters))
    .orderBy(desc(workIntents.created_at))
    .limit(limit);

  return c.json({ intents: rows });
});

workIntentRoutes.get('/:id', async (c) => {
  const user = c.get('user') as AuthedUser;
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, user.org_id),
      eq(workIntents.id, id),
      visibleWorkIntentSourceSql(user),
    ))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ intent: row });
});

workIntentRoutes.post('/:id/retry', async (c) => {
  const user = c.get('user') as AuthedUser;
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: workIntents.id,
      org_id: workIntents.org_id,
      space_id: workIntents.space_id,
      source_message_id: workIntents.source_message_id,
      source_user_id: workIntents.source_user_id,
      agent_employee_id: workIntents.agent_employee_id,
      kind: workIntents.kind,
      status: workIntents.status,
      title: workIntents.title,
      summary: workIntents.summary,
      confidence: workIntents.confidence,
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      dedupe_key: workIntents.dedupe_key,
      failure_reason: workIntents.failure_reason,
      metadata: workIntents.metadata,
      agent_user_id: agentEmployees.user_id,
      agent_slug: agentEmployees.slug,
    })
    .from(workIntents)
    .leftJoin(agentEmployees, and(
      eq(workIntents.agent_employee_id, agentEmployees.id),
      eq(agentEmployees.org_id, user.org_id),
    ))
    .where(and(
      eq(workIntents.org_id, user.org_id),
      eq(workIntents.id, id),
      visibleWorkIntentSourceSql(user),
    ))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  if (row.status !== 'failed') {
    return c.json(
      { error: 'Only failed work intents can be retried', code: 'INVALID_STATE' },
      409,
    );
  }

  const fallbackDefty = row.agent_employee_id && row.agent_user_id && row.agent_slug
    ? null
    : await ensureDeftyEmployee(user.org_id);
  const employeeId = row.agent_employee_id && row.agent_user_id ? row.agent_employee_id : fallbackDefty!.employeeId;
  const employeeUserId = row.agent_user_id ?? fallbackDefty!.userId;
  const employeeSlug = row.agent_slug ?? fallbackDefty!.slug;
  const retryDedupeKey = `${row.dedupe_key}:retry`;

  const retry = await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM work_intents
      WHERE id = ${row.id}
        AND org_id = ${user.org_id}
      FOR UPDATE
    `);

    let [intent] = await tx
      .select({ id: workIntents.id })
      .from(workIntents)
      .where(and(
        eq(workIntents.org_id, user.org_id),
        eq(workIntents.dedupe_key, retryDedupeKey),
      ))
      .limit(1);

    if (!intent) {
      [intent] = await tx
        .insert(workIntents)
        .values({
          org_id: user.org_id,
          space_id: row.space_id,
          source_message_id: row.source_message_id,
          source_user_id: row.source_user_id,
          agent_employee_id: employeeId,
          kind: row.kind,
          status: 'proposed',
          title: row.title,
          summary: row.summary,
          confidence: row.confidence,
          proposed_action: row.proposed_action,
          proposed_params: row.proposed_params,
          dedupe_key: retryDedupeKey,
          metadata: {
            ...asRecord(row.metadata),
            retry_of_work_intent_id: row.id,
            retry_of_dedupe_key: row.dedupe_key,
            retry_failure_reason: row.failure_reason ?? null,
            retried_by: user.id,
          },
        })
        .onConflictDoNothing({
          target: [workIntents.org_id, workIntents.dedupe_key],
        })
        .returning({ id: workIntents.id });
    }

    if (!intent) {
      throw new Error('Failed to create retry work intent');
    }

    await tx.execute(sql`
      SELECT id
      FROM work_intents
      WHERE id = ${intent.id}
        AND org_id = ${user.org_id}
      FOR UPDATE
    `);

    const params = {
      ...asRecord(row.proposed_params),
      caller_employee_slug: employeeSlug,
      work_intent_id: intent.id,
      work_intent_status: 'proposed',
      retry_of_work_intent_id: row.id,
      retry_failure_reason: row.failure_reason ?? null,
      retried_by: user.id,
      dedupe_key: retryDedupeKey,
      proposed_by: 'defty',
    };

    const [existingAction] = await tx
      .select({
        id: agentActions.id,
        approval_tier: agentActions.approval_tier,
      })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'work_intent_id' = ${intent.id}`,
        sql`${agentActions.params}->>'retry_of_work_intent_id' = ${row.id}`,
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(1);

    if (existingAction) {
      return {
        intent_id: intent.id,
        action_id: existingAction.id,
        approval_tier: existingAction.approval_tier,
      };
    }

    const [action] = await tx
      .insert(agentActions)
      .values({
        org_id: user.org_id,
        user_id: employeeUserId,
        agent_employee_id: employeeId,
        conversation_id: row.space_id,
        action: row.proposed_action,
        message_id: row.source_message_id,
        params,
        approval_tier: getApprovalTier(row.proposed_action),
        approval_status: 'pending',
        source: 'defty_capture',
      })
      .returning({ id: agentActions.id });

    if (!action) {
      throw new Error('Failed to create retry approval');
    }

    return {
      intent_id: intent.id,
      action_id: action.id,
      approval_tier: getApprovalTier(row.proposed_action),
    };
  });

  return c.json({
    success: true,
    intent: {
      id: retry.intent_id,
      status: 'proposed',
      retry_of_work_intent_id: row.id,
    },
    action: {
      id: retry.action_id,
      approval_tier: retry.approval_tier,
    },
  });
});
