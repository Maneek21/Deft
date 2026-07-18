import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  events,
  meetingBriefs,
  messages,
  orgs,
  orgMembers,
  projects,
  spaceMembers,
  spaces,
  tasks,
  users,
} from '@deft/db/schema';
import { db } from './db.js';
import { claimAutomationRun, failAutomationRun, updateAutomationRun } from './automation-runs.js';
import { meetingPrepRunKey } from './automation-schedule.js';
import {
  meetingPrepDraftSchema,
  parseGroundedDraft,
  renderMeetingPrepDraft,
  type MeetingPrepDraft,
} from './automation-synthesis.js';
import { runAgentQuery } from './agent-runner.js';
import { resolveReasonProvider } from './org-ai-config.js';
import { createNotificationIfAllowed } from './notification-policy.js';
import { visibleTaskCondition } from './task-visibility.js';
import { emitToUser } from '../socket.js';

type MeetingEvidence = {
  source_id: string;
  kind: 'event' | 'task' | 'message';
  text: string;
};

type Attendee = { email: string; displayName?: string };

function normalizedAttendees(metadata: unknown): Attendee[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const value = (metadata as Record<string, unknown>).attendees;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const email = (entry as Record<string, unknown>).email;
    const displayName = (entry as Record<string, unknown>).displayName;
    if (typeof email !== 'string' || !email.trim()) return [];
    return [{ email: email.trim().toLowerCase(), displayName: typeof displayName === 'string' ? displayName : undefined }];
  });
}

function fallbackMeetingDraft(evidence: MeetingEvidence[]): MeetingPrepDraft {
  const tasksOnly = evidence.filter((item) => item.kind === 'task').slice(0, 4);
  const messagesOnly = evidence.filter((item) => item.kind === 'message').slice(0, 3);
  const toItems = (items: MeetingEvidence[]) => items.map((item) => ({
    text: item.text,
    source_ids: [item.source_id],
  }));
  return {
    agenda: toItems(tasksOnly.slice(0, 3)),
    decisions: [],
    updates: toItems(messagesOnly.length > 0 ? messagesOnly : tasksOnly.slice(3, 4)),
  };
}

async function gatherMeetingEvidence(meeting: {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  timestamp: Date;
  metadata: unknown;
}) {
  const attendees = normalizedAttendees(meeting.metadata);
  const attendeeEmails = attendees.map((attendee) => attendee.email);
  const attendeeUsers = attendeeEmails.length === 0 ? [] : await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, users.id),
      eq(orgMembers.org_id, meeting.org_id),
      eq(orgMembers.is_active, true),
    ))
    .where(inArray(users.email, attendeeEmails));
  const attendeeUserIds = attendeeUsers.map((user) => user.id);

  const evidence: MeetingEvidence[] = [{
    source_id: `event:${meeting.id}`,
    kind: 'event',
    text: `${meeting.title || 'Upcoming meeting'} starts at ${meeting.timestamp.toISOString()}${attendees.length ? ` with ${attendees.map((a) => a.displayName || a.email).join(', ')}` : ''}.`,
  }];

  if (attendeeUserIds.length > 0) {
    const attendeeTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        prefix: projects.prefix,
        status: tasks.status,
        priority: tasks.priority,
        owner: users.name,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(and(
        eq(tasks.org_id, meeting.org_id),
        eq(tasks.is_deleted, false),
        visibleTaskCondition(meeting.user_id),
        inArray(tasks.assignee_id, attendeeUserIds),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ))
      .orderBy(tasks.priority, desc(tasks.updated_at))
      .limit(16);
    for (const task of attendeeTasks) {
      evidence.push({
        source_id: `task:${task.id}`,
        kind: 'task',
        text: `${task.prefix}-${task.number} ${task.title} is ${task.status.replaceAll('_', ' ')} (${task.priority})${task.owner ? ` with ${task.owner}` : ''}.`,
      });
    }

    // Only read messages from spaces the brief recipient can access, and only
    // messages authored by attendees in the same org.
    const recipientSpaces = await db.select({ space_id: spaceMembers.space_id })
      .from(spaceMembers)
      .innerJoin(spaces, and(
        eq(spaceMembers.space_id, spaces.id),
        eq(spaces.org_id, meeting.org_id),
      ))
      .where(eq(spaceMembers.user_id, meeting.user_id));
    const allowedSpaceIds = recipientSpaces.map((row) => row.space_id);
    if (allowedSpaceIds.length > 0) {
      const since = new Date(meeting.timestamp.getTime() - 48 * 60 * 60_000);
      const recentMessages = await db
        .select({
          id: messages.id,
          content: messages.content,
          author: users.name,
          space_name: spaces.name,
        })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(and(
          eq(messages.org_id, meeting.org_id),
          eq(messages.is_deleted, false),
          inArray(messages.user_id, attendeeUserIds),
          inArray(messages.space_id, allowedSpaceIds),
          gte(messages.created_at, since),
        ))
        .orderBy(desc(messages.created_at))
        .limit(12);
      for (const message of recentMessages) {
        evidence.push({
          source_id: `message:${message.id}`,
          kind: 'message',
          text: `${message.author} in #${message.space_name}: ${message.content.slice(0, 240)}`,
        });
      }
    }
  }

  if (meeting.title) {
    const words = meeting.title.split(/\s+/).map((word) => word.replace(/[^a-z0-9]/gi, ''))
      .filter((word) => word.length > 3).slice(0, 5);
    if (words.length > 0) {
      const related = await db.select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        prefix: projects.prefix,
        status: tasks.status,
        priority: tasks.priority,
      }).from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(and(
          eq(tasks.org_id, meeting.org_id),
          eq(tasks.is_deleted, false),
          visibleTaskCondition(meeting.user_id),
          sql`(${sql.join(words.map((word) => sql`lower(${tasks.title}) LIKE ${`%${word.toLowerCase()}%`}`), sql` OR `)})`,
        )).limit(10);
      const existingIds = new Set(evidence.map((item) => item.source_id));
      for (const task of related) {
        if (existingIds.has(`task:${task.id}`)) continue;
        evidence.push({
          source_id: `task:${task.id}`,
          kind: 'task',
          text: `${task.prefix}-${task.number} ${task.title} is ${task.status.replaceAll('_', ' ')} (${task.priority}).`,
        });
      }
    }
  }
  return evidence;
}

