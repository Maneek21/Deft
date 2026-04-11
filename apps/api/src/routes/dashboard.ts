import { Hono } from 'hono';
import { eq, and, desc, sql, lt, gte, inArray, count } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, projects, users, spaces, spaceMembers, messages, taskActivity, notifications, events, standups, orgs, peopleExpertise, peopleInteractions, peoplePatterns, agentActions } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { getIO } from '../socket.js';

export const dashboardRoutes = new Hono();

// GET /api/dashboard — all dashboard data in one call
dashboardRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);
    const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);

    // 1. Tasks due today (assigned to me)
    const dueToday = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority, due_date: tasks.due_date,
      project_name: projects.name, project_prefix: projects.prefix, project_color: projects.color,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.assignee_id, user.id),
        eq(tasks.is_deleted, false),
        eq(tasks.org_id, user.org_id),
        gte(tasks.due_date, todayStart),
        lt(tasks.due_date, todayEnd),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ))
      .orderBy(tasks.priority);

    // 2. Tasks due this week (assigned to me, excluding today)
    const dueThisWeek = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority, due_date: tasks.due_date,
      project_name: projects.name, project_prefix: projects.prefix, project_color: projects.color,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.assignee_id, user.id),
        eq(tasks.is_deleted, false),
        eq(tasks.org_id, user.org_id),
        gte(tasks.due_date, todayEnd),
        lt(tasks.due_date, weekEnd),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ))
      .orderBy(tasks.due_date, tasks.priority);

    // 3. Overdue tasks (assigned to me)
    const overdue = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority, due_date: tasks.due_date,
      project_name: projects.name, project_prefix: projects.prefix, project_color: projects.color,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.assignee_id, user.id),
        eq(tasks.is_deleted, false),
        eq(tasks.org_id, user.org_id),
        lt(tasks.due_date, todayStart),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ))
      .orderBy(tasks.priority);

    // 4. In-progress tasks (assigned to me)
    const inProgress = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority, due_date: tasks.due_date,
      updated_at: tasks.updated_at,
      project_name: projects.name, project_prefix: projects.prefix, project_color: projects.color,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.assignee_id, user.id),
        eq(tasks.status, 'in_progress'),
        eq(tasks.is_deleted, false),
        eq(tasks.org_id, user.org_id),
      ))
      .orderBy(tasks.priority);

    // 5. Spaces with unread — get user's spaces and last_read info
    const userSpaces = await db.select({
      space_id: spaceMembers.space_id,
      last_read_at: spaceMembers.last_read_at,
      space_name: spaces.name,
      space_type: spaces.type,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
      .where(and(
        eq(spaceMembers.user_id, user.id),
        eq(spaces.org_id, user.org_id),
        eq(spaces.is_archived, false),
      ));

    // For each space, count messages after last_read_at and get last message
    const unreadSpaces = [];
    for (const s of userSpaces) {
      const lastRead = s.last_read_at || new Date(0);
      const [countResult] = await db.select({
        count: sql<number>`count(*)::int`,
      })
        .from(messages)
        .where(and(
          eq(messages.space_id, s.space_id),
          sql`${messages.created_at} > ${lastRead}`,
          eq(messages.is_deleted, false),
          sql`${messages.user_id} != ${user.id}`,
        ));

      const unreadCount = countResult?.count || 0;
      if (unreadCount > 0) {
        const [lastMsg] = await db.select({
          content: messages.content,
          user_name: users.name,
          created_at: messages.created_at,
        })
          .from(messages)
          .innerJoin(users, eq(messages.user_id, users.id))
          .where(and(eq(messages.space_id, s.space_id), eq(messages.is_deleted, false)))
          .orderBy(desc(messages.created_at))
          .limit(1);

        unreadSpaces.push({
          space_id: s.space_id,
          space_name: s.space_name,
          space_type: s.space_type,
          unread_count: unreadCount,
          last_message: lastMsg?.content?.slice(0, 80) || null,
          last_message_by: lastMsg?.user_name || null,
          last_message_at: lastMsg?.created_at || null,
        });
      }
    }
    unreadSpaces.sort((a, b) => {
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });

    // 6. Recent activity (last 15 items relevant to me)
    const recentActivity = await db.select({
      id: taskActivity.id,
      action: taskActivity.action,
      field: taskActivity.field,
      old_value: taskActivity.old_value,
      new_value: taskActivity.new_value,
      created_at: taskActivity.created_at,
      user_name: users.name,
      task_id: taskActivity.task_id,
    })
      .from(taskActivity)
      .leftJoin(users, eq(taskActivity.user_id, users.id))
      .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
      .where(and(
        eq(tasks.org_id, user.org_id),
        eq(tasks.is_deleted, false),
      ))
      .orderBy(desc(taskActivity.created_at))
      .limit(15);

    // Add task info to activity
    const actTaskIds = [...new Set(recentActivity.map(a => a.task_id))];
    const actTasks = actTaskIds.length > 0
      ? await db.select({
          id: tasks.id, number: tasks.number, title: tasks.title,
          project_prefix: projects.prefix,
        })
          .from(tasks)
          .innerJoin(projects, eq(tasks.project_id, projects.id))
          .where(inArray(tasks.id, actTaskIds))
      : [];
    const taskMap = new Map(actTasks.map(t => [t.id, t]));

    const activity = recentActivity.map(a => ({
      ...a,
      task_number: taskMap.get(a.task_id)?.number,
      task_title: taskMap.get(a.task_id)?.title,
      task_prefix: taskMap.get(a.task_id)?.project_prefix,
    }));

    // 7. My projects with stats
    const myProjects = await db.select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      color: projects.color,
      icon: projects.icon,
      task_counter: projects.task_counter,
    })
      .from(projects)
      .where(and(
        eq(projects.org_id, user.org_id),
        eq(projects.is_archived, false),
      ));

    const projectStats = [];
    for (const p of myProjects) {
      const [total] = await db.select({ count: sql<number>`count(*)::int` })
        .from(tasks).where(and(eq(tasks.project_id, p.id), eq(tasks.is_deleted, false)));
      const [done] = await db.select({ count: sql<number>`count(*)::int` })
        .from(tasks).where(and(eq(tasks.project_id, p.id), eq(tasks.is_deleted, false), eq(tasks.status, 'done')));
      const [myCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(tasks).where(and(eq(tasks.project_id, p.id), eq(tasks.is_deleted, false), eq(tasks.assignee_id, user.id)));

      projectStats.push({
        ...p,
        total_tasks: total?.count || 0,
        done_tasks: done?.count || 0,
        my_tasks: myCount?.count || 0,
      });
    }

    // 8. Unread notification count
    const [notifCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.user_id, user.id), eq(notifications.is_read, false)));

    // 9. Today's standup
    let standup: { summary: string; date: string } | null = null;
    try {
      const [todayStandup] = await db
        .select({ summary: standups.summary, date: standups.date })
        .from(standups)
        .where(
          and(
            eq(standups.org_id, user.org_id),
            gte(standups.date, todayStart),
            lt(standups.date, todayEnd),
          ),
        )
        .orderBy(desc(standups.created_at))
        .limit(1);

      if (todayStandup) {
        standup = {
          summary: todayStandup.summary,
          date: todayStandup.date.toISOString(),
        };
      }
    } catch {}

    // 10. Calendar events for today (if connected)
    let calendarEvents: any[] = [];
    try {
      calendarEvents = await db.select({
        id: events.id, title: events.title, url: events.url,
        timestamp: events.timestamp, metadata: events.metadata,
      })
        .from(events)
        .where(and(
          eq(events.user_id, user.id),
          eq(events.source, 'google_calendar'),
          eq(events.event_type, 'calendar_event'),
          gte(events.timestamp, todayStart),
          lt(events.timestamp, todayEnd),
        ))
        .orderBy(events.timestamp)
        .limit(10);
    } catch {}

    // 11. GitHub activity (last 24h)
    let githubActivity: any[] = [];
    try {
      const yesterday = new Date(now.getTime() - 86400000);
      githubActivity = await db.select({
        id: events.id, title: events.title, event_type: events.event_type,
        url: events.url, actor: events.actor, timestamp: events.timestamp,
        metadata: events.metadata,
      })
        .from(events)
        .where(and(
          eq(events.org_id, user.org_id),
          eq(events.source, 'github'),
          gte(events.timestamp, yesterday),
        ))
        .orderBy(desc(events.timestamp))
        .limit(10);
    } catch {}

    return c.json({
      greeting: getGreeting(),
      date: now.toISOString(),
      standup,
      due_today: dueToday,
      due_this_week: dueThisWeek,
      overdue,
      in_progress: inProgress,
      unread_spaces: unreadSpaces.slice(0, 8),
      recent_activity: activity,
      projects: projectStats,
      unread_notifications: notifCount?.count || 0,
      calendar_events: calendarEvents,
      github_activity: githubActivity,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return c.json({ error: 'Failed to load dashboard', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/dashboard/standup — generate standup for current user's org immediately
dashboardRoutes.post('/standup', async (c) => {
  try {
    const user = c.get('user');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);

    // Check if standup already exists for today
    const [existing] = await db
      .select({ id: standups.id })
      .from(standups)
      .where(
        and(
          eq(standups.org_id, user.org_id),
          gte(standups.date, todayStart),
          lt(standups.date, todayEnd),
        ),
      )
      .limit(1);

    if (existing) {
      // Return existing standup
      const [todayStandup] = await db
        .select({ summary: standups.summary, date: standups.date })
        .from(standups)
        .where(eq(standups.id, existing.id));

      return c.json({
        standup: {
          summary: todayStandup?.summary ?? '',
          date: todayStandup?.date?.toISOString() ?? new Date().toISOString(),
        },
        already_existed: true,
      });
    }

    // Get org info
    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, user.org_id))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Org not found', code: 'NOT_FOUND' }, 404);
    }

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Gather activity data (same logic as standup-generate handler)
    const statusChanges = await db
      .select({
        action: taskActivity.action,
        field: taskActivity.field,
        old_value: taskActivity.old_value,
        new_value: taskActivity.new_value,
        task_title: tasks.title,
        task_number: tasks.number,
      })
      .from(taskActivity)
      .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
      .where(
        and(
          eq(tasks.org_id, user.org_id),
          gte(taskActivity.created_at, yesterday),
        ),
      );

    const newTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        status: tasks.status,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, user.org_id),
          eq(tasks.is_deleted, false),
          gte(tasks.created_at, yesterday),
        ),
      );

    const messagesBySpace = await db
      .select({
        space_name: spaces.name,
        msg_count: sql<number>`count(*)`,
      })
      .from(messages)
      .innerJoin(spaces, eq(messages.space_id, spaces.id))
      .where(
        and(
          eq(messages.org_id, user.org_id),
          eq(messages.is_deleted, false),
          gte(messages.created_at, yesterday),
        ),
      )
      .groupBy(spaces.name);

    const [activeUsersRow] = await db
      .select({
        count: sql<number>`count(distinct ${messages.user_id})`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.org_id, user.org_id),
          eq(messages.is_deleted, false),
          gte(messages.created_at, yesterday),
        ),
      );
    const activeUsers = Number(activeUsersRow?.count ?? 0);

    const completedCount = statusChanges.filter(
      (sc) => sc.field === 'status' && sc.new_value === 'done',
    ).length;

    const [overdueRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.org_id, user.org_id),
          eq(tasks.is_deleted, false),
          sql`${tasks.due_date} < now()`,
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
        ),
      );
    const overdueCount = Number(overdueRow?.count ?? 0);

    const rawData = {
      status_changes: statusChanges,
      new_tasks: newTasks,
      messages_by_space: messagesBySpace,
      active_users: activeUsers,
      completed_count: completedCount,
      overdue_count: overdueCount,
    };

    // Generate summary
    let summary: string;
    let model: string | undefined;

    if (env.ANTHROPIC_API_KEY) {
      try {
        const { llm } = await import('../lib/llm.js');

        const dataForPrompt = JSON.stringify(rawData, null, 2);
        const response = await llm({
          task: 'summarize',
          messages: [
            {
              role: 'user',
              content: `Generate a brief daily standup. Use this format exactly:\n\n**Done:** 2-3 bullet points of completed work\n**In Progress:** 2-3 bullet points of active work with owner names\n**Blocked/Overdue:** only if any exist, 1-2 bullets\n\nKeep it under 100 words. No headers, no emojis, no filler. Just the bullets.\n\nData:\n${dataForPrompt}`,
            },
          ],
          maxTokens: 400,
        });

        summary = response.text || generateFallbackStandupSummary(rawData);
        model = response.model;
      } catch (err) {
        console.error(`[dashboard/standup] LLM API error:`, err);
        summary = generateFallbackStandupSummary(rawData);
      }
    } else {
      summary = generateFallbackStandupSummary(rawData);
    }

    // Insert standup
    await db.insert(standups).values({
      org_id: user.org_id,
      date: now,
      generated_by: user.id,
      summary,
      raw_data: rawData,
    });

    // Post to default space
    const [defaultSpace] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.org_id, user.org_id),
          eq(spaces.is_default, true),
        ),
      )
      .limit(1);

    if (defaultSpace) {
      const [msg] = await db
        .insert(messages)
        .values({
          org_id: user.org_id,
          space_id: defaultSpace.id,
          user_id: 'system',
          content: `**Daily Standup Summary**\n\n${summary}`,
        })
        .returning();

      if (msg) {
        const io = getIO();
        if (io) {
          io.to(`org:${user.org_id}`).emit('message:new', {
            ...msg,
            user_name: 'Deft',
            user_avatar: null,
          });
        }
      }
    }

    return c.json({
      standup: { summary, date: now.toISOString(), model: model || null },
      already_existed: false,
    });
  } catch (err) {
    console.error('Standup generation error:', err);
    return c.json({ error: 'Failed to generate standup', code: 'INTERNAL_ERROR' }, 500);
  }
});

