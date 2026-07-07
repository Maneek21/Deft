// Handler: generate meeting prep briefings for upcoming meetings
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { getOrgAIConfig, hasAnyAIProvider } from '../../lib/org-ai-config.js';
import {
  agentEmployees,
  events,
  meetingBriefs,
  tasks,
  messages,
  spaces,
  spaceMembers,
  users,
} from '@deft/db/schema';
import { eq, and, gte, lt, sql, desc, inArray } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { TriggerInvocation } from './employee-trigger.js';
import { createNotificationIfAllowed } from '../../lib/notification-policy.js';

const MEETING_PREP_TRIGGER_KIND = 'cron:meeting-prep';

async function findMeetingPrepEmployee(orgId: string) {
  const [row] = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        sql`${MEETING_PREP_TRIGGER_KIND} = ANY(${agentEmployees.trigger_subscriptions})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function handleMeetingPrepCheck(_job: JobData): Promise<void> {
  console.log('[meeting-prep-check] Checking for meetings starting in ~15 minutes');

  const now = new Date();
  const tenMinFromNow = new Date(now.getTime() + 10 * 60 * 1000);
  const twentyMinFromNow = new Date(now.getTime() + 20 * 60 * 1000);

  // 1. Query events table for calendar_event type starting in 10-20 minutes
  const upcomingMeetings = await db
    .select({
      id: events.id,
      title: events.title,
      user_id: events.user_id,
      org_id: events.org_id,
      timestamp: events.timestamp,
      metadata: events.metadata,
    })
    .from(events)
    .where(
      and(
        inArray(events.source, ['google_calendar', 'ics', 'native']),
        eq(events.event_type, 'calendar_event'),
        gte(events.timestamp, tenMinFromNow),
        lt(events.timestamp, twentyMinFromNow),
      ),
    );

  console.log(`[meeting-prep-check] Found ${upcomingMeetings.length} upcoming meeting(s)`);

  for (const meeting of upcomingMeetings) {
    try {
      if (!meeting.user_id || !meeting.org_id) {
        continue;
      }

      // 2a. Check if a brief already exists for this event
      const [existingBrief] = await db
        .select({ id: meetingBriefs.id })
        .from(meetingBriefs)
        .where(eq(meetingBriefs.event_id, meeting.id))
        .limit(1);

      if (existingBrief) {
        console.log(`[meeting-prep-check] Brief already exists for event ${meeting.id}, skipping`);
        continue;
      }

      // Phase 6 branch: hand off to subscribed employee if one exists.
      // The employee owns the brief generation via its own MCP envelope.
      // Existing native path below remains the fallback.
      const subscribed = await findMeetingPrepEmployee(meeting.org_id);
      if (subscribed) {
        const invocation: TriggerInvocation = {
          employee_id: subscribed.id,
          trigger_kind: MEETING_PREP_TRIGGER_KIND,
          context: {
            event_id: meeting.id,
            event_title: meeting.title,
            event_user_id: meeting.user_id,
            event_timestamp: meeting.timestamp,
            event_metadata: meeting.metadata,
          },
          goal:
            `Generate a 3-bullet meeting prep brief for the upcoming meeting "${meeting.title ?? 'untitled'}". ` +
            'Query events_query + task_query + thread_fetch via your MCP tools to gather context, ' +
            'then post the brief (or DM the attendee).',
        };
        await enqueue(
          QUEUE_NAMES.AGENT_JOBS,
          'employee-trigger',
          invocation as unknown as Record<string, unknown>,
        );
        console.log(
          `[meeting-prep-check] Routed cron:meeting-prep to ${subscribed.slug} for event ${meeting.id}`,
        );
        continue;
      }

      // 2b. Extract attendee info from event metadata
      const metadata = meeting.metadata as Record<string, any> | null;
      const attendees: { email: string; displayName?: string }[] =
        (metadata?.attendees as any[]) || [];
      const attendeeNames = attendees
        .map((a) => a.displayName || a.email?.split('@')[0] || 'Unknown')
        .filter((n): n is string => !!n);
      const attendeeEmails = attendees.map((a) => a.email).filter(Boolean);

      // 2c. Gather context

      // Find users in our system that match attendee emails
      let attendeeUsers: { id: string; name: string; email: string | null }[] = [];
      if (attendeeEmails.length > 0) {
        attendeeUsers = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.email, attendeeEmails));
      }

      const attendeeUserIds = attendeeUsers.map((u) => u.id);

      // Tasks assigned to attendees (open tasks)
      let attendeeTasks: { title: string; status: string; priority: string; assignee_name: string }[] = [];
      if (attendeeUserIds.length > 0) {
        attendeeTasks = await db
          .select({
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            assignee_name: users.name,
          })
          .from(tasks)
          .innerJoin(users, eq(tasks.assignee_id, users.id))
          .where(
            and(
              eq(tasks.org_id, meeting.org_id),
              eq(tasks.is_deleted, false),
              inArray(tasks.assignee_id, attendeeUserIds),
              sql`${tasks.status} NOT IN ('done', 'cancelled')`,
            ),
          )
          .limit(20);
      }

      // Recent messages in spaces those users are in (last 24h)
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      let recentMessages: { content: string; user_name: string; space_name: string }[] = [];
      if (attendeeUserIds.length > 0) {
        // Get spaces the attendees are in
        const attendeeSpaces = await db
          .select({ space_id: spaceMembers.space_id })
          .from(spaceMembers)
          .where(inArray(spaceMembers.user_id, attendeeUserIds));

        const spaceIds = [...new Set(attendeeSpaces.map((s) => s.space_id))];

        if (spaceIds.length > 0) {
          recentMessages = await db
            .select({
              content: messages.content,
              user_name: users.name,
              space_name: spaces.name,
            })
            .from(messages)
            .innerJoin(users, eq(messages.user_id, users.id))
            .innerJoin(spaces, eq(messages.space_id, spaces.id))
            .where(
              and(
                eq(messages.org_id, meeting.org_id),
                eq(messages.is_deleted, false),
                inArray(messages.space_id, spaceIds),
                gte(messages.created_at, yesterday),
              ),
            )
            .orderBy(desc(messages.created_at))
            .limit(15);
        }
      }

      // Tasks mentioned in event title (simple keyword search)
      let relatedTasks: { title: string; status: string; priority: string }[] = [];
      if (meeting.title) {
        const titleWords = meeting.title
          .split(/\s+/)
          .filter((w: string) => w.length > 3)
          .slice(0, 5);

        if (titleWords.length > 0) {
          const likeConditions = titleWords.map(
            (word: string) => sql`lower(${tasks.title}) LIKE lower(${'%' + word + '%'})`,
          );
          relatedTasks = await db
            .select({
              title: tasks.title,
              status: tasks.status,
              priority: tasks.priority,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.org_id, meeting.org_id),
                eq(tasks.is_deleted, false),
                sql`(${sql.join(likeConditions, sql` OR `)})`,
              ),
            )
            .limit(10);
        }
      }

      // 2d. Build context string
      const contextParts: string[] = [];

      if (attendeeNames.length > 0) {
        contextParts.push(`Attendees: ${attendeeNames.join(', ')}`);
      }

      if (attendeeTasks.length > 0) {
        const taskLines = attendeeTasks
          .map((t) => `- [${t.priority.toUpperCase()}] ${t.title} (${t.status}, assigned to ${t.assignee_name})`)
          .join('\n');
        contextParts.push(`Open tasks for attendees:\n${taskLines}`);
      }

      if (relatedTasks.length > 0) {
        const taskLines = relatedTasks
          .map((t) => `- [${t.priority.toUpperCase()}] ${t.title} (${t.status})`)
          .join('\n');
        contextParts.push(`Tasks related to meeting topic:\n${taskLines}`);
      }

      if (recentMessages.length > 0) {
        const msgLines = recentMessages
          .slice(0, 8)
          .map((m) => `- ${m.user_name} in #${m.space_name}: ${(m.content || '').slice(0, 100)}`)
          .join('\n');
        contextParts.push(`Recent messages from attendees:\n${msgLines}`);
      }

      const contextStr = contextParts.join('\n\n');

      // 2e. Generate brief
      let briefText: string;

      if (await hasAnyAIProvider(meeting.org_id)) {
        try {
          const { llm } = await import('../../lib/llm.js');
          const orgConfig = await getOrgAIConfig(meeting.org_id);

          const response = await llm({
            task: 'summarize',
            messages: [
              {
                role: 'user',
                content: `Generate a 3-bullet meeting prep brief for: ${meeting.title}. Context: ${contextStr}. Focus on: what to discuss, decisions needed, updates to share. Keep each bullet to 1-2 sentences.`,
              },
            ],
            maxTokens: 300,
            orgConfig,
          });

          briefText = response.text || generateFallbackBrief(meeting.title, attendeeNames, attendeeTasks, relatedTasks);
        } catch (err) {
          console.error(`[meeting-prep-check] LLM API error for event ${meeting.id}:`, err);
          briefText = generateFallbackBrief(meeting.title, attendeeNames, attendeeTasks, relatedTasks);
        }
      } else {
        briefText = generateFallbackBrief(meeting.title, attendeeNames, attendeeTasks, relatedTasks);
      }

      // 2f. Insert into meetingBriefs table
      await db.insert(meetingBriefs).values({
        org_id: meeting.org_id,
        user_id: meeting.user_id,
        event_id: meeting.id,
        brief_text: briefText,
      });

      // 2g. Create notification
      const notification = await createNotificationIfAllowed({
        org_id: meeting.org_id,
        user_id: meeting.user_id,
        type: 'system',
        title: `Meeting prep: ${meeting.title}`,
        body: briefText,
        link: `/dashboard`,
        metadata: { event_id: meeting.id },
      }, { channel: 'calendar' });

      // 2h. Emit via socket
      if (notification) {
        emitToUser(meeting.user_id, 'notification:new', notification);
      }

      emitToUser(meeting.user_id, 'meeting-brief:new', {
        event_id: meeting.id,
        event_title: meeting.title,
        brief_text: briefText,
      });

      console.log(`[meeting-prep-check] Generated brief for "${meeting.title}" (event ${meeting.id})`);
    } catch (err) {
      console.error(`[meeting-prep-check] Error processing event ${meeting.id}:`, err);
      // Continue to next meeting
    }
  }
}

