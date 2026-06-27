import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentEmployees, messages, spaces, users, workIntents } from '@deft/db/schema';

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

workIntentRoutes.get('/', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
  const status = c.req.query('status');
  const kind = c.req.query('kind');

  const filters = [eq(workIntents.org_id, user.org_id)];
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
    .leftJoin(messages, eq(workIntents.source_message_id, messages.id))
    .leftJoin(spaces, eq(workIntents.space_id, spaces.id))
    .leftJoin(users, eq(workIntents.source_user_id, users.id))
    .leftJoin(agentEmployees, eq(workIntents.agent_employee_id, agentEmployees.id))
    .where(and(...filters))
    .orderBy(desc(workIntents.created_at))
    .limit(limit);

  return c.json({ intents: rows });
});

workIntentRoutes.get('/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(workIntents)
    .where(and(eq(workIntents.org_id, user.org_id), eq(workIntents.id, id)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ intent: row });
});
