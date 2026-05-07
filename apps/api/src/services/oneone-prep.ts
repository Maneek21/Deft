// Service: 1:1 Prep — generates preparation material for manager-report 1:1 meetings
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';
import { getOrgAIConfig } from '../lib/org-ai-config.js';
import {
  tasks,
  messages,
  spaces,
  users,
  peoplePatterns,
  peopleInteractions,
  peopleRelationships,
  wikiPages,
  oneonePreps,
} from '@deft/db/schema';
import { eq, and, gte, sql, desc, lt } from 'drizzle-orm';
import { getDayBoundaries, getOrgTimezone } from '../lib/task-dates.js';

export async function generateOneOnePrep(
  managerId: string,
  reportId: string,
  orgId: string,
): Promise<{ prep: any }> {
  // Determine the lookback window: since last prep or 14 days
  const [lastPrep] = await db
    .select()
    .from(oneonePreps)
    .where(
      and(
        eq(oneonePreps.org_id, orgId),
        eq(oneonePreps.manager_id, managerId),
        eq(oneonePreps.report_id, reportId),
      ),
    )
    .orderBy(desc(oneonePreps.created_at))
    .limit(1);

  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const sinceDate = lastPrep?.created_at ?? fourteenDaysAgo;

  // Org-local start of "today" for the overdue filter below — `due_date <
  // NOW()` would incorrectly flag tasks as overdue based on UTC rollover.
  const orgTz = await getOrgTimezone(orgId);
  const { start: startOfToday } = getDayBoundaries(orgTz, 0, now);

  // Get report user info
  const [reportUser] = await db
    .select({ name: users.name, title: users.title })
    .from(users)
    .where(eq(users.id, reportId))
    .limit(1);

  const reportName = reportUser?.name ?? 'Team member';

  // --- 4B: Data Collection ---

  // Tasks completed
  const completedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      number: tasks.number,
      updated_at: tasks.updated_at,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, reportId),
        eq(tasks.status, 'done'),
        eq(tasks.is_deleted, false),
        gte(tasks.updated_at, sinceDate),
      ),
    );

  // Tasks in progress
  const inProgressTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      number: tasks.number,
      due_date: tasks.due_date,
      priority: tasks.priority,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, reportId),
        eq(tasks.status, 'in_progress'),
        eq(tasks.is_deleted, false),
      ),
    );

  // Tasks overdue
  const overdueTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      number: tasks.number,
      due_date: tasks.due_date,
      priority: tasks.priority,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, reportId),
        eq(tasks.is_deleted, false),
        lt(tasks.due_date, startOfToday),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    );

  // Messages sent (count and top spaces)
  const messagesBySpace = await db
    .select({
      spaceName: spaces.name,
      spaceId: spaces.id,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(spaces, eq(messages.space_id, spaces.id))
    .where(
      and(
        eq(messages.org_id, orgId),
        eq(messages.user_id, reportId),
        eq(messages.is_deleted, false),
        gte(messages.created_at, sinceDate),
      ),
    )
    .groupBy(spaces.name, spaces.id)
    .orderBy(sql`count(*) DESC`)
    .limit(5);

  const totalMessages = messagesBySpace.reduce((sum, s) => sum + Number(s.count), 0);

  // People patterns
  const patterns = await db
    .select()
    .from(peoplePatterns)
    .where(
      and(
        eq(peoplePatterns.org_id, orgId),
        eq(peoplePatterns.user_id, reportId),
      ),
    );

  const activityTrend = patterns.find((p) => p.pattern_type === 'activity_trend');
  const responseTimePattern = patterns.find((p) => p.pattern_type === 'response_time');
  const activeHoursPattern = patterns.find((p) => p.pattern_type === 'active_hours');

  // People interactions — who they collaborated with most
  const interactions = await db
    .select({
      otherUserId: sql<string>`CASE WHEN ${peopleInteractions.user_a_id} = ${reportId} THEN ${peopleInteractions.user_b_id} ELSE ${peopleInteractions.user_a_id} END`,
      interactionCount: peopleInteractions.interaction_count,
      score: peopleInteractions.recency_weighted_score,
    })
    .from(peopleInteractions)
    .where(
      and(
        eq(peopleInteractions.org_id, orgId),
        sql`(${peopleInteractions.user_a_id} = ${reportId} OR ${peopleInteractions.user_b_id} = ${reportId})`,
      ),
    )
    .orderBy(desc(peopleInteractions.recency_weighted_score))
    .limit(5);

  // Resolve collaborator names
  const collaboratorIds = interactions.map((i) => i.otherUserId);
  const collaborators: { name: string; interactionCount: number }[] = [];
  for (const colId of collaboratorIds) {
    const [colUser] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, colId))
      .limit(1);
    const interaction = interactions.find((i) => i.otherUserId === colId);
    if (colUser) {
      collaborators.push({
        name: colUser.name,
        interactionCount: Number(interaction?.interactionCount ?? 0),
      });
    }
  }

  // People relationships — any tension or mentoring signals
  const relationships = await db
    .select()
    .from(peopleRelationships)
    .where(
      and(
        eq(peopleRelationships.org_id, orgId),
        sql`(${peopleRelationships.user_a_id} = ${reportId} OR ${peopleRelationships.user_b_id} = ${reportId})`,
        sql`${peopleRelationships.relationship_type} IN ('tension', 'mentor_mentee')`,
      ),
    );

  // Commitments — read from wiki_pages tagged 'commitment' that reference the report
  const commitmentPages = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      content: wikiPages.content,
      summary: wikiPages.summary,
      created_at: wikiPages.created_at,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.org_id, orgId),
        eq(wikiPages.is_deleted, false),
        sql`${wikiPages.tags} @> ARRAY['commitment']::text[]`,
        sql`${wikiPages.referenced_user_ids} @> ARRAY[${reportId}]::text[]`,
      ),
    )
    .orderBy(desc(wikiPages.created_at))
    .limit(10);

  // Map to the shape the rest of the function expects (value = content summary)
  const commitments = commitmentPages.map((p) => ({
    key: p.title,
    value: p.summary ?? p.content.slice(0, 200),
  }));

  // --- 4C: Prep Generation ---
  const collectedData = {
    reportName,
    reportTitle: reportUser?.title ?? null,
    periodSince: sinceDate.toISOString().split('T')[0],
    completedTasks: completedTasks.map((t) => ({ title: t.title, number: t.number })),
    inProgressTasks: inProgressTasks.map((t) => ({
      title: t.title,
      number: t.number,
      due_date: t.due_date?.toISOString().split('T')[0] ?? null,
      priority: t.priority,
    })),
    overdueTasks: overdueTasks.map((t) => ({
      title: t.title,
      number: t.number,
      due_date: t.due_date?.toISOString().split('T')[0] ?? null,
      priority: t.priority,
    })),
    totalMessages,
    topSpaces: messagesBySpace.map((s) => ({ name: s.spaceName, count: s.count })),
    activityTrend: activityTrend?.pattern_data ?? null,
    responseTime: {
      current: responseTimePattern?.pattern_data ?? null,
      baseline: responseTimePattern?.baseline_data ?? null,
    },
    activeHours: {
      current: activeHoursPattern?.pattern_data ?? null,
      baseline: activeHoursPattern?.baseline_data ?? null,
    },
    topCollaborators: collaborators,
    relationships: relationships.map((r) => ({
      type: r.relationship_type,
      strength: r.strength,
      direction: r.direction,
    })),
    commitments: commitments.map((c) => ({ key: c.key, value: c.value })),
  };

  let prepContent: any;
  try {
    const prompt = `You are Deft, an AI workspace assistant. Generate a 1:1 meeting prep for a manager about to meet with ${reportName}.

Here is the data collected since their last 1:1 (${collectedData.periodSince}):

${JSON.stringify(collectedData, null, 2)}

Generate a structured prep with these sections:
1. **Summary**: 2-3 sentence overview of how ${reportName} is doing
2. **Wins**: What they accomplished (completed tasks, contributions)
3. **Current Focus**: What they're working on now (in-progress tasks)
4. **Concerns**: Any overdue tasks, workload issues, relationship tensions, or pattern changes
5. **Talking Points**: 3-5 suggested conversation starters or questions to ask
6. **Commitments to Follow Up**: Any prior commitments to check on

Be specific, reference task titles and numbers. Be supportive in tone — this is meant to help the manager have a productive conversation.

Return the response as valid JSON with keys: summary, wins, currentFocus, concerns, talkingPoints, commitments.`;

    const orgConfig = await getOrgAIConfig(orgId);
    const response = await llm({
      task: 'reason',
      messages: [{ role: 'user', content: prompt }],
      system: 'You must respond with valid JSON only. No markdown, no code fences.',
      maxTokens: 1500,
      orgConfig,
    });

    try {
      prepContent = JSON.parse(response.text);
    } catch {
      // If LLM didn't return valid JSON, wrap the text
      prepContent = {
        summary: response.text,
        wins: completedTasks.map((t) => `Completed: ${t.title}`),
        currentFocus: inProgressTasks.map((t) => t.title),
        concerns: overdueTasks.map((t) => `Overdue: ${t.title}`),
        talkingPoints: ['How are you feeling about your current workload?', 'Any blockers I can help with?'],
        commitments: commitments.map((c) => c.value),
      };
    }
  } catch (err) {
    console.error('[oneone-prep] LLM error, using fallback:', err);
    prepContent = {
      summary: `${reportName} completed ${completedTasks.length} tasks, has ${inProgressTasks.length} in progress, and ${overdueTasks.length} overdue since ${collectedData.periodSince}.`,
      wins: completedTasks.map((t) => `Completed: ${t.title} (#${t.number})`),
      currentFocus: inProgressTasks.map((t) => `${t.title} (#${t.number}) — ${t.priority}`),
      concerns: overdueTasks.map((t) => `Overdue: ${t.title} (#${t.number})`),
      talkingPoints: [
        'How are you feeling about your current workload?',
        'Any blockers I can help with?',
        'What would you like to focus on next?',
      ],
      commitments: commitments.map((c) => c.value),
    };
  }

  // Add raw data context to prep
  prepContent.rawData = {
    periodSince: collectedData.periodSince,
    totalMessages,
    topCollaborators: collaborators,
    activityTrend: collectedData.activityTrend,
  };

  // --- 4D: Storage ---
  const [inserted] = await db
    .insert(oneonePreps)
    .values({
      org_id: orgId,
      manager_id: managerId,
      report_id: reportId,
      meeting_date: now,
      prep_content: prepContent,
      status: 'generated',
    })
    .returning();

  return { prep: { id: inserted!.id, ...prepContent } };
}