/**
 * Generate a simple meeting prep brief when no AI is available.
 */
function generateFallbackBrief(
  title: string | null,
  attendeeNames: string[],
  attendeeTasks: { title: string; status: string; priority: string }[],
  relatedTasks: { title: string; status: string; priority: string }[],
): string {
  const lines: string[] = [];

  lines.push(`**Meeting Prep: ${title || 'Upcoming Meeting'}**`);
  lines.push('');

  if (attendeeNames.length > 0) {
    lines.push(`- **Attendees:** ${attendeeNames.join(', ')}`);
  }

  const highPriority = [...attendeeTasks, ...relatedTasks].filter(
    (t) => t.priority === 'p0' || t.priority === 'p1',
  );
  if (highPriority.length > 0) {
    lines.push(
      `- **Key items to discuss:** ${highPriority.slice(0, 3).map((t) => t.title).join(', ')}`,
    );
  } else if (relatedTasks.length > 0) {
    lines.push(
      `- **Related tasks:** ${relatedTasks.slice(0, 3).map((t) => t.title).join(', ')}`,
    );
  } else {
    lines.push('- Review agenda and prepare any updates to share with the group.');
  }

  if (attendeeTasks.length > 0) {
    const inProgress = attendeeTasks.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 0) {
      lines.push(
        `- **In-progress work:** ${inProgress.slice(0, 3).map((t) => t.title).join(', ')}`,
      );
    }
  }

  if (lines.length <= 2) {
    lines.push('- No specific context gathered. Check the meeting invite for agenda details.');
  }

  return lines.join('\n');
}