function generateFallbackStandupSummary(rawData: {
  status_changes: any[];
  new_tasks: any[];
  messages_by_space: any[];
  active_users: number;
  completed_count: number;
  overdue_count: number;
}): string {
  const lines: string[] = [];

  lines.push(`**Activity in the last 24 hours:**`);
  lines.push('');

  if (rawData.completed_count > 0) {
    lines.push(`- ${rawData.completed_count} task(s) completed`);
  }

  if (rawData.new_tasks.length > 0) {
    lines.push(`- ${rawData.new_tasks.length} new task(s) created`);
  }

  if (rawData.status_changes.length > 0) {
    lines.push(`- ${rawData.status_changes.length} task update(s)`);
  }

  const totalMessages = rawData.messages_by_space.reduce(
    (sum: number, s: any) => sum + Number(s.msg_count),
    0,
  );
  if (totalMessages > 0) {
    lines.push(`- ${totalMessages} message(s) across ${rawData.messages_by_space.length} space(s)`);
  }

  lines.push(`- ${rawData.active_users} active contributor(s)`);

  if (rawData.overdue_count > 0) {
    lines.push('');
    lines.push(`**Attention:** ${rawData.overdue_count} task(s) are overdue.`);
  }

  if (lines.length <= 2) {
    lines.push('- No significant activity recorded.');
  }

  return lines.join('\n');
}

