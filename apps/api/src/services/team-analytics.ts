// Team Analytics Service — velocity, workload, bottleneck, and skills gap analysis
import { db } from '../lib/db.js';
import {
  tasks,
  taskActivity,
  users,
  orgMembers,
  projects,
  peopleExpertise,
} from '@deft/db/schema';
import { eq, and, sql, gte, lt, inArray } from 'drizzle-orm';
import { visibleTaskCondition } from '../lib/task-visibility.js';

// ─── Velocity Calculator ───

type WeekData = {
  week: string;
  completed: number;
  per_person: Record<string, number>;
};

export async function velocityCalculator(
  orgId: string,
  projectId?: string,
  viewerUserId?: string,
): Promise<{
  weeks: WeekData[];
  trend: 'increasing' | 'stable' | 'declining';
  avg_velocity: number;
}> {
  const now = new Date();
  const weeks: WeekData[] = [];

  for (let i = 3; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const conditions: any[] = [
      eq(taskActivity.action, 'status_changed'),
      sql`${taskActivity.new_value} = 'done'`,
      gte(taskActivity.created_at, weekStart),
      lt(taskActivity.created_at, weekEnd),
    ];

    // Join with tasks to filter by org_id and optionally project_id
    const rows = await db
      .select({
        user_id: taskActivity.user_id,
        user_name: users.name,
        count: sql<number>`count(*)::int`,
      })
      .from(taskActivity)
      .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(taskActivity.user_id, users.id))
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.is_deleted, false),
          eq(projects.is_deleted, false),
          ...(viewerUserId ? [visibleTaskCondition(viewerUserId)] : []),
          ...(projectId ? [eq(tasks.project_id, projectId)] : []),
          ...conditions,
        ),
      )
      .groupBy(taskActivity.user_id, users.name);

    const perPerson: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const name = row.user_name || 'Unknown';
      perPerson[name] = Number(row.count);
      total += Number(row.count);
    }

    weeks.push({
      week: weekStart.toISOString().split('T')[0]!,
      completed: total,
      per_person: perPerson,
    });
  }

  // Calculate trend
  const thisWeek = weeks[3]?.completed ?? 0;
  const priorWeeks = weeks.slice(0, 3);
  const priorAvg =
    priorWeeks.length > 0
      ? priorWeeks.reduce((sum, w) => sum + w.completed, 0) / priorWeeks.length
      : 0;

  const totalAll = weeks.reduce((sum, w) => sum + w.completed, 0);
  const avgVelocity = Math.round((totalAll / weeks.length) * 10) / 10;

  let trend: 'increasing' | 'stable' | 'declining';
  if (priorAvg === 0) {
    trend = thisWeek > 0 ? 'increasing' : 'stable';
  } else {
    const ratio = thisWeek / priorAvg;
    if (ratio > 1.15) trend = 'increasing';
    else if (ratio < 0.85) trend = 'declining';
    else trend = 'stable';
  }

  return { weeks, trend, avg_velocity: avgVelocity };
}

// ─── Workload Analyzer ───

type MemberWorkload = {
  name: string;
  task_count: number;
  weighted_load: number;
  status: 'balanced' | 'overloaded' | 'light';
};

const PRIORITY_WEIGHTS: Record<string, number> = {
  p0: 4,
  p1: 2,
  p2: 1,
  p3: 0.5,
};

export async function workloadAnalyzer(
  orgId: string,
): Promise<{ members: MemberWorkload[]; team_mean: number }> {
  // Get all active members
  const members = await db
    .select({
      userId: orgMembers.user_id,
      name: users.name,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.user_id, users.id))
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)));

  const memberWorkloads: MemberWorkload[] = [];

  for (const member of members) {
    const activeTasks = await db
      .select({
        priority: tasks.priority,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.assignee_id, member.userId),
          eq(tasks.is_deleted, false),
          sql`${tasks.status} IN ('todo', 'in_progress', 'in_review')`,
        ),
      )
      .groupBy(tasks.priority);

    let taskCount = 0;
    let weightedLoad = 0;
    for (const row of activeTasks) {
      const cnt = Number(row.count);
      taskCount += cnt;
      weightedLoad += cnt * (PRIORITY_WEIGHTS[row.priority] ?? 1);
    }

    memberWorkloads.push({
      name: member.name,
      task_count: taskCount,
      weighted_load: Math.round(weightedLoad * 10) / 10,
      status: 'balanced', // will be set after calculating mean
    });
  }

  // Calculate team mean
  const totalLoad = memberWorkloads.reduce((sum, m) => sum + m.weighted_load, 0);
  const teamMean =
    memberWorkloads.length > 0
      ? Math.round((totalLoad / memberWorkloads.length) * 10) / 10
      : 0;

  // Set status based on mean
  for (const m of memberWorkloads) {
    if (teamMean === 0) {
      m.status = 'balanced';
    } else if (m.weighted_load > teamMean * 1.5) {
      m.status = 'overloaded';
    } else if (m.weighted_load < teamMean * 0.5) {
      m.status = 'light';
    } else {
      m.status = 'balanced';
    }
  }

  return {
    members: memberWorkloads.sort((a, b) => b.weighted_load - a.weighted_load),
    team_mean: teamMean,
  };
}

