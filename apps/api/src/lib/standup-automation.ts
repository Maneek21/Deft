import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  messages,
  orgs,
  projects,
  spaces,
  spaceMembers,
  standups,
  taskActivity,
  tasks,
  users,
} from '@deft/db/schema';
import { db } from './db.js';
import { claimAutomationRun, failAutomationRun, updateAutomationRun } from './automation-runs.js';
import { localClockAt, standupRunKey } from './automation-schedule.js';
import {
  parseGroundedDraft,
  renderStandupDraft,
  standupDraftSchema,
  type StandupDraft,
} from './automation-synthesis.js';
import { runAgentQuery } from './agent-runner.js';
import { ensureDeftyMembership, DEFTY_NAME } from './ensure-defty-membership.js';
import { resolveReasonProvider } from './org-ai-config.js';
import { getIO } from '../socket.js';

type StandupEvidence = {
  source_id: string;
  kind: 'completed_task' | 'active_task' | 'overdue_task' | 'chat_activity';
  text: string;
};

function taskKey(prefix: string | null, number: number) {
  return prefix ? `${prefix}-${number}` : `Task ${number}`;
}

function fallbackDraft(evidence: StandupEvidence[]): StandupDraft {
  const items = (kind: StandupEvidence['kind'], max: number) => evidence
    .filter((entry) => entry.kind === kind)
    .slice(0, max)
    .map((entry) => ({ text: entry.text, source_ids: [entry.source_id] }));
  return {
    done: items('completed_task', 4),
    in_progress: [
      ...items('active_task', 4),
      ...items('chat_activity', 1),
    ].slice(0, 5),
    blocked: items('overdue_task', 4),
  };
}

