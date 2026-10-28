import { and, desc, eq, lte, ne, or, sql } from 'drizzle-orm';
import { messages, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from './db.js';
import { DEFTY_EMAIL } from './defty-identity.js';
import { parseMentions } from './mentions.js';
import { toPlainText } from './plain-text.js';

const THREAD_FOLLOW_WINDOW_MS = 30 * 60 * 1000;
const THREAD_SPACE_TYPES = new Set(['public', 'private', 'group_dm']);

export interface ThreadFollowInput {
  orgId: string;
  spaceId: string;
  triggerMessageId: string;
  spaceType: string;
  parentId: string | null;
  authorId: string;
  content: string;
  mentionsHuman: boolean;
}

export interface ThreadFollowContext {
  deftyUserId: string;
  authorIsHuman: boolean;
  latest: { userId: string; createdAt: Date } | null;
  pending: { requesterId: string; createdAt: Date; resolvedAt: unknown } | null;
  participantFirstNames?: string[];
}

interface ThreadFollowDependencies {
  loadContext: (input: ThreadFollowInput) => Promise<ThreadFollowContext | null>;
  now: () => Date;
}

function isRecent(createdAt: Date, now: Date): boolean {
  const age = now.getTime() - createdAt.getTime();
  return Number.isFinite(age) && age >= 0 && age < THREAD_FOLLOW_WINDOW_MS;
}

/** Continue a human's turn only while Defty is directly engaged or awaiting their answer. */
export async function shouldFollowThread(
  input: ThreadFollowInput,
  dependencies: Partial<ThreadFollowDependencies> = {},
): Promise<boolean> {
  if (!input.parentId || !THREAD_SPACE_TYPES.has(input.spaceType) || input.mentionsHuman) return false;
  const context = await (dependencies.loadContext ?? loadThreadFollowContext)(input);
  if (!context || !context.authorIsHuman || context.deftyUserId === input.authorId) return false;
  // A reply addressed to a different employee belongs to that participant.
  if (parseMentions(input.content).userIds.some(id => id !== context.deftyUserId)) return false;
  const addressedName = toPlainText(input.content).match(/^([^\s,:]+)\s*[:,]/u)?.[1]?.toLowerCase();
  if (addressedName && context.participantFirstNames?.some(name => name.toLowerCase() === addressedName)) return false;
  const now = (dependencies.now ?? (() => new Date()))();
  if (context.latest?.userId === context.deftyUserId && isRecent(context.latest.createdAt, now)) return true;
  return Boolean(context.pending && !context.pending.resolvedAt
    && context.pending.requesterId === input.authorId && isRecent(context.pending.createdAt, now));
}

async function loadThreadFollowContext(input: ThreadFollowInput): Promise<ThreadFollowContext | null> {
  if (!input.parentId) return null;
  // The just-inserted trigger is also the cutoff. Reading a whole thread after
  // insertion would mistake that human message for the newest prior message.
  const [[trigger], [parent], [defty]] = await Promise.all([
    db.select({ createdAt: messages.created_at, kind: users.kind, isAgent: users.is_agent, spaceType: spaces.type })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .innerJoin(spaces, and(eq(spaces.id, messages.space_id), eq(spaces.org_id, input.orgId)))
      .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, input.authorId)))
      .where(and(eq(messages.id, input.triggerMessageId), eq(messages.org_id, input.orgId),
        eq(messages.space_id, input.spaceId), eq(messages.user_id, input.authorId),
        eq(messages.parent_id, input.parentId), eq(messages.is_deleted, false)))
      .limit(1),
    db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, input.parentId), eq(messages.org_id, input.orgId),
        eq(messages.space_id, input.spaceId), eq(messages.is_deleted, false))).limit(1),
    db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1),
  ]);
  if (!trigger || !parent || !defty || trigger.spaceType !== input.spaceType) return null;

  const threadScope = and(eq(messages.org_id, input.orgId), eq(messages.space_id, input.spaceId),
    eq(messages.is_deleted, false), lte(messages.created_at, trigger.createdAt),
    ne(messages.id, input.triggerMessageId),
    or(eq(messages.id, input.parentId), eq(messages.parent_id, input.parentId)));
  const [[latest], [pendingMessage], participants] = await Promise.all([
    db.select({ userId: messages.user_id, createdAt: messages.created_at }).from(messages)
      .where(threadScope).orderBy(desc(messages.created_at), desc(messages.id)).limit(1),
    db.select({ metadata: messages.metadata }).from(messages)
      .where(and(threadScope, eq(messages.user_id, defty.id),
        sql`${messages.metadata}->'defty_pending'->>'kind' = 'action_draft'`))
      .orderBy(desc(messages.created_at), desc(messages.id)).limit(1),
    db.selectDistinct({ name: users.name }).from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(and(threadScope, ne(users.id, input.authorId), ne(users.id, defty.id))),
  ]);

  const metadata = pendingMessage?.metadata as Record<string, unknown> | undefined;
  const draft = metadata?.defty_pending as Record<string, unknown> | undefined;
  let pending: ThreadFollowContext['pending'] = null;
  if (draft && typeof draft.request_message_id === 'string' && typeof draft.created_at === 'string') {
    const [request] = await db.select({ userId: messages.user_id }).from(messages)
      .where(and(eq(messages.id, draft.request_message_id), eq(messages.org_id, input.orgId),
        eq(messages.space_id, input.spaceId), eq(messages.is_deleted, false))).limit(1);
    if (request) pending = { requesterId: request.userId, createdAt: new Date(draft.created_at),
      resolvedAt: metadata?.defty_pending_resolved_at };
  }
  return { deftyUserId: defty.id, authorIsHuman: trigger.kind === 'human' && !trigger.isAgent,
    latest: latest ?? null, pending, participantFirstNames: participants.flatMap(({ name }) => {
      const firstName = name?.trim().split(/\s+/)[0];
      return firstName ? [firstName] : [];
    }) };
}
