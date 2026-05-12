// Service: Weekly Digest — generates a comprehensive weekly summary for managers
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';
import { getOrgAIConfig } from '../lib/org-ai-config.js';
import {
  tasks,
  taskActivity,
  wikiPages,
  agentNudges,
  burnoutAlerts,
  users,
  projects,
} from '@deft/db/schema';
import { eq, and, gte, sql, lt, desc } from 'drizzle-orm';
import { velocityCalculator, workloadAnalyzer } from './team-analytics.js';

export async function generateWeeklyDigest(
  managerId: string,
  orgId: string,
): Promise<string> {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. Team velocity this week vs last 4 weeks
  const velocity = await velocityCalculator(orgId);

  // 2. Tasks completed this week
  const [completedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskActivity)
    .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        eq(taskActivity.action, 'status_changed'),
        sql`${taskActivity.new_value} = 'done'`,
        gte(taskActivity.created_at, oneWeekAgo),
      ),
    );
  const completedCount = Number(completedRow?.count ?? 0);

  // 3. Tasks created this week
  const [createdRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        gte(tasks.created_at, oneWeekAgo),
      ),
    );
  const createdCount = Number(createdRow?.count ?? 0);

  // 4. Overdue tasks
  const [overdueRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
        lt(tasks.due_date, now),
      ),
    );
  const overdueCount = Number(overdueRow?.count ?? 0);

  // 5. Decisions made this week (sourced from wiki_pages WHERE type='decision').
  //    The legacy `decisions` table was retired 2026-05-12. wikiPages.user_id is
  //    nullable (agent-authored pages have no human author), so we left-join.
  const weekDecisions = await db
    .select({
      decision_text: wikiPages.title,
      decided_by_name: users.name,
    })
    .from(wikiPages)
    .leftJoin(users, eq(wikiPages.user_id, users.id))
    .where(
      and(
        eq(wikiPages.org_id, orgId),
        eq(wikiPages.type, 'decision'),
        eq(wikiPages.is_deleted, false),
        gte(wikiPages.created_at, oneWeekAgo),
      ),
    )
    .orderBy(desc(wikiPages.created_at))
    .limit(10);

  // 6. Blockers — open/resolved nudges
  const [openBlockersRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentNudges)
    .where(
      and(
        eq(agentNudges.org_id, orgId),
        eq(agentNudges.is_dismissed, false),
      ),
    );
  const openBlockers = Number(openBlockersRow?.count ?? 0);

  const [resolvedBlockersRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentNudges)
    .where(
      and(
        eq(agentNudges.org_id, orgId),
        eq(agentNudges.is_dismissed, true),
        gte(agentNudges.updated_at, oneWeekAgo),
      ),
    );
  const resolvedBlockers = Number(resolvedBlockersRow?.count ?? 0);

  // 7. Notable wins — recently completed high-priority tasks
  const notableWins = await db
    .select({
      title: tasks.title,
      number: tasks.number,
      prefix: projects.prefix,
      assignee: users.name,
    })
    .from(taskActivity)
    .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        eq(taskActivity.action, 'status_changed'),
        sql`${taskActivity.new_value} = 'done'`,
        gte(taskActivity.created_at, oneWeekAgo),
        sql`${tasks.priority} IN ('p0', 'p1')`,
      ),
    )
    .limit(5);

  // 8. Risks — workload imbalances, burnout alerts
  const workload = await workloadAnalyzer(orgId);
  const overloadedMembers = workload.members.filter((m) => m.status === 'overloaded');

  const activeBurnoutAlerts = await db
    .select({
      user_name: users.name,
      confidence: burnoutAlerts.confidence,
    })
    .from(burnoutAlerts)
    .innerJoin(users, eq(burnoutAlerts.user_id, users.id))
    .where(
      and(
        eq(burnoutAlerts.org_id, orgId),
        eq(burnoutAlerts.status, 'active'),
      ),
    );

  // Build the data for the LLM
  const digestData = {
    velocity: {
      this_week: velocity.weeks[3]?.completed ?? 0,
      avg_prior_weeks: velocity.avg_velocity,
      trend: velocity.trend,
    },
    tasks: {
      completed: completedCount,
      created: createdCount,
      overdue: overdueCount,
    },
    decisions: weekDecisions.map((d) => ({
      decision: d.decision_text,
      by: d.decided_by_name,
    })),
    blockers: {
      open: openBlockers,
      resolved_this_week: resolvedBlockers,
    },
    notable_wins: notableWins.map(
      (w) => `${w.prefix}-${w.number}: ${w.title} (${w.assignee || 'unassigned'})`,
    ),
    risks: {
      overloaded_members: overloadedMembers.map((m) => m.name),
      burnout_alerts: activeBurnoutAlerts.map((a) => ({
        person: a.user_name,
        confidence: a.confidence,
      })),
    },
  };

  // Generate digest with LLM
  try {
    const orgConfig = await getOrgAIConfig(orgId);
    const response = await llm({
      task: 'reason',
      orgConfig,
      system: `You are a management assistant writing a weekly team digest. Write a clear, scannable summary in markdown format. Structure it as:

## Weekly Digest

### Velocity
Brief note on trend.

### Wins
Bullet list of notable accomplishments.

### Decisions
Key decisions made this week.

### Risks & Blockers
Items needing attention.

### Recommendations
2-3 specific actions the manager should take.

Keep it under 400 words. Be direct and actionable.`,
      messages: [
        {
          role: 'user',
          content: `Generate the weekly digest from this data:\n${JSON.stringify(digestData, null, 2)}`,
        },
      ],
      maxTokens: 800,
    });

    return response.text || generateFallbackDigest(digestData);
  } catch {
    return generateFallbackDigest(digestData);
  }
}

function generateFallbackDigest(data: any): string {
  const lines: string[] = [];
  lines.push('## Weekly Digest\n');

  lines.push('### Velocity');
  lines.push(
    `- ${data.tasks.completed} tasks completed this week (trend: ${data.velocity.trend})`,
  );
  lines.push(`- ${data.tasks.created} new tasks created`);
  if (data.tasks.overdue > 0) {
    lines.push(`- **${data.tasks.overdue} tasks overdue**`);
  }
  lines.push('');

  if (data.notable_wins.length > 0) {
    lines.push('### Wins');
    for (const win of data.notable_wins) {
      lines.push(`- ${win}`);
    }
    lines.push('');
  }

  if (data.decisions.length > 0) {
    lines.push('### Decisions');
    for (const d of data.decisions.slice(0, 5)) {
      lines.push(`- ${d.decision} (by ${d.by ?? 'agent'})`);
    }
    lines.push('');
  }

  if (data.blockers.open > 0 || data.risks.overloaded_members.length > 0) {
    lines.push('### Risks & Blockers');
    if (data.blockers.open > 0) {
      lines.push(`- ${data.blockers.open} open blocker(s)`);
    }
    if (data.risks.overloaded_members.length > 0) {
      lines.push(`- Overloaded: ${data.risks.overloaded_members.join(', ')}`);
    }
    if (data.risks.burnout_alerts.length > 0) {
      lines.push(`- ${data.risks.burnout_alerts.length} burnout alert(s) active`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