async function synthesizeMeetingPrep(
  orgId: string,
  orgName: string,
  userId: string,
  evidence: MeetingEvidence[],
) {
  const fallback = fallbackMeetingDraft(evidence);
  const provider = await resolveReasonProvider(orgId);
  if (!provider.apiKey && provider.provider !== 'ollama') {
    return { draft: fallback, generator: 'fallback' as const, model: null };
  }
  try {
    const response = await runAgentQuery({
      orgId,
      orgName,
      userId,
      mode: 'chat_mention',
      skipVerification: true,
      maxIterations: 2,
      systemPromptOverride: 'You are Defty preparing a meeting brief for this user. Use only the supplied, permission-filtered evidence. Do not infer private context, invent decisions, or call tools. Return JSON only.',
      content: `Return JSON only with keys agenda, decisions, updates. Each value is an array of {"text": string, "source_ids": string[]}. Return at most 4 items per key, keep each text under 180 characters, and cite at least one supplied source per item. Leave decisions empty when evidence does not show one is needed.\n\nEvidence:\n${JSON.stringify(evidence)}`,
    });
    return {
      draft: parseGroundedDraft(
        response.text,
        meetingPrepDraftSchema,
        new Set(evidence.map((item) => item.source_id)),
        { sectionLimits: { agenda: 4, decisions: 4, updates: 4 } },
      ),
      generator: 'agent' as const,
      model: response.model,
    };
  } catch (error) {
    console.error('[meeting-prep-automation] Grounded synthesis failed; using fallback:', error);
    return { draft: fallback, generator: 'fallback' as const, model: null };
  }
}

export async function generateMeetingPrep(eventId: string, now = new Date()) {
  const [meeting] = await db.select({
    id: events.id,
    org_id: events.org_id,
    user_id: events.user_id,
    title: events.title,
    timestamp: events.timestamp,
    metadata: events.metadata,
    org_name: orgs.name,
  }).from(events)
    .innerJoin(orgs, eq(events.org_id, orgs.id))
    .where(eq(events.id, eventId)).limit(1);
  if (!meeting?.user_id) throw new Error('Meeting or recipient not found');

  const claim = await claimAutomationRun({
    orgId: meeting.org_id,
    kind: 'meeting_prep',
    subjectId: meeting.id,
    userId: meeting.user_id,
    idempotencyKey: meetingPrepRunKey(meeting.id, meeting.timestamp),
    scheduledFor: meeting.timestamp,
    context: { event_title: meeting.title, event_timestamp: meeting.timestamp.toISOString() },
  });
  if (!claim.claimed) {
    const [existing] = await db.select().from(meetingBriefs)
      .where(and(eq(meetingBriefs.event_id, meeting.id), eq(meetingBriefs.user_id, meeting.user_id))).limit(1);
    return { brief: existing ?? null, run: claim.run, alreadyExisted: true };
  }

  try {
    await updateAutomationRun(claim.run.id, { status: 'gathering_context', startedAt: now });
    const evidence = await gatherMeetingEvidence({ ...meeting, user_id: meeting.user_id });
    const synthesis = await synthesizeMeetingPrep(meeting.org_id, meeting.org_name, meeting.user_id, evidence);
    const briefText = renderMeetingPrepDraft(meeting.title || 'Upcoming meeting', synthesis.draft);
    const [brief] = await db.insert(meetingBriefs).values({
      org_id: meeting.org_id,
      user_id: meeting.user_id,
      event_id: meeting.id,
      brief_text: briefText,
    }).onConflictDoUpdate({
      target: [meetingBriefs.event_id, meetingBriefs.user_id],
      set: { brief_text: briefText, updated_at: new Date() },
    }).returning();
    if (!brief) throw new Error('Meeting brief insert returned no row');

    const notification = await createNotificationIfAllowed({
      org_id: meeting.org_id,
      user_id: meeting.user_id,
      type: 'system',
      title: `Meeting prep: ${meeting.title || 'Upcoming meeting'}`,
      body: briefText,
      link: '/calendar',
      metadata: { event_id: meeting.id, automation_run_id: claim.run.id, generator: synthesis.generator },
    }, { channel: 'calendar' });
    if (notification) emitToUser(meeting.user_id, 'notification:new', notification);
    emitToUser(meeting.user_id, 'meeting-brief:new', {
      event_id: meeting.id,
      event_title: meeting.title,
      brief_text: briefText,
      generator: synthesis.generator,
    });

    const run = await updateAutomationRun(claim.run.id, {
      status: 'delivered',
      generator: synthesis.generator,
      output: { draft: synthesis.draft, evidence, model: synthesis.model },
      resultEntityId: brief.id,
      completedAt: new Date(),
    });
    return { brief, run, alreadyExisted: false };
  } catch (error) {
    await failAutomationRun(claim.run.id, error);
    throw error;
  }
}