async function gatherStandupEvidence(orgId: string, now: Date) {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const completedRows = await db
    .select({
      task_id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      prefix: projects.prefix,
      assignee_name: users.name,
      changed_at: taskActivity.created_at,
    })
    .from(taskActivity)
    .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      eq(taskActivity.field, 'status'),
      eq(taskActivity.new_value, 'done'),
      gte(taskActivity.created_at, since),
    ))
    .orderBy(desc(taskActivity.created_at));

  const activeRows = await db
    .select({
      task_id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      prefix: projects.prefix,
      assignee_name: users.name,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      gte(tasks.updated_at, since),
      sql`${tasks.status} NOT IN ('done', 'cancelled')`,
    ))
    .orderBy(desc(tasks.updated_at))
    .limit(12);

  const overdueRows = await db
    .select({
      task_id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      prefix: projects.prefix,
      assignee_name: users.name,
      due_date: tasks.due_date,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      lt(tasks.due_date, now),
      sql`${tasks.status} NOT IN ('done', 'cancelled')`,
    ))
    .orderBy(tasks.due_date)
    .limit(8);

  const chatRows = await db
    .select({
      space_id: spaces.id,
      space_name: spaces.name,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(spaces, eq(messages.space_id, spaces.id))
    .where(and(
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
      eq(spaces.type, 'public'),
      gte(messages.created_at, since),
    ))
    .groupBy(spaces.id, spaces.name);

  const seenCompleted = new Set<string>();
  const evidence: StandupEvidence[] = [];
  for (const row of completedRows) {
    if (seenCompleted.has(row.task_id)) continue;
    seenCompleted.add(row.task_id);
    evidence.push({
      source_id: `task:${row.task_id}`,
      kind: 'completed_task',
      text: `${taskKey(row.prefix, row.number)} ${row.title} was completed${row.assignee_name ? ` by ${row.assignee_name}` : ''}.`,
    });
  }
  for (const row of activeRows) {
    evidence.push({
      source_id: `task:${row.task_id}`,
      kind: 'active_task',
      text: `${taskKey(row.prefix, row.number)} ${row.title} is ${row.status.replaceAll('_', ' ')}${row.assignee_name ? ` with ${row.assignee_name}` : ''}.`,
    });
  }
  for (const row of overdueRows) {
    evidence.push({
      source_id: `task:${row.task_id}`,
      kind: 'overdue_task',
      text: `${taskKey(row.prefix, row.number)} ${row.title} is overdue${row.assignee_name ? ` with ${row.assignee_name}` : ''}.`,
    });
  }
  for (const row of chatRows) {
    evidence.push({
      source_id: `space:${row.space_id}`,
      kind: 'chat_activity',
      text: `${Number(row.count)} messages were posted in #${row.space_name}.`,
    });
  }
  return evidence;
}

async function synthesizeStandup(
  orgId: string,
  orgName: string,
  deftyUserId: string,
  evidence: StandupEvidence[],
) {
  const fallback = fallbackDraft(evidence);
  if (evidence.length === 0) {
    return { draft: fallback, generator: 'fallback' as const, model: null };
  }
  const provider = await resolveReasonProvider(orgId);
  if (!provider.apiKey && provider.provider !== 'ollama') {
    return { draft: fallback, generator: 'fallback' as const, model: null };
  }
  try {
    const response = await runAgentQuery({
      orgId,
      orgName,
      userId: deftyUserId,
      mode: 'chat_mention',
      skipVerification: true,
      maxIterations: 2,
      systemPromptOverride: 'You are Defty preparing the daily standup. Use only the supplied evidence. Do not invent people, work, blockers, or source IDs. Do not call tools. Return JSON only.',
      content: `Return JSON only with keys done, in_progress, blocked. Each value is an array of {"text": string, "source_ids": string[]}. Keep each text under 180 characters and cite at least one supplied source per item.\n\nEvidence:\n${JSON.stringify(evidence)}`,
    });
    const draft = parseGroundedDraft(
      response.text,
      standupDraftSchema,
      new Set(evidence.map((entry) => entry.source_id)),
      { sectionLimits: { done: 5, in_progress: 5, blocked: 5 } },
    );
    return { draft, generator: 'agent' as const, model: response.model };
  } catch (error) {
    console.error('[standup-automation] Grounded synthesis failed; using fallback:', error);
    return { draft: fallback, generator: 'fallback' as const, model: null };
  }
}

export async function generateDailyStandup(input: {
  orgId: string;
  requestedByUserId?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [org] = await db.select({ name: orgs.name, timezone: orgs.timezone }).from(orgs)
    .where(eq(orgs.id, input.orgId)).limit(1);
  if (!org) throw new Error('Org not found');
  const local = localClockAt(now, org.timezone || 'UTC');
  if (!local) throw new Error(`Invalid org timezone: ${org.timezone}`);

  const claim = await claimAutomationRun({
    orgId: input.orgId,
    kind: 'standup',
    idempotencyKey: standupRunKey(input.orgId, local.dateKey),
    scheduledFor: now,
    context: { date_key: local.dateKey, requested_by: input.requestedByUserId ?? null },
  });
  if (!claim.claimed) {
    const [existing] = claim.run.result_entity_id
      ? await db.select().from(standups).where(eq(standups.id, claim.run.result_entity_id)).limit(1)
      : [];
    return { standup: existing ?? null, run: claim.run, alreadyExisted: true };
  }

  try {
    await updateAutomationRun(claim.run.id, { status: 'gathering_context', startedAt: now });
    const evidence = await gatherStandupEvidence(input.orgId, now);
    const deftyUserId = await ensureDeftyMembership(input.orgId);
    const synthesis = await synthesizeStandup(input.orgId, org.name, deftyUserId, evidence);
    const summary = renderStandupDraft(synthesis.draft);
    const [standup] = await db.insert(standups).values({
      org_id: input.orgId,
      date: now,
      generated_by: deftyUserId,
      summary,
      raw_data: {
        date_key: local.dateKey,
        generator: synthesis.generator,
        model: synthesis.model,
        evidence,
        draft: synthesis.draft,
      },
    }).returning();
    if (!standup) throw new Error('Standup insert returned no row');

    const [defaultSpace] = await db.select({ id: spaces.id }).from(spaces)
      .where(and(eq(spaces.org_id, input.orgId), eq(spaces.is_default, true))).limit(1);
    let messageId: string | null = null;
    if (defaultSpace) {
      await db.insert(spaceMembers).values({ space_id: defaultSpace.id, user_id: deftyUserId })
        .onConflictDoNothing();
      const [message] = await db.insert(messages).values({
        org_id: input.orgId,
        space_id: defaultSpace.id,
        user_id: deftyUserId,
        content: `**Daily standup**\n\n${summary}`,
        metadata: { automation_run_id: claim.run.id, generator: synthesis.generator },
      }).returning();
      messageId = message?.id ?? null;
      if (message) {
        getIO()?.to(`org:${input.orgId}`).emit('message:new', {
          ...message,
          user_name: DEFTY_NAME,
          user_avatar: null,
        });
      }
    }

    const run = await updateAutomationRun(claim.run.id, {
      status: 'delivered',
      generator: synthesis.generator,
      output: { draft: synthesis.draft, model: synthesis.model, message_id: messageId },
      resultEntityId: standup.id,
      completedAt: new Date(),
    });
    return { standup, run, alreadyExisted: false };
  } catch (error) {
    await failAutomationRun(claim.run.id, error);
    throw error;
  }
}