// ─── Bottleneck Detector ───

type BottleneckResult = {
  stuck_in_review: Array<{
    task_id: string;
    title: string;
    assignee: string | null;
    days_in_review: number;
  }>;
  stalled: Array<{
    task_id: string;
    title: string;
    assignee: string | null;
    days_stalled: number;
  }>;
  review_bottlenecks: Array<{ name: string; review_count: number }>;
};

export async function bottleneckDetector(orgId: string): Promise<BottleneckResult> {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  // 1. Tasks in 'in_review' for >2 days
  const reviewTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assignee_name: users.name,
      updated_at: tasks.updated_at,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.status, 'in_review'),
        eq(tasks.is_deleted, false),
        lt(tasks.updated_at, twoDaysAgo),
      ),
    );

  const stuckInReview = reviewTasks.map((t) => ({
    task_id: t.id,
    title: t.title,
    assignee: t.assignee_name,
    days_in_review: Math.floor((now.getTime() - new Date(t.updated_at).getTime()) / 86400000),
  }));

  // 2. Tasks where last activity is >5 days ago (stalled)
  // Subquery: get task_ids with most recent activity older than 5 days
  const stalledRows = await db
    .select({
      task_id: tasks.id,
      title: tasks.title,
      assignee_name: users.name,
      last_activity: sql<Date>`max(${taskActivity.created_at})`,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .leftJoin(taskActivity, eq(tasks.id, taskActivity.task_id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.is_deleted, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    )
    .groupBy(tasks.id, tasks.title, users.name)
    .having(sql`max(${taskActivity.created_at}) < ${fiveDaysAgo} OR max(${taskActivity.created_at}) IS NULL`);

  const stalled = stalledRows
    .filter((r) => {
      // Only include if actually stalled (has been created for > 5 days)
      return true;
    })
    .map((r) => ({
      task_id: r.task_id,
      title: r.title,
      assignee: r.assignee_name,
      days_stalled: r.last_activity
        ? Math.floor((now.getTime() - new Date(r.last_activity).getTime()) / 86400000)
        : 999,
    }));

  // 3. People who are reviewers on 3+ in_review tasks
  // Using assignee_id of in_review tasks as a proxy since there's no dedicated reviewer field
  const reviewerRows = await db
    .select({
      assignee_name: users.name,
      review_count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .innerJoin(users, eq(tasks.assignee_id, users.id))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.status, 'in_review'),
        eq(tasks.is_deleted, false),
      ),
    )
    .groupBy(users.name)
    .having(sql`count(*) >= 3`);

  const reviewBottlenecks = reviewerRows.map((r) => ({
    name: r.assignee_name,
    review_count: Number(r.review_count),
  }));

  return {
    stuck_in_review: stuckInReview,
    stalled,
    review_bottlenecks: reviewBottlenecks,
  };
}

// ─── Skills Gap Analyzer ───

type SkillsGapResult = {
  gaps: Array<{ topic: string; expert_count: 0 }>;
  spof: Array<{ topic: string; expert: string }>;
  well_covered: Array<{ topic: string; expert_count: number }>;
};

const EXPERTISE_THRESHOLD = 5.0;

export async function skillsGapAnalyzer(orgId: string): Promise<SkillsGapResult> {
  // Get all topics and their experts
  const expertiseRows = await db
    .select({
      topic: peopleExpertise.topic,
      user_name: users.name,
      score: peopleExpertise.expertise_score,
    })
    .from(peopleExpertise)
    .innerJoin(users, eq(peopleExpertise.user_id, users.id))
    .where(eq(peopleExpertise.org_id, orgId));

  // Group by topic
  const topicMap = new Map<string, { experts: Array<{ name: string; score: number }> }>();

  for (const row of expertiseRows) {
    if (!topicMap.has(row.topic)) {
      topicMap.set(row.topic, { experts: [] });
    }
    if (row.score >= EXPERTISE_THRESHOLD) {
      topicMap.get(row.topic)!.experts.push({ name: row.user_name, score: row.score });
    }
  }

  const gaps: SkillsGapResult['gaps'] = [];
  const spof: SkillsGapResult['spof'] = [];
  const wellCovered: SkillsGapResult['well_covered'] = [];

  for (const [topic, data] of topicMap) {
    if (data.experts.length === 0) {
      gaps.push({ topic, expert_count: 0 });
    } else if (data.experts.length === 1) {
      spof.push({ topic, expert: data.experts[0]!.name });
    } else {
      wellCovered.push({ topic, expert_count: data.experts.length });
    }
  }

  return { gaps, spof, well_covered: wellCovered };
}
