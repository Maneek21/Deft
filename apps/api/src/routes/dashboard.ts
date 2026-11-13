import {visibleCaptureActionSql} from '../lib/agent-action-visibility.js';
import { Hono } from 'hono';
import { eq, and, desc, sql, lt, gte, inArray, count } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tasks, taskAssignees, projects, users, spaces, spaceMembers, messages, taskActivity, notifications, events, standups, peopleExpertise, peopleInteractions, peoplePatterns, agentActions, agentEmployees, wikiPages } from '@deft/db/schema';
import { generateDailyStandup, standupReadableBy } from '../lib/standup-automation.js';
import { visibleModuleActionSql } from '../lib/module-action-visibility.js';
import { viewerReviewAuthority } from '../lib/agent-approval-resolver.js';
import {readEmailCalendarOccurrences} from '../lib/email-calendar-projection.js';
import { getDayBoundaries, resolveViewerTimezone } from '../lib/task-dates.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';

/** Full workspace members; guests and unresolved roles are excluded from org-wide standups. */
function isWorkspaceMember(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

export const dashboardRoutes = new Hono();

// GET /api/dashboard — all dashboard data in one call
dashboardRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const now = new Date();
    // Day buckets are calendar-day questions in the *viewer's* timezone, not
    // the server's. Resolve ?tz= (validated) → profile tz → org tz → UTC.
    const viewerTz = await resolveViewerTimezone({
      requestedTz: c.req.query('tz'),
      userId: user.id,
      orgId: user.org_id,
    });
    const { start: todayStart, end: todayEnd } = getDayBoundaries(viewerTz, 0, now);
    const { start: weekEnd } = getDayBoundaries(viewerTz, 7, now);

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
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
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
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
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
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
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
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
      ))
      .orderBy(tasks.priority);

    // 4b. My Work — all non-terminal tasks where caller is the primary
    //     assignee OR listed as an additional assignee (Phase 0.3). This is
    //     the source-of-truth aggregation for the dashboard kanban.
    const myWork = await db.select({
      id: tasks.id, number: tasks.number, title: tasks.title,
      status: tasks.status, priority: tasks.priority, due_date: tasks.due_date,
      updated_at: tasks.updated_at, assignee_id: tasks.assignee_id,
      project_name: projects.name, project_prefix: projects.prefix, project_color: projects.color,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.org_id, user.org_id),
        eq(tasks.is_deleted, false),
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
        sql`(${tasks.assignee_id} = ${user.id} OR ${tasks.id} IN (SELECT ${taskAssignees.task_id} FROM ${taskAssignees} WHERE ${taskAssignees.user_id} = ${user.id}))`,
      ))
      .orderBy(tasks.priority, tasks.due_date);

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
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(
        eq(tasks.org_id, user.org_id),
        eq(tasks.is_deleted, false),
        eq(projects.is_deleted, false),
        eq(projects.is_archived, false),
        visibleTaskCondition(user.id),
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
          .where(and(
            inArray(tasks.id, actTaskIds),
            eq(projects.is_deleted, false),
            eq(projects.is_archived, false),
          ))
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
        eq(projects.is_deleted, false),
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
      .where(and(eq(notifications.org_id, user.org_id), eq(notifications.user_id, user.id), eq(notifications.is_read, false)));

    // 8b. Recent/pending agent activity for the cockpit surface. This keeps
    // the dashboard useful even when the frontend only renders a subset.
    const recentAgentActivity = await db.select({
      id: agentActions.id,
      action: agentActions.action,
      source: agentActions.source,
      approval_tier: agentActions.approval_tier,
      approval_status: agentActions.approval_status,
      created_at: agentActions.created_at,
      executed_at: agentActions.executed_at,
      error: agentActions.error,
      source_space_id: sql<string | null>`COALESCE(${agentActions.params}->>'source_space_id',${agentActions.params}->>'origin_space_id',${agentActions.params}->>'space_id')`,
      source_message_id: sql<string | null>`${agentActions.params}->>'source_message_id'`,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
    })
      .from(agentActions)
      .leftJoin(agentEmployees, eq(agentActions.agent_employee_id, agentEmployees.id))
      .where(and(
        eq(agentActions.org_id, user.org_id),
        visibleCaptureActionSql(user),
        visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(12)
      .then((rows) => withViewerCanReview(user, rows));

    const recentDecisions = await db.select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      summary: wikiPages.summary,
      updated_at: wikiPages.updated_at,
    })
      .from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.is_deleted, false),
        eq(wikiPages.type, 'decision'),
      ))
      .orderBy(desc(wikiPages.updated_at))
      .limit(5);

    // 9. Today's standup
    // The org standup is withheld from guests, matching POST /standup (S4-e).
    let standup: { summary: string; date: string; generator?: string; model?: string | null } | null = null;
    if (isWorkspaceMember(user.role)) {
      try {
        const [todayStandup] = await db
          .select({ summary: standups.summary, date: standups.date, raw_data: standups.raw_data, generated_by: standups.generated_by })
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

        if (todayStandup && standupReadableBy(todayStandup, user)) {
          const rawData = todayStandup.raw_data as Record<string, unknown> | null;
          standup = {
            summary: todayStandup.summary,
            date: todayStandup.date.toISOString(),
            generator: typeof rawData?.generator === 'string' ? rawData.generator : undefined,
            model: typeof rawData?.model === 'string' ? rawData.model : null,
          };
        }
      } catch {}
    }

    // 10. Calendar events for today. Includes native events, imported ICS
    // feeds, and legacy Google calendar rows.
    let calendarEvents: any[] = [];
    try {
      calendarEvents = await db.select({
        id: events.id, title: events.title, url: events.url,
        timestamp: events.timestamp, metadata: events.metadata,
      })
        .from(events)
        .where(and(
          eq(events.org_id, user.org_id),
          eq(events.user_id, user.id),
          inArray(events.source, ['native', 'ics', 'google_calendar']),
          eq(events.event_type, 'calendar_event'),
          gte(events.timestamp, todayStart),
          lt(events.timestamp, todayEnd),
          sql`${events.metadata}->'email_invitation'->>'schema_version' IS DISTINCT FROM 'deft.email_calendar_event.v1'`,
        ))
        .orderBy(events.timestamp)
        .limit(10);
      const invitationOccurrences=await readEmailCalendarOccurrences(db,{org_id:user.org_id,owner_user_id:user.id,from:todayStart,to:todayEnd});
      calendarEvents=[...calendarEvents,...invitationOccurrences].sort((a,b)=>new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime()).slice(0,10);
    } catch {}

    const pendingAgentActions = recentAgentActivity.filter((a) => a.viewer_can_review);
    // Rejection and expiry reasons share error; only executed approved actions can fail execution.
    const failedAgentActions = recentAgentActivity.filter((a) => a.approval_status === 'approved' && a.executed_at !== null && a.error);
    const attention = [
      ...overdue.slice(0, 5).map((task) => ({
        kind: 'overdue_task',
        severity: task.priority === 'p0' || task.priority === 'p1' ? 'critical' : 'warning',
        title: task.title,
        href: `/tasks?task=${task.project_prefix}-${task.number}`,
        task_id: task.id,
        project_name: task.project_name,
        due_date: task.due_date,
        at: task.due_date,
      })),
      ...pendingAgentActions.slice(0, 5).map((action) => ({
        kind: 'agent_approval',
        severity: action.approval_tier === 'full' ? 'critical' : 'warning',
        title: `${action.employee_name || 'Agent'} needs approval: ${action.action}`,
        href: '/inbox?tab=approvals',
        action_id: action.id,
        employee_slug: action.employee_slug,
        created_at: action.created_at,
        at: action.created_at,
      })),
      ...failedAgentActions.slice(0, 3).map((action) => ({
        kind: 'agent_error',
        severity: 'critical',
        title: `${action.employee_name || 'Agent'} action failed: ${action.action}`,
        ...(action.source === 'defty_capture' && action.source_space_id ? {href:`/chat?space=${encodeURIComponent(action.source_space_id)}${action.source_message_id?`&message=${encodeURIComponent(action.source_message_id)}`:''}`} : {}),
        action_id: action.id,
        employee_slug: action.employee_slug,
        error: action.error,
        at: action.executed_at ?? action.created_at,
      })),
      ...recentDecisions.slice(0, 3).map((decision) => ({
        kind: 'recent_decision',
        severity: 'info',
        title: decision.title,
        href: decision.slug ? `/knowledge?slug=${decision.slug}` : '/knowledge',
        wiki_page_id: decision.id,
        slug: decision.slug,
        updated_at: decision.updated_at,
        at: decision.updated_at,
      })),
    ];

    return c.json({
      greeting: getGreeting(),
      date: now.toISOString(),
      standup,
      due_today: dueToday,
      due_this_week: dueThisWeek,
      overdue,
      in_progress: inProgress,
      my_work: myWork,
      unread_spaces: unreadSpaces.slice(0, 8),
      recent_activity: activity,
      projects: projectStats,
      unread_notifications: notifCount?.count || 0,
      calendar_events: calendarEvents,
      agent_activity: recentAgentActivity,
      recent_decisions: recentDecisions,
      attention,
      github_activity: [],
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
    // Guests (and callers without a resolved org role) may not generate the
    // org-wide standup; only full workspace members can trigger it.
    if (user.role !== 'owner' && user.role !== 'admin' && user.role !== 'member') {
      return c.json({ error: 'Only workspace members can generate the standup', code: 'FORBIDDEN' }, 403);
    }
    const result = await generateDailyStandup({
      orgId: user.org_id,
      requestedByUserId: user.id,
    });
    if (!result.standup) {
      return c.json({
        error: 'Standup generation is already in progress',
        code: 'AUTOMATION_IN_PROGRESS',
      }, 409);
    }
    // A standup stored without a workspace-members audience is handed only to
    // owners/admins and to the user recorded as its author.
    if (!standupReadableBy(result.standup, user)) {
      return c.json({ standup: null, already_existed: true });
    }
    const runRawData = result.standup.raw_data as Record<string, unknown> | null;
    return c.json({
      standup: {
        summary: result.standup.summary,
        date: result.standup.date.toISOString(),
        generator: runRawData?.generator ?? result.run?.generator ?? 'fallback',
        model: runRawData?.model ?? null,
      },
      already_existed: result.alreadyExisted,
    });
  } catch (err) {
    console.error('[standup] unexpected error:', err);
    return c.json({ error: 'Failed to generate standup', code: 'INTERNAL_ERROR' }, 500);
  }
});

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
        visibleCaptureActionSql(user),
        visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(20);

  return c.json(await withViewerCanReview(user, recentActions));
});

/**
 * Marks each feed row with whether the viewer can review it in the Inbox: a
 * pending approval the approve or reject route would accept from the viewer.
 */
async function withViewerCanReview<T extends { id: string; approval_status: string; approval_tier: string }>(
  user: { id: string; org_id: string; role?: string },
  rows: T[],
): Promise<Array<T & { viewer_can_review: boolean }>> {
  const awaiting = (row: T) => row.approval_status === 'pending' && row.approval_tier !== 'auto';
  const authority = await viewerReviewAuthority(user, rows.filter(awaiting).map((row) => row.id));
  return rows.map((row) => {
    const flags = authority.get(row.id);
    // A flag that is absent leaves its control in place, as on the Inbox card.
    const canReview = awaiting(row) && (!flags || flags.viewer_can_approve !== false || flags.viewer_can_reject);
    return { ...row, viewer_can_review: canReview };
  });
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
