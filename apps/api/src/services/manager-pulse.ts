// Service: Manager Pulse — generates team health cards, action items, and summary for managers
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';
import { getOrgAIConfig } from '../lib/org-ai-config.js';
import {
  orgMembers,
  users,
  tasks,
  messages,
  peoplePatterns,
  agentNudges,
  managerSettings,
  teamHealthSnapshots,
} from '@deft/db/schema';
import { eq, and, gte, sql, ne, count as drizzleCount, lt } from 'drizzle-orm';
import { getDayBoundaries, getOrgTimezone } from '../lib/task-dates.js';

type HealthStatus = 'green' | 'yellow' | 'red';

interface HealthCard {
  userId: string;
  name: string;
  status: HealthStatus;
  insight: string;
  activeTasks: number;
  overdueTasks: number;
  messageCount: number;
  blockers: string[];
}

interface ActionItem {
  userId: string;
  name: string;
  action: string;
  urgency: 'high' | 'medium' | 'low';
}

export async function generateManagerPulse(
  managerId: string,
  orgId: string,
): Promise<{ healthCards: HealthCard[]; actionItems: ActionItem[]; wins: string[]; summary: string }> {
  // Get manager settings (or defaults)
  const [settings] = await db
    .select()
    .from(managerSettings)
    .where(and(eq(managerSettings.user_id, managerId), eq(managerSettings.org_id, orgId)))
    .limit(1);

  const overloadThreshold = settings?.overload_threshold ?? 6;

  // Get all org members except the manager
  const members = await db
    .select({
      userId: orgMembers.user_id,
      name: users.name,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.user_id, users.id))
    .where(
      and(
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
        ne(orgMembers.user_id, managerId),
      ),
    );

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Org-local start of "today" — anything with a due_date strictly before
  // this instant is overdue in the org's timezone. Computed once per call.
  const orgTz = await getOrgTimezone(orgId);
  const { start: startOfToday } = getDayBoundaries(orgTz, 0, now);

  const healthCards: HealthCard[] = [];
  const actionItems: ActionItem[] = [];
  const wins: string[] = [];

  for (const member of members) {
    // 1. Active tasks count — only "in flight" work (excludes backlog, done, cancelled)
    const [activeTaskRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.assignee_id, member.userId),
          eq(tasks.is_deleted, false),
          sql`${tasks.status} IN ('todo', 'in_progress', 'in_review')`,
        ),
      );
    const activeTasks = Number(activeTaskRow?.count ?? 0);

    // 2. Overdue tasks count
    const [overdueRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.assignee_id, member.userId),
          eq(tasks.is_deleted, false),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          lt(tasks.due_date, startOfToday),
        ),
      );
    const overdueTasks = Number(overdueRow?.count ?? 0);

    // 3. Messages sent yesterday
    const [msgRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.org_id, orgId),
          eq(messages.user_id, member.userId),
          eq(messages.is_deleted, false),
          gte(messages.created_at, yesterday),
        ),
      );
    const messageCount = Number(msgRow?.count ?? 0);

    // 4. People patterns: activity_trend and response_time
    const patterns = await db
      .select()
      .from(peoplePatterns)
      .where(
        and(
          eq(peoplePatterns.org_id, orgId),
          eq(peoplePatterns.user_id, member.userId),
        ),
      );

    const activityTrend = patterns.find((p) => p.pattern_type === 'activity_trend');
    const responseTime = patterns.find((p) => p.pattern_type === 'response_time');

    // 5. Blocked signals — check for stalled nudges in last 24h
    const blockerNudges = await db
      .select({ message: agentNudges.message })
      .from(agentNudges)
      .where(
        and(
          eq(agentNudges.org_id, orgId),
          eq(agentNudges.user_id, member.userId),
          eq(agentNudges.nudge_type, 'stalled'),
          eq(agentNudges.is_dismissed, false),
          gte(agentNudges.created_at, yesterday),
        ),
      );
    const blockers = blockerNudges.map((n) => n.message);

    // 6. Classify health
    let yellowSignals = 0;

    // Response time >2x baseline
    const currentResponseTime = (responseTime?.pattern_data as any)?.current_avg_seconds;
    const baselineResponseTime = (responseTime?.baseline_data as any)?.avg_seconds;
    if (currentResponseTime && baselineResponseTime && currentResponseTime > 2 * baselineResponseTime) {
      yellowSignals++;
    }

    // Activity declining >30%
    const activityCurrent = (activityTrend?.pattern_data as any)?.current_score;
    const activityBaseline = (activityTrend?.baseline_data as any)?.score;
    const activityDeclinePercent =
      activityCurrent != null && activityBaseline != null && activityBaseline > 0
        ? ((activityBaseline - activityCurrent) / activityBaseline) * 100
        : 0;
    if (activityDeclinePercent > 30) {
      yellowSignals++;
    }

    // Overdue tasks
    if (overdueTasks > 0) {
      yellowSignals++;
    }

    // Workload above threshold
    if (activeTasks > overloadThreshold) {
      yellowSignals++;
    }

    let status: HealthStatus;
    if (blockers.length > 0 || yellowSignals >= 2) {
      status = 'red';
    } else if (yellowSignals >= 1) {
      status = 'yellow';
    } else {
      // Check for near-zero activity
      if (messageCount === 0 && activeTasks === 0) {
        status = 'yellow';
      } else {
        status = 'green';
      }
    }

    // Build insight string
    const insights: string[] = [];
    if (blockers.length > 0) insights.push(`Blocked: ${blockers.length} stalled item(s)`);
    if (overdueTasks > 0) insights.push(`${overdueTasks} overdue task(s)`);
    if (activeTasks > overloadThreshold) insights.push(`High workload: ${activeTasks} active tasks`);
    if (activityDeclinePercent > 30) insights.push(`Activity declined ${Math.round(activityDeclinePercent)}% this week`);
    if (currentResponseTime && baselineResponseTime && currentResponseTime > 2 * baselineResponseTime) {
      insights.push('Response time significantly slower than usual');
    }
    if (insights.length === 0) {
      insights.push('On track — normal activity levels');
    }

    const card: HealthCard = {
      userId: member.userId,
      name: member.name,
      status,
      insight: insights.join('. '),
      activeTasks,
      overdueTasks,
      messageCount,
      blockers,
    };

    healthCards.push(card);

    // Track wins — tasks completed this week
    const [completedRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.assignee_id, member.userId),
          eq(tasks.status, 'done'),
          gte(tasks.updated_at, oneWeekAgo),
        ),
      );
    const completedThisWeek = Number(completedRow?.count ?? 0);
    if (completedThisWeek > 0) {
      wins.push(`${member.name} completed ${completedThisWeek} task(s) this week`);
    }
  }

  // --- 3B: Generate action items from health cards ---
  for (const card of healthCards) {
    if (card.status === 'red') {
      if (card.blockers.length > 0) {
        actionItems.push({
          userId: card.userId,
          name: card.name,
          action: `${card.name} is blocked. Consider reassigning or checking in.`,
          urgency: 'high',
        });
      } else {
        actionItems.push({
          userId: card.userId,
          name: card.name,
          action: `${card.name} has multiple warning signals. Schedule a 1:1 check-in.`,
          urgency: 'high',
        });
      }
    }

    if (card.activeTasks > overloadThreshold) {
      actionItems.push({
        userId: card.userId,
        name: card.name,
        action: `${card.name}'s workload (${card.activeTasks} tasks) is above threshold. Redistribute?`,
        urgency: 'medium',
      });
    }

    if (card.insight.includes('Activity declined')) {
      actionItems.push({
        userId: card.userId,
        name: card.name,
        action: `${card.name}'s activity dropped this week. Schedule a check-in?`,
        urgency: 'medium',
      });
    }
  }

  // --- 3C: Generate summary via LLM ---
  let summary: string;
  try {
    const prompt = `You are Deft, an AI workspace assistant helping a manager understand their team's health.

Here are the team health cards:
${JSON.stringify(healthCards, null, 2)}

Here are the suggested action items:
${JSON.stringify(actionItems, null, 2)}

Here are recent wins:
${JSON.stringify(wins, null, 2)}

Write a concise (3-5 sentence) daily team pulse summary for the manager. Highlight:
1. Overall team health (how many green/yellow/red)
2. Top priority action item if any
3. A positive highlight (wins)

Be direct and helpful. Use a warm but professional tone.`;

    const orgConfig = await getOrgAIConfig(orgId);
    const response = await llm({
      task: 'reason',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
      orgConfig,
    });

    summary = response.text || buildFallbackSummary(healthCards, actionItems, wins);
  } catch (err) {
    console.error('[manager-pulse] LLM error, using fallback summary:', err);
    summary = buildFallbackSummary(healthCards, actionItems, wins);
  }

  // Store in teamHealthSnapshots
  await db.insert(teamHealthSnapshots).values({
    org_id: orgId,
    snapshot_date: now,
    team_data: {
      healthCards,
      actionItems,
      wins,
      summary,
      generated_for: managerId,
    },
    generated_by: managerId,
  });

  return { healthCards, actionItems, wins, summary };
}

function buildFallbackSummary(
  healthCards: HealthCard[],
  actionItems: ActionItem[],
  wins: string[],
): string {
  const green = healthCards.filter((c) => c.status === 'green').length;
  const yellow = healthCards.filter((c) => c.status === 'yellow').length;
  const red = healthCards.filter((c) => c.status === 'red').length;

  const lines: string[] = [];
  lines.push(`Team pulse: ${green} on track, ${yellow} need attention, ${red} critical.`);

  if (actionItems.length > 0) {
    lines.push(`Top action: ${actionItems[0]!.action}`);
  }

  if (wins.length > 0) {
    lines.push(`Wins: ${wins[0]}`);
  }

  return lines.join(' ');
}
