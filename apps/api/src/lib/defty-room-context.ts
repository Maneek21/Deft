import { and, asc, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { messages, orgMembers, projects, projectSpaces, spaceMembers, spaces, tasks, users } from '@deft/db/schema';
import { db } from './db.js';
import { toPlainText } from './plain-text.js';
import { visibleTaskCondition } from './task-visibility.js';
import { deftyMessageCitation, type DeftyMessageCitation } from './defty-message-source.js';

const MAX_MESSAGES = 30;
const MAX_BODY_CHARS = 400;
const MAX_PACK_CHARS = 12_000;

type ContextMessage = {
  id: string;
  author: string;
  content: string;
  createdAt: Date;
  parentId: string | null;
  replyCount: number;
};

type ContextProject = { id: string; name: string; prefix: string; linked: boolean };
type ContextTask = { key: string; title: string; status: string; assignee: string | null };

export type RoomContextPack = {
  spaceId: string;
  triggerTime: Date;
  people: string[];
  projects: ContextProject[];
  tasks: ContextTask[];
  messages: ContextMessage[];
  thread: ContextMessage[];
};

export type RoomContextWithSources = { content: string; citations: DeftyMessageCitation[] };

function relativeTime(time: Date, reference: Date): string {
  const minutes = Math.max(0, Math.floor((reference.getTime() - time.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function messageLine(message: ContextMessage, input: RoomContextPack): string {
  const time = relativeTime(message.createdAt, input.triggerTime);
  const source = `/chat?space=${encodeURIComponent(input.spaceId)}&message=${encodeURIComponent(message.id)}`;
  const body = toPlainText(message.content).replace(/\s+/g, ' ').slice(0, MAX_BODY_CHARS);
  return `- [${message.author}, ${time}](${source}) (${message.replyCount} replies): ${body}`;
}

/** The returned text is workspace data: callers must place it in untrusted user context. */
export function formatRoomContextPack(input: RoomContextPack): string {
  return formatRoomContextPackWithSources(input).content;
}

export function formatRoomContextPackWithSources(input: RoomContextPack): RoomContextWithSources {
  const lines = ['Conversation in this channel (as of the triggering message):'];
  const add = (line: string, reserve = 0) => {
    if (lines.join('\n').length + line.length + 1 <= MAX_PACK_CHARS - reserve) lines.push(line);
  };
  // Whole items are retained so task titles are never silently paraphrased or clipped.
  const people: string[] = [];
  for (const person of input.people) {
    if (people.join(', ').length + person.length > 1500) break;
    people.push(person);
  }
  add(`People in this channel: ${people.join(', ') || 'No active members listed'}.`);
  const projectLabels: string[] = [];
  for (const project of input.projects) {
    const single = input.projects.length === 1 ? '; single accessible project' : '';
    const label = `${project.name} (${project.prefix}${project.linked ? '; linked to this channel' : ''}${single})`;
    if (projectLabels.join(', ').length + label.length > 2000) break;
    projectLabels.push(label);
  }
  add(`Projects: ${projectLabels.join(', ') || 'No active projects'}.`);
  for (const task of input.tasks) {
    add(`Task: ${task.key} "${task.title}"; status: ${task.status}; assignee: ${task.assignee ?? 'Unassigned'}.`, 4500);
  }

  const threadIds = new Set(input.thread.map(message => message.id));
  const threadRootCount = input.thread.filter(message => message.parentId === null).length;
  const entry = (message: ContextMessage) => ({ line: messageLine(message, input),
    citation: deftyMessageCitation({ ...message, spaceId: input.spaceId }) });
  const channelEntries = input.messages.filter(message => !threadIds.has(message.id))
    .slice(-(MAX_MESSAGES - threadRootCount)).map(entry);
  const threadEntries = input.thread.map(entry);
  const remaining = MAX_PACK_CHARS - lines.join('\n').length - 1;
  const sections = () => [
    ...(channelEntries.length ? ['Recent channel messages:', ...channelEntries.map(item => item.line)] : []),
    ...(threadEntries.length ? ['Current thread:', ...threadEntries.map(item => item.line)] : []),
  ];
  // Prefer the thread and the most recent discussion when a busy room exhausts the budget.
  while (sections().join('\n').length > remaining && channelEntries.length) channelEntries.shift();
  while (sections().join('\n').length > remaining && threadEntries.length) threadEntries.shift();
  for (const line of sections()) add(line);
  return { content: lines.join('\n'), citations: [...channelEntries, ...threadEntries].map(item => item.citation) };
}

type RoomContextInput = {
  orgId: string;
  spaceId: string;
  threadParentId: string | null;
  triggerMessageId: string;
  requesterId: string;
};

export async function buildRoomContextPack(input: RoomContextInput): Promise<string | null> {
  return (await buildRoomContextPackWithSources(input))?.content ?? null;
}

export async function buildRoomContextPackWithSources(input: RoomContextInput): Promise<RoomContextWithSources | null> {
  // Match the native message read boundary rather than using the agent's broader membership.
  const [space] = await db.select({ id: spaces.id }).from(spaces)
    .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, input.requesterId)))
    .innerJoin(orgMembers, and(eq(orgMembers.org_id, spaces.org_id), eq(orgMembers.user_id, input.requesterId), eq(orgMembers.is_active, true)))
    .where(and(eq(spaces.org_id, input.orgId), eq(spaces.id, input.spaceId), eq(spaces.is_archived, false))).limit(1);
  if (!space) return null;

  const [trigger] = await db.select({ id: messages.id, createdAt: messages.created_at, parentId: messages.parent_id })
    .from(messages).where(and(eq(messages.id, input.triggerMessageId), eq(messages.org_id, input.orgId),
      eq(messages.space_id, input.spaceId), eq(messages.is_deleted, false))).limit(1);
  if (!trigger || trigger.parentId !== input.threadParentId) return null;
  const beforeTrigger = or(lt(messages.created_at, trigger.createdAt),
    and(eq(messages.created_at, trigger.createdAt), lt(messages.id, trigger.id)));
  const atOrBeforeTrigger = or(beforeTrigger, eq(messages.id, trigger.id));
  const selection = { id: messages.id, author: users.name, content: messages.content,
    createdAt: messages.created_at, parentId: messages.parent_id };
  const common = and(eq(messages.org_id, input.orgId), eq(messages.space_id, input.spaceId), eq(messages.is_deleted, false));

  const [recent, thread, people, activeProjects, linkedProjects] = await Promise.all([
    db.select(selection).from(messages).innerJoin(users, eq(users.id, messages.user_id))
      .where(and(common, isNull(messages.parent_id), beforeTrigger))
      .orderBy(desc(messages.created_at), desc(messages.id)).limit(MAX_MESSAGES),
    input.threadParentId ? db.select(selection).from(messages).innerJoin(users, eq(users.id, messages.user_id))
      .where(and(common, or(eq(messages.id, input.threadParentId), eq(messages.parent_id, input.threadParentId)), atOrBeforeTrigger))
      .orderBy(asc(messages.created_at), asc(messages.id)) : Promise.resolve([]),
    db.select({ name: users.name }).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.user_id))
      .innerJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, input.orgId), eq(orgMembers.is_active, true)))
      .where(eq(spaceMembers.space_id, input.spaceId)).orderBy(asc(users.name)),
    // Projects have org-wide read visibility in the native project routes.
    db.select({ id: projects.id, name: projects.name, prefix: projects.prefix }).from(projects)
      .where(and(eq(projects.org_id, input.orgId), eq(projects.is_deleted, false), eq(projects.is_archived, false)))
      .orderBy(asc(projects.name)),
    db.select({ id: projectSpaces.project_id }).from(projectSpaces)
      .innerJoin(projects, and(eq(projects.id, projectSpaces.project_id), eq(projects.org_id, input.orgId)))
      .where(eq(projectSpaces.space_id, input.spaceId)),
  ]);
  const chronological = recent.reverse();
  const window = [...chronological, ...thread];
  const windowIds = [...new Set(window.map(message => message.id))];
  const replyCounts = windowIds.length ? await db.select({ id: messages.parent_id, count: count() })
    .from(messages).where(and(common, inArray(messages.parent_id, windowIds), atOrBeforeTrigger))
    .groupBy(messages.parent_id) : [];
  const counts = new Map(replyCounts.map(row => [row.id, row.count]));
  const keys = [...new Set(window.flatMap(message =>
    [...toPlainText(message.content).slice(0, MAX_BODY_CHARS).matchAll(/\b([A-Z][A-Z0-9]*)-(\d+)\b/gi)]
      .flatMap(match => {
        const number = Number(match[2]);
        return Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647
          ? [`${match[1]!.toUpperCase()}-${number}`] : [];
      })))];
  const mentionedTasks = keys.length ? await db.select({ keyPrefix: projects.prefix, number: tasks.number,
    title: tasks.title, status: tasks.status, assigneeId: tasks.assignee_id }).from(tasks)
    .innerJoin(projects, and(eq(projects.id, tasks.project_id), eq(projects.org_id, input.orgId)))
    .where(and(eq(tasks.org_id, input.orgId), eq(tasks.is_deleted, false), eq(projects.is_deleted, false),
      eq(projects.is_archived, false), visibleTaskCondition(input.requesterId),
      or(...keys.map(key => {
        const separator = key.lastIndexOf('-');
        return and(eq(projects.prefix, key.slice(0, separator)), eq(tasks.number, Number(key.slice(separator + 1))));
      })))) : [];
  const assigneeIds = [...new Set(mentionedTasks.flatMap(task => task.assigneeId ? [task.assigneeId] : []))];
  const assignees = assigneeIds.length ? await db.select({ id: users.id, name: users.name }).from(users)
    .innerJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, input.orgId), eq(orgMembers.is_active, true)))
    .where(inArray(users.id, assigneeIds)) : [];
  const assigneeNames = new Map(assignees.map(person => [person.id, person.name]));
  const linkedIds = new Set(linkedProjects.map(project => project.id));
  return formatRoomContextPackWithSources({ spaceId: input.spaceId, triggerTime: trigger.createdAt,
    people: people.map(person => person.name),
    projects: activeProjects.map(project => ({ ...project, linked: linkedIds.has(project.id) })),
    tasks: mentionedTasks.map(task => ({ key: `${task.keyPrefix}-${task.number}`, title: task.title,
      status: task.status, assignee: task.assigneeId ? assigneeNames.get(task.assigneeId) ?? null : null })),
    messages: chronological.map(message => ({ ...message, replyCount: counts.get(message.id) ?? 0 })),
    thread: thread.map(message => ({ ...message, replyCount: counts.get(message.id) ?? 0 })),
  });
}