// GET /api/dashboard/my-insights — personal insights for the current user
dashboardRoutes.get('/my-insights', async (c) => {
  try {
    const user = c.get('user');
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

    // 1. Activity this week: messages sent
    const [msgCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(
        eq(messages.org_id, user.org_id),
        eq(messages.user_id, user.id),
        eq(messages.is_deleted, false),
        gte(messages.created_at, oneWeekAgo),
      ));
    const messagesSent = Number(msgCountRow?.count ?? 0);

    // 2. Tasks completed this week
    const [completedRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(taskActivity)
      .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
      .where(and(
        eq(tasks.org_id, user.org_id),
        eq(taskActivity.user_id, user.id),
        eq(taskActivity.action, 'status_changed'),
        sql`${taskActivity.new_value} = 'done'`,
        gte(taskActivity.created_at, oneWeekAgo),
      ));
    const tasksCompleted = Number(completedRow?.count ?? 0);

    // 3. Spaces active in this week
    const activeSpaces = await db
      .select({ space_name: spaces.name })
      .from(messages)
      .innerJoin(spaces, eq(messages.space_id, spaces.id))
      .where(and(
        eq(messages.org_id, user.org_id),
        eq(messages.user_id, user.id),
        eq(messages.is_deleted, false),
        gte(messages.created_at, oneWeekAgo),
      ))
      .groupBy(spaces.name);

    // 4. Expertise areas
    const expertise = await db
      .select({
        topic: peopleExpertise.topic,
        score: peopleExpertise.expertise_score,
      })
      .from(peopleExpertise)
      .where(and(
        eq(peopleExpertise.org_id, user.org_id),
        eq(peopleExpertise.user_id, user.id),
      ))
      .orderBy(desc(peopleExpertise.expertise_score))
      .limit(10);

    // 5. Top collaborators
    const interactions = await db
      .select({
        other_id: sql<string>`CASE WHEN ${peopleInteractions.user_a_id} = ${user.id} THEN ${peopleInteractions.user_b_id} ELSE ${peopleInteractions.user_a_id} END`,
        score: peopleInteractions.recency_weighted_score,
        interaction_count: peopleInteractions.interaction_count,
      })
      .from(peopleInteractions)
      .where(and(
        eq(peopleInteractions.org_id, user.org_id),
        sql`(${peopleInteractions.user_a_id} = ${user.id} OR ${peopleInteractions.user_b_id} = ${user.id})`,
      ))
      .orderBy(desc(peopleInteractions.recency_weighted_score))
      .limit(5);

    // Resolve collaborator names
    const collaborators: Array<{ name: string; score: number; interactions: number }> = [];
    for (const i of interactions) {
      const [colUser] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, i.other_id))
        .limit(1);
      if (colUser) {
        collaborators.push({
          name: colUser.name,
          score: i.score,
          interactions: Number(i.interaction_count),
        });
      }
    }

    // 6. Work patterns
    const patterns = await db
      .select({
        pattern_type: peoplePatterns.pattern_type,
        pattern_data: peoplePatterns.pattern_data,
      })
      .from(peoplePatterns)
      .where(and(
        eq(peoplePatterns.org_id, user.org_id),
        eq(peoplePatterns.user_id, user.id),
      ));

    // 7. Pace — tasks completed per week for last 4 weeks
    const pace: Array<{ week: string; completed: number }> = [];
    for (let i = 3; i >= 0; i--) {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const [weekRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .where(and(
          eq(tasks.org_id, user.org_id),
          eq(taskActivity.user_id, user.id),
          eq(taskActivity.action, 'status_changed'),
          sql`${taskActivity.new_value} = 'done'`,
          gte(taskActivity.created_at, weekStart),
          lt(taskActivity.created_at, weekEnd),
        ));

      pace.push({
        week: weekStart.toISOString().split('T')[0]!,
        completed: Number(weekRow?.count ?? 0),
      });
    }

    return c.json({
      activity: {
        messages_sent: messagesSent,
        tasks_completed: tasksCompleted,
        spaces_active: activeSpaces.map((s) => s.space_name),
      },
      expertise: expertise.map((e) => ({ topic: e.topic, score: e.score })),
      top_collaborators: collaborators,
      work_patterns: patterns.map((p) => ({
        type: p.pattern_type,
        data: p.pattern_data,
      })),
      pace,
    });
  } catch (err) {
    console.error('My insights error:', err);
    return c.json({ error: 'Failed to load insights', code: 'INTERNAL_ERROR' }, 500);
  }
});

// Agent activity feed — recent auto-executed and approved actions
dashboardRoutes.get('/agent-activity', async (c) => {
  const user = c.get('user');

  const recentActions = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      result: agentActions.result,
      approval_status: agentActions.approval_status,
      approval_tier: agentActions.approval_tier,
      executed_at: agentActions.executed_at,
      created_at: agentActions.created_at,
      error: agentActions.error,
      agent_employee_id: agentActions.agent_employee_id,
    })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.org_id, user.org_id),
        inArray(agentActions.approval_status, ['approved', 'pending']),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(20);

  return c.json(recentActions);
});

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
